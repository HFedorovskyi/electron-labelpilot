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
