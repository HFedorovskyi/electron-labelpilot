use super::*;
use crate::native_ui::NativeUiRuntime;
use crate::runtime_events::NativeRuntimeEvent;
use rusqlite::Connection;
use std::io::Read;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Condvar, Weak};
use std::thread;
use std::time::Duration as WallDuration;

struct TestDir(PathBuf);
impl Drop for TestDir {
    fn drop(&mut self) {
        assert!(self.0.starts_with(std::env::temp_dir()));
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    service: NativePrintService,
    persisted: PersistedState,
    operational: OperationalState,
    session: SessionState,
    printer: PrinterTransportState,
    directory: TestDir,
}

impl Fixture {
    fn new(port: u16, box_limit: i64) -> Self {
        let directory =
            TestDir(std::env::temp_dir().join(format!("lp-pipeline-{}", Uuid::new_v4())));
        fs::create_dir(&directory.0).unwrap();
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        persisted
            .save_identity(&json!({"station_uuid":"pipeline","station_number":"07"}))
            .unwrap();
        persisted
            .save_printer_config(json!({"packPrinter":device(port),"boxPrinter":device(port)}))
            .unwrap();
        let connection = crate::processor::open_database(&persisted).unwrap();
        connection
            .execute(
                "INSERT INTO labels(id,name,structure) VALUES(1,'Pack',?1),(2,'Box',?2)",
                [document("PACK").to_string(), document("BOX").to_string()],
            )
            .unwrap();
        connection.execute_batch(r#"
            INSERT INTO station(uuid,number,name) VALUES('pipeline',7,'Pipeline');
            INSERT INTO operators(uuid,full_name,short_code) VALUES('op-a','Operator A','A'),('op-b','Operator B','B');
            INSERT INTO container(id,name,weight) VALUES(1,'Tray',100),(2,'Box',500);
            INSERT INTO nomenclature(id,name,article,exp_date,portion_container_id,box_container_id,
                templates_pack_label,templates_box_label,close_box_counter,is_fixed_weight,fixed_weight_grams)
            VALUES(1,'Before','3002',10,1,2,1,2,99,1,1100);
        "#).unwrap();
        connection
            .execute(
                "UPDATE nomenclature SET close_box_counter=?1 WHERE id=1",
                [box_limit],
            )
            .unwrap();
        drop(connection);
        let operational = OperationalState::new(&persisted).unwrap();
        let session = SessionState::new(directory.0.clone());
        assert_eq!(session.set(&operational, "op-a", "").unwrap()["ok"], true);
        let printer = PrinterTransportState::with_database(&persisted.database_path()).unwrap();
        let service = NativePrintService::new(directory.0.clone());
        Self {
            service,
            persisted,
            operational,
            session,
            printer,
            directory,
        }
    }

    fn connection(&self) -> Connection {
        Connection::open(self.persisted.database_path()).unwrap()
    }
    fn scalar(&self, sql: &str) -> i64 {
        self.connection()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }
    fn batch(
        &self,
        copies: i64,
        events: &RuntimeEventSink,
        cancel: &dyn Fn() -> bool,
    ) -> Result<NativeFixedBatchOutcome, String> {
        self.service.print_fixed_weight_batch(
            &self.persisted,
            &self.operational,
            &self.session,
            &self.printer,
            events,
            1,
            copies,
            "BATCH-1".to_owned(),
            "07.09.2026".to_owned(),
            cancel,
        )
    }
    fn snapshot(&self) -> PackSnapshot {
        self.service
            .capture_pack_snapshot(&self.persisted, &self.operational, &self.session, request())
            .unwrap()
    }
    fn external_pack(&self, index: usize) {
        self.operational
            .record_pack_with_outbox(
                RecordPackPayload {
                    number: format!("07{index:06}"),
                    box_number: "07000001".to_owned(),
                    nomenclature_id: 1,
                    weight_netto: 1.0,
                    weight_brutto: 1.1,
                    barcode_value: String::new(),
                    station_number: Some("07".to_owned()),
                    production_date: Some("2026-09-07".to_owned()),
                    expiration_date: Some("2026-09-17".to_owned()),
                    batch: Some("EXTERNAL".to_owned()),
                    barcode_spec: None,
                },
                None,
                |_, _| Ok(()),
            )
            .unwrap();
    }
}

fn request() -> PackPrintRequest {
    PackPrintRequest {
        product_id: 1,
        gross_weight_kg: 1.1,
        batch_number: "BATCH-1".to_owned(),
        production_date: "07.09.2026".to_owned(),
    }
}
fn device(port: u16) -> Value {
    json!({"id":"pipeline","active":true,"name":"Loopback test sink","connection":"tcp",
        "protocol":"zpl","ip":"127.0.0.1","port":port,"dpi":203,
        "compatibilityMode":"compatible","persistentConnection":true,"tcpJobBoundary":"stream"})
}
fn sink_port(persisted: &PersistedState) -> u16 {
    persisted.load_printer_config()["packPrinter"]["port"]
        .as_u64()
        .unwrap() as u16
}
fn document(kind: &str) -> Value {
    json!({"widthMm":58,"heightMm":40,"canvas":{"width":464,"height":320,"labelType":if kind=="BOX" {"box"} else {"pack"}},
    "elements":[
        {"id":"numbers","type":"text","x":0,"y":0,"w":460,"h":24,"minLength":8,
            "text":format!("{kind} {{{{ pack_number }}}}|BOX {{{{ box_number }}}}|COUNT {{{{ pack_count }}}}")},
        {"id":"data","type":"text","x":0,"y":40,"w":460,"h":24,
            "text":"{{ name }}|{{ operator_name }}|{{ operator }}|{{ weight_netto_pack }}|{{ weight_brutto_pack }}"},
        {"id":"box-weight","type":"text","x":0,"y":80,"w":460,"h":24,
            "text":"NET {{ weight_netto_box }}|GROSS {{ weight_brutto_box }}"},
        {"id":"barcode","type":"barcode","x":0,"y":120,"w":300,"h":80,"barcodeType":"code128","value":"{{ pack_number }}"}
    ]})
}

struct TcpSink {
    port: u16,
    stop: Arc<AtomicBool>,
    jobs: mpsc::Receiver<Vec<u8>>,
    thread: Option<thread::JoinHandle<()>>,
}
impl TcpSink {
    fn new() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let (send, jobs) = mpsc::channel();
        let thread = thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(WallDuration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("accept: {error}"),
                };
                stream
                    .set_read_timeout(Some(WallDuration::from_millis(50)))
                    .unwrap();
                let mut pending = Vec::new();
                let mut buffer = [0_u8; 8192];
                while !stopping.load(Ordering::Acquire) {
                    match stream.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(size) => pending.extend_from_slice(&buffer[..size]),
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) =>
                        {
                            continue
                        }
                        Err(error) => panic!("read: {error}"),
                    }
                    while let Some(end) = pending.windows(3).position(|bytes| bytes == b"^XZ") {
                        send.send(pending.drain(..end + 3).collect()).unwrap();
                    }
                    assert!(pending.len() <= crate::printer::MAX_RAW_JOB_BYTES);
                }
            }
        });
        Self {
            port,
            stop,
            jobs,
            thread: Some(thread),
        }
    }
    fn receive(&self, count: usize) -> Vec<String> {
        (0..count)
            .map(|_| {
                String::from_utf8(self.jobs.recv_timeout(WallDuration::from_secs(10)).unwrap())
                    .unwrap()
            })
            .collect()
    }
}
impl Drop for TcpSink {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.thread.take() {
            let result = worker.join();
            if !thread::panicking() {
                assert!(result.is_ok());
            }
        }
    }
}

