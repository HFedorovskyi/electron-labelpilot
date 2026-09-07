use super::*;
use crate::native_ui::NativeUiRuntime;
use crate::runtime_events::NativeRuntimeEvent;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration as WallDuration, Instant};

fn micros(start: Instant) -> u64 {
    start.elapsed().as_micros().min(u64::MAX as u128) as u64
}
fn distribution(values: &mut [u64]) -> Value {
    values.sort_unstable();
    let at = |percent: usize| values[(values.len() * percent).div_ceil(100).saturating_sub(1)];
    json!({"samples":values.len(),"p50":at(50),"p95":at(95),"max":values[values.len()-1]})
}
fn sample_data() -> Value {
    json!({
        "name":"Контрольная продукция", "article":"3002", "barcode":"4870254930240",
        "Код ШК":"4870254930240", "station_number":"07", "operator":"OP1", "operator_name":"Test Operator",
        "pack_number":"07000001", "box_number":"07000001", "batch_number":"BENCH-01",
        "weight":"1.000", "weight_netto_pack":"1.000", "weight_brutto_pack":"1.100",
        "weight_netto_box":"8.000", "weight_brutto_box":"8.500", "pack_count":"8", "pack_counter":"8",
        "box_count":"1", "close_box_counter":"8", "box_limit":"8", "exp_date":"10",
        "date":"07.09.26", "production_date":"07.09.2026", "date_exp":"17.09.26", "exp_date_full":"17.09.2026",
        "pallet_number":"P1", "items":[], "total_count":"8", "weight_netto_pallet":"8.000"
    })
}
fn config(port: u16, dpi: u32) -> Value {
    json!({"id":"benchmark", "active":true, "name":"Local benchmark sink",
        "connection":"tcp", "protocol":"image", "ip":"127.0.0.1", "port":port,
        "dpi":dpi, "persistentConnection":true, "tcpJobBoundary":"stream"})
}

#[test]
#[ignore = "explicit local production benchmark; writes results only to the requested output file"]
fn benchmark_production_pipeline() {
    let fixture_path = std::env::var_os("LABELPILOT_PRINT_BENCH_FIXTURE")
        .expect("set LABELPILOT_PRINT_BENCH_FIXTURE to the read-only template snapshot");
    let output = std::env::var_os("LABELPILOT_PRINT_BENCH_OUTPUT")
        .expect("set LABELPILOT_PRINT_BENCH_OUTPUT to an artifact JSON path");
    let fixture: Value = serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    let labels = fixture["labels"].as_array().unwrap();
    assert!(!labels.is_empty());
    let service = NativePrintService::new(
        std::env::temp_dir().join(format!("lp-bench-render-{}", Uuid::new_v4())),
    );
    let printer = PrinterTransportState::new();
    native_raster::warmup_static_assets();
    let mut preparations = Vec::new();
    for label in labels {
        for dpi in [203, 300] {
            let mut renders = Vec::new();
            let mut encodes = Vec::new();
            let mut material_bytes = 0;
            let mut error = None;
            for iteration in 0..10 {
                let start = Instant::now();
                let prepared =
                    match service.prepare(config(9100, dpi), label["doc"].clone(), sample_data()) {
                        Ok(value) => value,
                        Err(value) => {
                            error = Some(value);
                            break;
                        }
                    };
                let render_us = micros(start);
                material_bytes = match &prepared.material {
                    PreparedMaterial::Raw(bytes) => bytes.len(),
                    PreparedMaterial::Raster(bitmap) => bitmap.mono.len(),
                };
                let start = Instant::now();
                if let Err(value) =
                    service.prepare_delivery(&printer, prepared, "benchmark-prepare")
                {
                    error = Some(value);
                    break;
                }
                if iteration >= 2 {
                    renders.push(render_us);
                    encodes.push(micros(start));
                }
            }
            preparations.push(match error {
                Some(error) => json!({"templateId":label["id"],"dpi":dpi,"error":error}),
                None => json!({"templateId":label["id"],"dpi":dpi,"materialBytes":material_bytes,
                    "renderUs":distribution(&mut renders),"encodeUs":distribution(&mut encodes)}),
            });
        }
    }
    let pack_doc = &labels
        .iter()
        .find(|label| label["doc"]["canvas"]["labelType"] == "pack")
        .unwrap()["doc"];
    let box_doc = &labels
        .iter()
        .find(|label| label["doc"]["canvas"]["labelType"] == "box")
        .unwrap()["doc"];
    let mut batches = Vec::new();
    for dpi in [203, 300] {
        for delay_ms in [0, 40] {
            batches.push(batch_sample(
                &fixture, pack_doc, box_doc, dpi, delay_ms, false,
            ));
        }
    }
    let report = json!({"profile":"debug; local loopback; synthetic data in unchanged working templates",
        "phase":std::env::var("LABELPILOT_PRINT_BENCH_PHASE").unwrap_or_else(|_|"current".to_owned()),
        "preparation":preparations,"batches":batches,
        "simulatedDelay":"sending-event callback delays worker; not physical printer throughput"});
    fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!(
        "PRINT_PIPELINE_BENCH {}",
        serde_json::to_string(&report).unwrap()
    );
    assert!(report["preparation"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("error").is_none()));
}

