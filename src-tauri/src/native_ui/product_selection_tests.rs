use super::*;
use crate::operational::{CloseBoxPayload, RecordPackPayload, RecordPackResult};
use std::{fs, path::PathBuf};

struct TestDirectory(PathBuf);
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    // Drop the runtime before deleting its temporary database on Windows.
    runtime: NativeUiRuntime,
    _directory: TestDirectory,
}

impl Fixture {
    fn new() -> Self {
        let directory = TestDirectory(std::env::temp_dir().join(format!(
            "labelpilot-product-selection-{}",
            uuid::Uuid::new_v4()
        )));
        fs::create_dir_all(&directory.0).unwrap();
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let connection = crate::processor::open_database(&persisted).unwrap();
        connection
            .execute_batch(
                "INSERT INTO nomenclature(id, name, article, exp_date, close_box_counter)
             VALUES (1, 'Product A', 'A', 2, 10), (2, 'Product B', 'B', 3, 10);",
            )
            .unwrap();
        drop(connection);
        Self {
            runtime: NativeUiRuntime::with_persisted(persisted, |_| {}).unwrap(),
            _directory: directory,
        }
    }

    fn pack(&self, product_id: i64, sequence: i64) -> RecordPackResult {
        self.runtime
            .operational()
            .unwrap()
            .record_pack(
                RecordPackPayload {
                    number: format!("01{sequence:06}"),
                    box_number: format!("01{product_id:06}"),
                    nomenclature_id: product_id,
                    weight_netto: 1.0,
                    weight_brutto: 1.1,
                    barcode_value: "4870254930240".to_owned(),
                    station_number: Some("01".to_owned()),
                    production_date: None,
                    expiration_date: None,
                    batch: None,
                    barcode_spec: None,
                },
                None,
            )
            .unwrap()
    }

    fn close(&self, box_id: i64) {
        self.runtime
            .operational()
            .unwrap()
            .close_box(CloseBoxPayload {
                box_id,
                weight_netto: 1.0,
                weight_brutto: 1.1,
            })
            .unwrap();
    }
}

#[test]
fn selection_checks_persisted_box_even_when_the_ui_snapshot_is_stale() {
    let fixture = Fixture::new();
    let stale = fixture.runtime.weighing_snapshot(Some(1), None).unwrap();
    assert_eq!(stale.counters.units_in_box, 0);
    let first = fixture.pack(1, 1);
    fixture.pack(1, 2);
    let before = fixture.runtime.production_delta(Some(1)).unwrap();
    let error = fixture
        .runtime
        .select_weighing_product(stale.selected_product_id, 2)
        .unwrap_err();
    assert!(error.contains("закройте короб"), "{error}");
    assert!(error.contains("01000001"), "{error}");
    assert!(error.contains("упаковок: 2"), "{error}");
    let after = fixture.runtime.production_delta(Some(1)).unwrap();
    assert_eq!(before, after);
    assert_eq!(after.counters.current_box_id, Some(first.box_id));
    let same = fixture.runtime.select_weighing_product(Some(1), 1).unwrap();
    assert_eq!(same.selected_product_id, Some(1));
    assert_eq!(same.counters.units_in_box, 2);
}

#[test]
fn selection_is_allowed_after_the_current_box_is_closed() {
    let fixture = Fixture::new();
    let pack = fixture.pack(1, 1);
    assert!(fixture.runtime.select_weighing_product(Some(1), 2).is_err());
    fixture.close(pack.box_id);
    let selected = fixture.runtime.select_weighing_product(Some(1), 2).unwrap();
    assert_eq!(selected.selected_product_id, Some(2));
    assert_eq!(selected.counters.units_in_box, 0);
    assert_eq!(selected.counters.current_box_id, None);
    assert_eq!(selected.counters.total_units, 1);
}

#[test]
fn deleted_last_pack_and_unrelated_product_boxes_do_not_block_selection() {
    let fixture = Fixture::new();
    let pack = fixture.pack(1, 1);
    fixture
        .runtime
        .operational()
        .unwrap()
        .delete_pack(pack.pack_id)
        .unwrap();
    assert_eq!(
        fixture
            .runtime
            .select_weighing_product(Some(1), 2)
            .unwrap()
            .selected_product_id,
        Some(2)
    );
    // Other production pages can have their own product box. The guard is scoped
    // to the product being left, rather than every open box on the station.
    fixture.pack(2, 2);
    assert_eq!(
        fixture
            .runtime
            .select_weighing_product(Some(1), 2)
            .unwrap()
            .counters
            .units_in_box,
        1
    );
}

#[test]
fn selection_validates_target_and_does_not_fall_back_to_the_first_catalog_row() {
    let fixture = Fixture::new();
    for missing in [0, -1, 987654] {
        assert!(fixture
            .runtime
            .select_weighing_product(Some(1), missing)
            .is_err());
    }
    let initial = fixture.runtime.select_weighing_product(None, 2).unwrap();
    assert_eq!(initial.selected_product_id, Some(2));
    assert_eq!(
        initial.products.iter().find(|p| p.id == 2).unwrap().article,
        "B"
    );
}

#[test]
fn restart_resumes_the_nonempty_box_before_accepting_a_new_product() {
    let fixture = Fixture::new();
    let pack = fixture.pack(2, 1);
    let resumed = fixture.runtime.weighing_snapshot(None, None).unwrap();
    assert_eq!(resumed.selected_product_id, Some(2));
    assert_eq!(resumed.counters.current_box_id, Some(pack.box_id));
    assert_eq!(resumed.counters.units_in_box, 1);
    assert!(fixture.runtime.select_weighing_product(None, 1).is_err());
    fixture.close(pack.box_id);
    assert_eq!(
        fixture
            .runtime
            .select_weighing_product(None, 1)
            .unwrap()
            .selected_product_id,
        Some(1)
    );
}