#[derive(Default)]
struct OverlapGate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}
impl OverlapGate {
    fn sending(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, WallDuration::from_secs(10), |state| !state.1)
            .unwrap();
        assert!(
            !timeout.timed_out() || state.1,
            "preparation did not overlap the pending send"
        );
    }
    fn prepared(&self, check: impl FnOnce()) {
        let state = self.state.lock().unwrap();
        let (mut state, timeout) = self
            .changed
            .wait_timeout_while(state, WallDuration::from_secs(10), |state| !state.0)
            .unwrap();
        assert!(
            !timeout.timed_out() || state.0,
            "worker did not enter sending"
        );
        check();
        state.1 = true;
        self.changed.notify_all();
    }
}

#[test]
fn pipeline_overlaps_without_reserving_future_rows_and_respects_box_barriers() {
    let sink = TcpSink::new();
    let fixture = Arc::new(Fixture::new(sink.port, 2));
    let gate = Arc::new(OverlapGate::default());
    let first = Arc::new(AtomicBool::new(true));
    let captured = Arc::clone(&fixture);
    let sync = Arc::clone(&gate);
    let events = RuntimeEventSink::callback(move |event| {
        if let NativeRuntimeEvent::Event { name, payload } = event {
            if name == "printer-durable-job-update"
                && payload["state"] == "sending"
                && first.swap(false, Ordering::AcqRel)
            {
                sync.sending();
            }
            if name == "native-pack-prepared" && payload["index"] == 1 {
                assert_eq!(payload["preparedAhead"], true);
                sync.prepared(|| {
                    assert_eq!(captured.scalar("SELECT COUNT(*) FROM pack"), 1);
                    assert_eq!(
                        captured.scalar("SELECT COUNT(*) FROM printer_delivery_jobs"),
                        1
                    );
                    assert_eq!(
                        captured.scalar(
                            "SELECT COUNT(*) FROM printer_delivery_jobs WHERE state='accepted'"
                        ),
                        0
                    );
                });
            }
            if name == "native-pack-preparing" && (payload["index"] == 2 || payload["index"] == 4) {
                assert_eq!(payload["preparedAhead"], false);
                assert_eq!(
                    captured.operational.latest_counters(Some(1)).unwrap()["unitsInBox"],
                    0
                );
            }
        }
    });
    let result = fixture.batch(5, &events, &|| false).unwrap();
    assert_eq!(
        (result.completed, result.committed, result.cancelled),
        (5, 5, false)
    );
    assert!(result.failure.is_none());
    assert_eq!(
        (
            result.stats.prepared,
            result.stats.prefetched,
            result.stats.box_barriers
        ),
        (5, 2, 2)
    );
    assert_eq!(
        (
            result.stats.peak_prepared_jobs,
            result.stats.prefetch_capacity
        ),
        (1, 1)
    );
    assert!(
        result.stats.peak_prepared_bytes > 0
            && result.stats.peak_prepared_bytes <= result.stats.prefetch_byte_limit
    );
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM boxes WHERE status='Closed'"),
        2
    );
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs WHERE state='accepted'"),
        7
    );
    let streams = sink.receive(7);
    for (stream, number, box_number, count) in [
        (0, 1, 1, 1),
        (1, 2, 1, 2),
        (3, 3, 2, 1),
        (4, 4, 2, 2),
        (6, 5, 3, 1),
    ] {
        assert!(
            streams[stream].contains(&format!(
                "PACK 07{number:06}|BOX 07{box_number:06}|COUNT {count}"
            )),
            "{}",
            streams[stream]
        );
    }
    assert!(streams[2].contains("BOX 07000002|BOX 07000001|COUNT 2"));
    assert!(streams[5].contains("BOX 07000004|BOX 07000002|COUNT 2"));
    let metrics = fixture.service.performance_summary();
    assert_eq!(
        (
            metrics.accepted_total,
            metrics.failed_total,
            metrics.retained_samples
        ),
        (5, 0, 5)
    );
}