fn batch_sample(
    fixture: &Value,
    pack_doc: &Value,
    box_doc: &Value,
    dpi: u32,
    delay_ms: u64,
    sequential: bool,
) -> Value {
    let copies = 16_i64;
    let expected_jobs = copies as usize + copies as usize / 8;
    let directory = std::env::temp_dir().join(format!("labelpilot-print-bench-{}", Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let stopped = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stopped);
    let server = thread::spawn(move || {
        let deadline = Instant::now() + WallDuration::from_secs(60);
        let mut jobs = Vec::new();
        let mut total_bytes = 0_usize;
        while !server_stop.load(Ordering::Acquire)
            && Instant::now() < deadline
            && jobs.len() < expected_jobs
        {
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(WallDuration::from_millis(1));
                    continue;
                }
                Err(error) => panic!("benchmark accept: {error}"),
            };
            stream
                .set_read_timeout(Some(WallDuration::from_millis(200)))
                .unwrap();
            let mut pending = Vec::new();
            let mut buffer = [0_u8; 32768];
            while Instant::now() < deadline && jobs.len() < expected_jobs {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => pending.extend_from_slice(&buffer[..count]),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                        ) =>
                    {
                        if server_stop.load(Ordering::Acquire) {
                            break;
                        }
                        continue;
                    }
                    Err(error) => panic!("benchmark read: {error}"),
                }
                while let Some(end) = pending.windows(3).position(|bytes| bytes == b"^XZ") {
                    let bytes: Vec<u8> = pending.drain(..end + 3).collect();
                    total_bytes += bytes.len();
                    jobs.push(format!("{:x}", Sha256::digest(bytes)));
                }
                assert!(pending.len() <= crate::printer::MAX_RAW_JOB_BYTES);
            }
        }
        (jobs, total_bytes)
    });
    let persisted = PersistedState::for_data_dir(directory.clone());
    persisted
        .save_printer_config(json!({"packPrinter":config(port,dpi),"boxPrinter":config(port,dpi)}))
        .unwrap();
    let connection = crate::processor::open_database(&persisted).unwrap();
    connection.execute("INSERT INTO labels(id,name,structure) VALUES(1,'Benchmark pack',?1),(2,'Benchmark box',?2)",
        [pack_doc.to_string(),box_doc.to_string()]).unwrap();
    for barcode in fixture["barcodes"].as_array().unwrap() {
        connection
            .execute(
                "INSERT INTO barcodes(id,name,structure) VALUES(?1,'Benchmark barcode',?2)",
                rusqlite::params![
                    barcode["id"].as_i64().unwrap(),
                    barcode["structure"].to_string()
                ],
            )
            .unwrap();
    }
    connection.execute_batch(r#"
        INSERT INTO station(uuid,number,name) VALUES('benchmark-station',7,'Benchmark');
        INSERT INTO container(id,name,weight) VALUES(1,'Tray',100),(2,'Box',500);
        INSERT INTO nomenclature(id,name,article,exp_date,portion_container_id,box_container_id,
            templates_pack_label,templates_box_label,close_box_counter,extra_data,is_fixed_weight,fixed_weight_grams)
        VALUES(1,'Контрольная продукция','3002',10,1,2,1,2,8,'{"Код ШК":"4870254930240"}',1,1100);
    "#).unwrap();
    drop(connection);
    let measurements = Arc::new(Mutex::new(Vec::<Value>::new()));
    let capture = Arc::clone(&measurements);
    let runtime = NativeUiRuntime::with_persisted(persisted, move |event| {
        if let NativeRuntimeEvent::Event { name, payload } = event {
            if name == "printer-durable-job-update"
                && payload["state"] == "sending"
                && delay_ms != 0
            {
                thread::sleep(WallDuration::from_millis(delay_ms));
            }
            if name == "native-print-timing" {
                capture.lock().unwrap().push(payload);
            }
        }
    })
    .unwrap();
    let start = Instant::now();
    let outcome = if sequential {
        (|| -> Result<Value, String> {
            let mut last_print = None;
            for _ in 0..copies {
                last_print = Some(runtime.print_production_pack(
                    1,
                    1.1,
                    "BENCH-01".to_owned(),
                    "07.09.2026".to_owned(),
                )?);
            }
            Ok(
                json!({"completed":copies,"committed":copies,"requested":copies,"cancelled":false,"lastPrint":last_print,"reference":"same-build serialized per-pack calls"}),
            )
        })()
    } else {
        runtime
            .print_fixed_weight_batch(1, copies, "BENCH-01".to_owned(), "07.09.2026".to_owned())
            .map(|outcome| json!(outcome))
    };
    let elapsed_us = micros(start);
    runtime.disconnect_printers();
    stopped.store(true, Ordering::Release);
    let (hashes, bytes) = server.join().unwrap();
    let outcome = outcome.unwrap();
    assert_eq!(outcome["completed"], copies);
    assert_eq!(outcome["cancelled"], false);
    assert_eq!(hashes.len(), expected_jobs);
    let connection = rusqlite::Connection::open(directory.join("client_data.db")).unwrap();
    let packs = connection
        .query_row("SELECT COUNT(*) FROM pack", [], |row| row.get::<_, i64>(0))
        .unwrap();
    let accepted = connection
        .query_row(
            "SELECT COUNT(*) FROM printer_delivery_jobs WHERE state='accepted'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(packs, copies);
    assert_eq!(accepted, expected_jobs as i64);
    let result = json!({"dpi":dpi,"simulatedWorkerDelayMs":delay_ms,"sequentialReference":sequential,"copies":copies,"totalUs":elapsed_us,
        "labelsPerSecond":copies as f64*1_000_000.0/elapsed_us.max(1) as f64,"acceptedJobs":accepted,
        "streamBytes":bytes,"streamSha256":hashes,"timings":*measurements.lock().unwrap(),
        "outcome":outcome});
    drop(connection);
    drop(runtime);
    assert!(directory.starts_with(std::env::temp_dir()));
    fs::remove_dir_all(directory).unwrap();
    result
}

#[test]
#[ignore = "paired same-build serialized/pipelined reference; explicit local benchmark"]
fn benchmark_paired_batch_pipeline() {
    let fixture_path = std::env::var_os("LABELPILOT_PRINT_BENCH_FIXTURE")
        .expect("set LABELPILOT_PRINT_BENCH_FIXTURE");
    let output = std::env::var_os("LABELPILOT_PRINT_BENCH_PAIRED_OUTPUT")
        .expect("set LABELPILOT_PRINT_BENCH_PAIRED_OUTPUT");
    let fixture: Value = serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    let labels = fixture["labels"].as_array().unwrap();
    let pack_doc = &labels
        .iter()
        .find(|label| label["doc"]["canvas"]["labelType"] == "pack")
        .unwrap()["doc"];
    let box_doc = &labels
        .iter()
        .find(|label| label["doc"]["canvas"]["labelType"] == "box")
        .unwrap()["doc"];
    native_raster::warmup_static_assets();
    let mut pairs = Vec::new();
    for dpi in [203, 300] {
        for delay_ms in [0, 40] {
            for iteration in 0..3 {
                let first_sequential = iteration % 2 == 0;
                let first =
                    batch_sample(&fixture, pack_doc, box_doc, dpi, delay_ms, first_sequential);
                let second = batch_sample(
                    &fixture,
                    pack_doc,
                    box_doc,
                    dpi,
                    delay_ms,
                    !first_sequential,
                );
                let (sequential, pipeline) = if first_sequential {
                    (first, second)
                } else {
                    (second, first)
                };
                assert_eq!(sequential["streamSha256"], pipeline["streamSha256"]);
                assert_eq!(sequential["streamBytes"], pipeline["streamBytes"]);
                println!("PAIRED dpi={dpi} delay_ms={delay_ms} iteration={iteration} sequential_us={} pipeline_us={}",sequential["totalUs"],pipeline["totalUs"]);
                pairs.push(
                    json!({"iteration":iteration,"sequential":sequential,"pipeline":pipeline}),
                );
                fs::write(&output,serde_json::to_vec_pretty(&json!({"reference":"same current build: serialized per-pack calls vs bounded fixed batch; three alternating pairs per condition; not the old binary","pairs":pairs})).unwrap()).unwrap();
            }
        }
    }
    assert_eq!(pairs.len(), 12);
}
