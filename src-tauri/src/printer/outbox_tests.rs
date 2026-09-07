use super::*;

#[test]
fn prepared_driver_actions_round_trip_through_transactional_outbox() {
    let directory =
        std::env::temp_dir().join(format!("labelpilot-outbox-driver-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("test.db");
    {
        let store = durable::DurablePrintStore::open(&path).unwrap();
        let printer = PrinterTransportState::new();
        let config = serde_json::json!({
            "id":"outbox-driver", "connection":"windows_driver", "protocol":"image",
            "printerName":"Virtual test printer"
        });
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        let tx = connection.transaction().unwrap();
        printer
            .prepare_driver_bitmap(config.clone(), 8, 2, vec![0xAA, 0x55])
            .unwrap()
            .persist(&tx)
            .unwrap();
        printer
            .prepare_driver_page(
                config,
                8,
                2,
                vec![0x55, 0xAA],
                210.0,
                297.0,
                PageMarginsMm {
                    top: 2.0,
                    right: 3.0,
                    bottom: 4.0,
                    left: 5.0,
                },
                "actual-size".to_owned(),
                "Outbox sheet".to_owned(),
            )
            .unwrap()
            .persist(&tx)
            .unwrap();
        assert!(store.queued_jobs().unwrap().is_empty());
        tx.commit().unwrap();
        let jobs = store.queued_jobs().unwrap();
        assert_eq!(jobs.len(), 2);
        for job in jobs {
            match job.action {
                JobAction::DriverBitmap {
                    width,
                    height,
                    mono,
                } => {
                    assert_eq!((width, height, mono), (8, 2, vec![0xAA, 0x55]));
                }
                JobAction::DriverPage {
                    width,
                    height,
                    mono,
                    page,
                } => {
                    assert_eq!((width, height, mono), (8, 2, vec![0x55, 0xAA]));
                    assert_eq!((page.page_width_mm, page.page_height_mm), (210.0, 297.0));
                    assert_eq!(page.fit_mode, "actual-size");
                    assert_eq!(page.document_name, "Outbox sheet");
                    assert_eq!(
                        (
                            page.margins_mm.top,
                            page.margins_mm.right,
                            page.margins_mm.bottom,
                            page.margins_mm.left
                        ),
                        (2.0, 3.0, 4.0, 5.0)
                    );
                }
                _ => panic!("unexpected driver action"),
            }
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn prepared_jobs_reject_invalid_material_without_dispatch() {
    let printer = PrinterTransportState::new();
    let config = serde_json::json!({
        "id":"outbox-driver", "connection":"windows_driver", "protocol":"image",
        "printerName":"Virtual test printer"
    });
    assert!(printer
        .prepare_generated(config.clone(), Vec::new())
        .is_err());
    assert!(printer
        .prepare_driver_bitmap(config.clone(), 8, 2, vec![0])
        .is_err());
    assert!(printer
        .prepare_driver_page(
            config.clone(),
            8,
            1,
            vec![0],
            210.0,
            297.0,
            PageMarginsMm::default(),
            "stretch".to_owned(),
            "sheet".to_owned()
        )
        .is_err());
    assert!(printer
        .prepare_driver_page(
            config,
            8,
            1,
            vec![0],
            f64::NAN,
            297.0,
            PageMarginsMm::default(),
            "actual-size".to_owned(),
            "sheet".to_owned()
        )
        .is_err());
    assert_eq!(printer.summary().submitted_jobs, 0);
    assert!(printer.inner.durable.queued_jobs().unwrap().is_empty());
}

#[test]
fn pipeline_pending_receipt_keeps_original_deadline_and_ready_results() {
    let (send, result) = mpsc::sync_channel(1);
    let pending = PendingPrintReceipt {
        result,
        deadline: Instant::now() - Duration::from_millis(1),
        app: RuntimeEventSink::detached(),
        printer_id: "deadline-test".to_owned(),
        physical_key: "loopback".to_owned(),
    };
    let started = Instant::now();
    assert_eq!(
        pending.wait().unwrap_err(),
        "printer job completion timed out"
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(send);

    let receipt:PrintReceipt=serde_json::from_value(serde_json::json!({
        "printerId":"deadline-test","physicalKey":"loopback","bytes":4,"queueMs":1,"sendMs":2,
        "attempts":1,"reusedConnection":false,"deliveryState":"accepted","confirmationMode":"transport",
        "idempotencyKey":"test","deduplicated":false,"durableJobId":"job-test","durableState":"accepted"
    })).unwrap();
    let (send, result) = mpsc::sync_channel(1);
    send.send(Ok(receipt)).unwrap();
    let pending = PendingPrintReceipt {
        result,
        deadline: Instant::now() - Duration::from_millis(1),
        app: RuntimeEventSink::detached(),
        printer_id: "deadline-test".to_owned(),
        physical_key: "loopback".to_owned(),
    };
    assert_eq!(
        pending.wait().unwrap().durable_state.as_deref(),
        Some("accepted")
    );
}

#[test]
fn pipeline_dropped_pending_handle_does_not_cancel_or_duplicate_delivery() {
    use std::io::Read;
    let directory =
        std::env::temp_dir().join(format!("labelpilot-pending-drop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("test.db");
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (bytes_send, bytes_recv) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = [0_u8; 8];
                    socket.read_exact(&mut bytes).unwrap();
                    bytes_send.send(bytes).unwrap();
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("pending test accept: {error}"),
            }
        }
    });
    {
        let printer = PrinterTransportState::with_database(&path).unwrap();
        let config = serde_json::json!({"id":"drop","connection":"tcp","protocol":"zpl","ip":"127.0.0.1","port":port});
        let mut connection = rusqlite::Connection::open(&path).unwrap();
        let transaction = connection.transaction().unwrap();
        let job = printer
            .prepare_generated(config, b"^XA1^XZ\n".to_vec())
            .unwrap()
            .with_idempotency_key("pending-drop")
            .unwrap()
            .persist(&transaction)
            .unwrap();
        transaction.commit().unwrap();
        let (accepted_send, accepted_recv) = mpsc::sync_channel(1);
        let events = RuntimeEventSink::callback(move |event| {
            if let crate::runtime_events::NativeRuntimeEvent::Event { name, payload } = event {
                if name == "printer-durable-job-update" && payload["state"] == "accepted" {
                    accepted_send.send(()).unwrap();
                }
            }
        });
        drop(printer.enqueue_committed_with_sink(events, &job).unwrap());
        accepted_recv.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            bytes_recv.recv_timeout(Duration::from_secs(5)).unwrap(),
            *b"^XA1^XZ\n"
        );
        let (state, attempts): (String, i64) = connection
            .query_row(
                "SELECT state,attempt_count FROM printer_delivery_jobs WHERE job_id=?1",
                [&job],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((state.as_str(), attempts), ("accepted", 1));
        assert_eq!(printer.summary().submitted_jobs, 1);
        // The worker's transactional state transition, not handle ownership,
        // guards an already-accepted job against another physical send.
        assert!(printer
            .enqueue_committed_with_sink(RuntimeEventSink::detached(), &job)
            .unwrap()
            .wait()
            .is_err());
        let attempts: i64 = connection
            .query_row(
                "SELECT attempt_count FROM printer_delivery_jobs WHERE job_id=?1",
                [&job],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 1);
    }
    server.join().unwrap();
    assert!(directory.starts_with(std::env::temp_dir()));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn pipeline_prepared_material_limit_applies_without_opening_serial_or_driver_routes() {
    let printer = PrinterTransportState::new();
    let config = serde_json::json!({"id":"bounded-serial","connection":"serial","protocol":"zpl","serialPort":"COM254","baudRate":9600});
    let material = printer
        .prepare_generated(config.clone(), vec![0x41; MAX_RAW_JOB_BYTES])
        .unwrap();
    assert_eq!(material.byte_len(), MAX_RAW_JOB_BYTES);
    drop(material);
    assert!(printer
        .prepare_generated(config, vec![0x41; MAX_RAW_JOB_BYTES + 1])
        .is_err());
    let driver=printer.prepare_driver_bitmap(serde_json::json!({
        "id":"bounded-driver","connection":"windows_driver","printerName":"Virtual test printer","protocol":"image"
    }),8,2,vec![0xAA,0x55]).unwrap();
    assert_eq!(driver.byte_len(), 2);
    assert_eq!(printer.summary().submitted_jobs, 0);
    assert!(printer.inner.durable.queued_jobs().unwrap().is_empty());
}