#[test]
fn pipeline_transport_failure_discards_prefetch_and_exposes_the_committed_job() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let fixture = Arc::new(Fixture::new(listener.local_addr().unwrap().port(), 99));
    let listener = Mutex::new(Some(listener));
    let gate = OverlapGate::default();
    let first = AtomicBool::new(true);
    let events = RuntimeEventSink::callback(move |event| {
        if let NativeRuntimeEvent::Event { name, payload } = event {
            if name == "printer-durable-job-update"
                && payload["state"] == "sending"
                && first.swap(false, Ordering::AcqRel)
            {
                gate.sending();
            }
            if name == "native-pack-prepared" && payload["index"] == 1 {
                gate.prepared(|| {
                    drop(listener.lock().unwrap().take());
                });
            }
        }
    });
    let result = fixture.batch(3, &events, &|| false).unwrap();
    assert_eq!(
        (result.completed, result.committed, result.cancelled),
        (0, 1, false)
    );
    assert_eq!((result.stats.prefetched, result.stats.discarded), (1, 1));
    let failure = result.failure.as_ref().unwrap();
    assert_eq!(failure.stage, "transport");
    assert!(failure.job_id.as_ref().is_some_and(|id| !id.is_empty()));
    assert!(result.last_print.is_none());
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 1);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs"),
        1
    );
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs WHERE state='uncertain'"),
        1
    );
    assert_eq!(fixture.service.performance_summary().failed_total, 1);
    assert!(result
        .status_message()
        .contains("принято 0 из 3 · учтено 1"));
}

#[test]
fn pipeline_future_preparation_error_preserves_current_acceptance() {
    let sink = TcpSink::new();
    let fixture = Arc::new(Fixture::new(sink.port, 99));
    let captured = Arc::clone(&fixture);
    let failures = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&failures);
    let events = RuntimeEventSink::callback(move |event| {
        if let NativeRuntimeEvent::Event { name, payload } = event {
            if name == "native-pack-preparing" && payload["index"] == 1 {
                captured
                    .connection()
                    .execute_batch("ALTER TABLE operational_totals RENAME TO pipeline_test_totals;")
                    .unwrap();
            }
            if name == "native-pack-preparation-failed" && payload["index"] == 1 {
                observed.fetch_add(1, Ordering::AcqRel);
                captured
                    .connection()
                    .execute_batch("ALTER TABLE pipeline_test_totals RENAME TO operational_totals;")
                    .unwrap();
            }
        }
    });
    let result = fixture.batch(3, &events, &|| false).unwrap();
    assert_eq!(failures.load(Ordering::Acquire), 1);
    assert_eq!((result.completed, result.committed), (1, 1));
    assert_eq!(result.failure.as_ref().unwrap().stage, "prepare");
    assert!(result.last_print.as_ref().unwrap().receipt.is_some());
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 1);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs WHERE state='accepted'"),
        1
    );
    assert_eq!(sink.receive(1).len(), 1);
}

#[test]
fn pipeline_outbox_error_rolls_back_pack_box_pallet_and_counters() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 99);
    fixture.connection().execute_batch("CREATE TRIGGER pipeline_fail BEFORE INSERT ON printer_delivery_jobs BEGIN SELECT RAISE(ABORT,'pipeline outbox failure'); END;").unwrap();
    let result = fixture
        .batch(3, &RuntimeEventSink::detached(), &|| false)
        .unwrap();
    assert_eq!((result.completed, result.committed), (0, 0));
    assert_eq!(result.failure.as_ref().unwrap().stage, "commit");
    assert!(result
        .failure
        .as_ref()
        .unwrap()
        .message
        .contains("pipeline outbox failure"));
    for table in ["pack", "boxes", "pallet", "printer_delivery_jobs"] {
        assert_eq!(fixture.scalar(&format!("SELECT COUNT(*) FROM {table}")), 0);
    }
    assert_eq!(
        fixture.operational.latest_counters(Some(1)).unwrap()["totalUnits"],
        0
    );
    assert_eq!(fixture.printer.summary().submitted_jobs, 0);
}

#[test]
fn pipeline_box_outbox_error_stops_after_accepted_pack_and_repeat_is_exact() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 1);
    fixture.connection().execute_batch("CREATE TRIGGER pipeline_box_fail BEFORE INSERT ON printer_delivery_jobs WHEN NEW.idempotency_key LIKE 'native-box:%' BEGIN SELECT RAISE(ABORT,'pipeline box failure'); END;").unwrap();
    let events = RuntimeEventSink::detached();
    let result = fixture.batch(3, &events, &|| false).unwrap();
    assert_eq!(
        (result.completed, result.committed, result.stats.prefetched),
        (1, 1, 0)
    );
    assert_eq!(result.failure.as_ref().unwrap().stage, "box-close");
    let last = result.last_print.as_ref().unwrap();
    assert!(last.receipt.is_some());
    assert!(!last.auto_closed_box);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM boxes WHERE status='Open'"),
        1
    );
    let repeated = fixture
        .service
        .repeat_last(&fixture.printer, &events)
        .unwrap();
    assert_eq!(repeated.pack_id, last.pack_id);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 1);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs WHERE state='accepted'"),
        2
    );
    let streams = sink.receive(2);
    assert_eq!(streams[0], streams[1]);
}

#[test]
fn pipeline_stale_counter_snapshot_is_reprepared_before_atomic_commit() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 99);
    let snapshot = fixture.snapshot();
    let prepared = fixture
        .service
        .prepare_pack(
            &snapshot,
            &fixture.printer,
            fixture.operational.latest_counters(Some(1)).unwrap(),
        )
        .unwrap();
    fixture.external_pack(1);
    let mut committed = fixture
        .service
        .commit_pack(
            &snapshot,
            &fixture.operational,
            &fixture.printer,
            prepared,
            &|| false,
        )
        .unwrap()
        .unwrap();
    assert_eq!(committed.stale_retries, 1);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 2);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs"),
        1
    );
    let events = RuntimeEventSink::detached();
    let pending = fixture
        .service
        .dispatch_pack(&fixture.printer, &events, &mut committed);
    let result = fixture
        .service
        .finish_pack(
            &fixture.persisted,
            &fixture.operational,
            &fixture.session,
            &fixture.printer,
            &events,
            &snapshot,
            committed,
            pending,
        )
        .unwrap();
    assert_eq!(result.outcome.number, "07000002");
    assert!(sink.receive(1)[0].contains("PACK 07000002|BOX 07000001|COUNT 2"));
}

#[test]
fn pipeline_repeated_counter_conflicts_are_bounded_and_never_create_own_outbox() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 99);
    let snapshot = fixture.snapshot();
    let prepared = fixture
        .service
        .prepare_pack(
            &snapshot,
            &fixture.printer,
            fixture.operational.latest_counters(Some(1)).unwrap(),
        )
        .unwrap();
    let checks = AtomicUsize::new(0);
    let inserted = AtomicUsize::new(0);
    let result = fixture.service.commit_pack(
        &snapshot,
        &fixture.operational,
        &fixture.printer,
        prepared,
        &|| {
            let check = checks.fetch_add(1, Ordering::AcqRel);
            if check % 2 == 0 {
                let index = inserted.fetch_add(1, Ordering::AcqRel) + 1;
                fixture.external_pack(index);
            }
            false
        },
    );
    assert!(result.err().unwrap().contains("счётчики изменились"));
    assert_eq!(inserted.load(Ordering::Acquire), 3);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 3);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs"),
        0
    );
}

#[test]
fn pipeline_cancellation_is_rechecked_after_stale_repreparation() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 99);
    let snapshot = fixture.snapshot();
    let prepared = fixture
        .service
        .prepare_pack(
            &snapshot,
            &fixture.printer,
            fixture.operational.latest_counters(Some(1)).unwrap(),
        )
        .unwrap();
    let checks = AtomicUsize::new(0);
    let result = fixture
        .service
        .commit_pack(
            &snapshot,
            &fixture.operational,
            &fixture.printer,
            prepared,
            &|| {
                let check = checks.fetch_add(1, Ordering::AcqRel);
                if check == 0 {
                    fixture.external_pack(1);
                }
                check >= 2
            },
        )
        .unwrap();
    assert!(result.is_none());
    assert_eq!(checks.load(Ordering::Acquire), 3);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 1);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM printer_delivery_jobs"),
        0
    );
}

#[test]
fn pipeline_snapshot_freezes_product_templates_devices_numbering_and_operator() {
    let sink = TcpSink::new();
    let fixture = Arc::new(Fixture::new(sink.port, 2));
    let captured = Arc::clone(&fixture);
    let mut doc = document("PACK");
    doc["elements"][0]["minLength"] = json!(0);
    fixture
        .connection()
        .execute(
            "UPDATE labels SET structure=?1 WHERE id=1",
            [doc.to_string()],
        )
        .unwrap();
    let mut numbering = fixture.persisted.load_numbering_config();
    numbering["unit"] = json!({"enabled":true,"prefix":"07","length":6});
    numbering["box"] = json!({"enabled":true,"prefix":"07","length":6});
    fixture.persisted.save_numbering_config(numbering).unwrap();
    let events = RuntimeEventSink::callback(move |event| {
        if let NativeRuntimeEvent::Event { name, payload } = event {
            if name == "native-pack-prepared" && payload["index"] == 0 {
                captured.connection().execute_batch("UPDATE nomenclature SET name='After',fixed_weight_grams=9000,close_box_counter=99,exp_date=500; UPDATE container SET weight=3000; UPDATE labels SET structure='{}';").unwrap();
                let mut disabled = device(sink_port(&captured.persisted));
                disabled["active"] = json!(false);
                captured
                    .persisted
                    .save_printer_config(json!({"packPrinter":disabled,"boxPrinter":disabled}))
                    .unwrap();
                let mut numbering = captured.persisted.load_numbering_config();
                numbering["unit"] = json!({"enabled":true,"prefix":"99","length":6});
                captured.persisted.save_numbering_config(numbering).unwrap();
                assert_eq!(
                    captured
                        .session
                        .set(&captured.operational, "op-b", "")
                        .unwrap()["ok"],
                    true
                );
            }
        }
    });
    let result = fixture.batch(4, &events, &|| false).unwrap();
    assert_eq!(
        (
            result.completed,
            result.committed,
            result.stats.box_barriers
        ),
        (4, 4, 2)
    );
    assert!(result.failure.is_none());
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack WHERE operator_uuid='op-a' AND ABS(weight_brutto-1.1)<0.00001 AND ABS(weight_netto-1.0)<0.00001"),4);
    for stream in sink.receive(6) {
        assert!(stream.contains("Before|Operator A|A|"), "{stream}");
        assert!(!stream.contains("After") && !stream.contains("PACK 99"));
    }
    assert_eq!(
        fixture.scalar(
            "SELECT COUNT(*) FROM boxes WHERE status='Closed' AND ABS(weight_brutto-2.5)<0.00001"
        ),
        2
    );
}

#[test]
fn pipeline_serializes_other_production_mutations_but_releases_on_completion() {
    let sink = TcpSink::new();
    let fixture = Arc::new(Fixture::new(sink.port, 99));
    let captured = Arc::clone(&fixture);
    let events = RuntimeEventSink::callback(move |event| {
        if let NativeRuntimeEvent::Event { name, payload } = event {
            if name == "native-pack-prepared" && payload["index"] == 0 {
                let f = &captured;
                let none = RuntimeEventSink::detached();
                let errors = [
                    f.service
                        .record_and_print_pack(
                            &f.persisted,
                            &f.operational,
                            &f.session,
                            &f.printer,
                            &none,
                            request(),
                        )
                        .unwrap_err(),
                    f.service
                        .close_box(
                            &f.persisted,
                            &f.operational,
                            &f.session,
                            &f.printer,
                            &none,
                            1,
                            "BATCH-1",
                            "07.09.2026",
                        )
                        .unwrap_err(),
                    f.service
                        .print_pallet(
                            &f.persisted,
                            &f.operational,
                            &f.session,
                            &f.printer,
                            &none,
                            Some(1),
                        )
                        .unwrap_err(),
                    f.service.repeat_last(&f.printer, &none).unwrap_err(),
                    f.service.delete_latest_pack(&f.operational, 1).unwrap_err(),
                ];
                assert!(errors.iter().all(|error| error.contains("другая операция")));
                assert_eq!(f.scalar("SELECT COUNT(*) FROM pack"), 0);
            }
        }
    });
    assert_eq!(fixture.batch(1, &events, &|| false).unwrap().completed, 1);
    assert_eq!(
        fixture
            .service
            .repeat_last(&fixture.printer, &RuntimeEventSink::detached())
            .unwrap()
            .kind,
        "repeat"
    );
    assert_eq!(sink.receive(2).len(), 2);
}

#[test]
fn pipeline_ui_cancellation_before_commit_during_dispatch_and_prefetch_preserves_receipts() {
    for phase in ["before", "dispatch", "prefetch"] {
        let sink = TcpSink::new();
        let fixture = Fixture::new(sink.port, 99);
        let owner: Arc<OnceLock<Weak<NativeUiRuntime>>> = Arc::new(OnceLock::new());
        let control = Arc::clone(&owner);
        let finish = Arc::new(Mutex::new(Vec::new()));
        let finished = Arc::clone(&finish);
        let cancelled = AtomicBool::new(false);
        let runtime = Arc::new(
            NativeUiRuntime::with_database(&fixture.persisted.database_path(), move |event| {
                if let NativeRuntimeEvent::Event { name, payload } = event {
                    let trigger = match phase {
                        "before" => name == "native-pack-prepared" && payload["index"] == 0,
                        "dispatch" => {
                            name == "printer-durable-job-update" && payload["state"] == "sending"
                        }
                        _ => name == "native-pack-prepared" && payload["index"] == 1,
                    };
                    if trigger && !cancelled.swap(true, Ordering::AcqRel) {
                        let runtime = control.get().unwrap().upgrade().unwrap();
                        assert!(runtime.cancel_fixed_weight_batch());
                        assert!(runtime
                            .print_fixed_weight_batch(
                                1,
                                1,
                                "OTHER".to_owned(),
                                "07.09.2026".to_owned()
                            )
                            .unwrap_err()
                            .contains("уже выполняется"));
                    }
                    if name == "fixed-batch-finished" {
                        finished.lock().unwrap().push(payload);
                    }
                }
            })
            .unwrap(),
        );
        owner.set(Arc::downgrade(&runtime)).unwrap();
        let result = runtime
            .print_fixed_weight_batch(1, 3, "BATCH-1".to_owned(), "07.09.2026".to_owned())
            .unwrap();
        let count = if phase == "before" { 0 } else { 1 };
        assert_eq!(
            (result.completed, result.committed),
            (count, count),
            "{phase}"
        );
        assert!(result.cancelled && result.failure.is_none());
        assert_eq!(result.last_print.is_some(), count > 0);
        assert!(!runtime.fixed_weight_batch_active());
        assert!(!runtime.cancel_fixed_weight_batch());
        assert_eq!(finish.lock().unwrap().len(), 1);
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), count);
        assert_eq!(sink.receive(count as usize).len(), count as usize);
        let summary = runtime.printer_summary().unwrap();
        assert_eq!(summary["nativePrint"]["acceptedTotal"], count);
        assert!(summary.get("maxJobBytes").is_some());
    }
}

#[test]
fn pipeline_ui_preflight_errors_emit_one_terminal_event_and_clear_active_lease() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 99);
    let finish = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::clone(&finish);
    let runtime =
        NativeUiRuntime::with_database(&fixture.persisted.database_path(), move |event| {
            if let NativeRuntimeEvent::Event { name, payload } = event {
                if name == "fixed-batch-finished" {
                    finished.lock().unwrap().push(payload);
                }
            }
        })
        .unwrap();
    for (product, copies) in [(1, 0), (1, 5001), (999, 1)] {
        assert!(runtime
            .print_fixed_weight_batch(product, copies, "B".to_owned(), "07.09.2026".to_owned())
            .is_err());
        assert!(!runtime.fixed_weight_batch_active());
    }
    assert_eq!(finish.lock().unwrap().len(), 3);
    assert!(finish
        .lock()
        .unwrap()
        .iter()
        .all(|event| event["failure"]["stage"] == "preflight"));
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 0);
    assert_eq!(
        runtime
            .print_fixed_weight_batch(1, 1, "B".to_owned(), "07.09.2026".to_owned())
            .unwrap()
            .completed,
        1
    );
    assert_eq!(sink.receive(1).len(), 1);
}

#[test]
fn pipeline_ui_active_lease_clears_during_unwind() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 99);
    let runtime =
        NativeUiRuntime::with_database(&fixture.persisted.database_path(), move |event| {
            if let NativeRuntimeEvent::Event { name, .. } = event {
                if name == "native-pack-preparing" {
                    panic!("test observer failure before commit");
                }
            }
        })
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.print_fixed_weight_batch(1, 1, "B".to_owned(), "07.09.2026".to_owned())
    }));
    assert!(result.is_err());
    assert!(!runtime.fixed_weight_batch_active());
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 0);
}

#[test]
fn pipeline_box_preflight_failure_never_records_a_pack() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 1);
    fixture
        .connection()
        .execute("UPDATE labels SET structure='invalid json' WHERE id=2", [])
        .unwrap();
    assert!(fixture
        .batch(3, &RuntimeEventSink::detached(), &|| false)
        .is_err());
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 0);
    assert_eq!(fixture.printer.summary().submitted_jobs, 0);
}

#[test]
fn pipeline_unused_box_printer_is_not_a_preflight_requirement() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 0);
    fixture
        .connection()
        .execute("UPDATE labels SET structure='invalid json' WHERE id=2", [])
        .unwrap();
    let result = fixture
        .batch(2, &RuntimeEventSink::detached(), &|| false)
        .unwrap();
    assert_eq!(
        (
            result.completed,
            result.committed,
            result.stats.box_barriers
        ),
        (2, 2, 0)
    );
    assert!(result.failure.is_none());
    assert_eq!(sink.receive(2).len(), 2);
}

#[test]
fn pipeline_cancelled_before_preparation_has_no_material_or_accounting() {
    let sink = TcpSink::new();
    let fixture = Fixture::new(sink.port, 99);
    let result = fixture
        .batch(3, &RuntimeEventSink::detached(), &|| true)
        .unwrap();
    assert_eq!(
        (result.completed, result.committed, result.stats.prepared),
        (0, 0, 0)
    );
    assert!(result.cancelled && result.failure.is_none());
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM pack"), 0);
    assert_eq!(fixture.printer.summary().submitted_jobs, 0);
}
