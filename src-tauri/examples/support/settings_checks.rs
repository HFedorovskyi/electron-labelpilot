use labelpilot_tauri_lib::slint_runtime::{
    initialize_settings_models, PrintQueueRow, PrinterChoiceRow, ScaleProtocolRow,
    WeighingPrototype,
};
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

/// Exercise production Slint callbacks with no persistence, network or printers.
pub fn verify() -> Result<Vec<String>, slint::PlatformError> {
    let ui = WeighingPrototype::new()?;
    initialize_settings_models(&ui);
    let mut checks = Vec::new();
    let loads = Rc::new(RefCell::new(Vec::<String>::new()));
    let scale_loads = Rc::new(Cell::new(0));
    let selections = Rc::new(Cell::new(0));
    ui.on_reload_printer_settings({
        let weak = ui.as_weak();
        let loads = loads.clone();
        move || {
            let ui = weak.upgrade().unwrap();
            loads
                .borrow_mut()
                .push(ui.get_settings_selected_role().to_string());
            ui.set_settings_busy(true);
        }
    });
    ui.on_reload_scale_settings({
        let weak = ui.as_weak();
        let count = scale_loads.clone();
        move || {
            count.set(count.get() + 1);
            weak.upgrade().unwrap().set_scale_settings_busy(true);
        }
    });
    ui.on_select_printer_role({
        let weak = ui.as_weak();
        let count = selections.clone();
        move |role| {
            count.set(count.get() + 1);
            weak.upgrade().unwrap().set_settings_selected_role(role);
        }
    });
    ui.set_settings_ip("192.0.2.99".into());
    ui.set_settings_dirty(true);
    ui.invoke_request_settings_role("boxPrinter".into());
    assert!(ui.get_settings_discard_visible() && ui.get_settings_dirty());
    assert_eq!(ui.get_settings_selected_role(), "packPrinter");
    assert_eq!(selections.get(), 0);
    checks.push("unsaved-role-change-prompts".into());
    ui.invoke_cancel_settings_discard();
    assert!(!ui.get_settings_discard_visible());
    assert!(ui.get_settings_dirty());
    assert_eq!(ui.get_settings_ip(), "192.0.2.99");
    checks.push("stay-preserves-draft".into());
    ui.invoke_request_settings_role("boxPrinter".into());
    ui.invoke_confirm_settings_discard();
    assert_eq!(ui.get_settings_selected_role(), "boxPrinter");
    assert!(!ui.get_settings_dirty());
    assert_eq!(selections.get(), 1);
    checks.push("confirmed-discard-selects-role".into());
    ui.set_settings_dirty(true);
    ui.set_scale_settings_dirty(true);
    ui.invoke_request_settings_page(4);
    ui.invoke_request_settings_page(3);
    assert_eq!(ui.get_active_page(), 3);
    assert!(ui.get_settings_dirty() && ui.get_scale_settings_dirty());
    assert_eq!(loads.borrow().len(), 0);
    assert_eq!(scale_loads.get(), 0);
    checks.push("section-navigation-preserves-both-drafts".into());
    ui.invoke_request_settings_reload(false);
    assert!(ui.get_settings_discard_visible());
    assert_eq!(loads.borrow().len(), 0);
    ui.invoke_cancel_settings_discard();
    assert!(ui.get_settings_dirty());
    checks.push("refresh-requires-confirmation".into());
    ui.invoke_request_settings_reload(false);
    ui.invoke_confirm_settings_discard();
    assert!(!ui.get_settings_dirty());
    assert_eq!(loads.borrow().len(), 1);
    ui.set_settings_busy(false);
    ui.invoke_request_settings_reload(true);
    assert!(ui.get_settings_discard_visible());
    ui.invoke_confirm_settings_discard();
    assert!(!ui.get_scale_settings_dirty());
    assert_eq!(scale_loads.get(), 1);
    ui.set_scale_settings_busy(false);
    checks.push("confirmed-refresh-is-scoped-to-section".into());
    ui.invoke_open_settings_diagnostic_role("palletPrinter".into());
    assert_eq!(ui.get_active_page(), 3);
    assert_eq!(loads.borrow().last().unwrap(), "palletPrinter");
    checks.push("diagnostics-selects-role-before-async-load".into());
    ui.invoke_request_settings_page(2);
    assert_eq!(ui.get_active_page(), 3);
    ui.invoke_open_settings_input("printer-ip".into(), "Address".into(), "x".into(), 0);
    assert!(!ui.get_settings_input_keyboard_visible());
    checks.push("busy-state-blocks-navigation-and-input".into());
    ui.set_settings_busy(false);

    let fields: &[(&str, fn(&WeighingPrototype) -> SharedString)] = &[
        ("printer-ip", WeighingPrototype::get_settings_ip),
        ("printer-port", WeighingPrototype::get_settings_port),
        ("printer-baud", WeighingPrototype::get_settings_baud_rate),
        ("scale-host", WeighingPrototype::get_scale_settings_host),
        ("scale-port", WeighingPrototype::get_scale_settings_port),
        (
            "scale-baud",
            WeighingPrototype::get_scale_settings_baud_rate,
        ),
        (
            "scale-polling",
            WeighingPrototype::get_scale_settings_polling,
        ),
        (
            "scale-samples",
            WeighingPrototype::get_scale_settings_stability_count,
        ),
    ];
    for (i, (target, getter)) in fields.iter().enumerate() {
        ui.set_settings_dirty(false);
        ui.set_scale_settings_dirty(false);
        let before = fields.iter().map(|(_, get)| get(&ui)).collect::<Vec<_>>();
        let draft = format!("{}", 101 + i);
        ui.invoke_open_settings_input((*target).into(), "Field".into(), getter(&ui), 2);
        assert!(ui.get_settings_input_keyboard_visible());
        ui.set_settings_input_draft(draft.clone().into());
        ui.invoke_accept_settings_input();
        assert_eq!(getter(&ui).as_str(), draft);
        assert!(!ui.get_settings_input_keyboard_visible());
        assert_eq!(ui.get_scale_settings_dirty(), target.starts_with("scale-"));
        assert_eq!(ui.get_settings_dirty(), target.starts_with("printer-"));
        for (j, (_, get)) in fields.iter().enumerate() {
            if i != j {
                assert_eq!(get(&ui), before[j], "unrelated field changed");
            }
        }
        checks.push(format!("keyboard-{target}"));
    }
    ui.set_settings_dirty(false);
    ui.set_scale_settings_dirty(false);
    ui.invoke_open_settings_input(
        "printer-ip".into(),
        "Address".into(),
        ui.get_settings_ip(),
        0,
    );
    ui.invoke_accept_settings_input();
    assert!(!ui.get_settings_dirty());
    checks.push("unchanged-keyboard-value-is-not-dirty".into());
    ui.invoke_open_settings_input(
        "printer-ip".into(),
        "Address".into(),
        ui.get_settings_ip(),
        0,
    );
    ui.set_settings_input_draft("Pending".into());
    ui.set_settings_busy(true);
    ui.invoke_accept_settings_input();
    assert!(ui.get_settings_input_keyboard_visible());
    assert_ne!(ui.get_settings_ip(), "Pending");
    ui.set_settings_busy(false);
    ui.invoke_accept_settings_input();
    assert_eq!(ui.get_settings_ip(), "Pending");
    checks.push("pending-keyboard-accept-waits-for-load".into());
    ui.set_settings_dirty(false);
    ui.set_scale_settings_dirty(false);
    ui.invoke_open_settings_input("device-search".into(), "Search".into(), "".into(), 0);
    ui.set_settings_input_draft("COM3".into());
    ui.invoke_accept_settings_input();
    assert_eq!(ui.get_settings_picker_search(), "COM3");
    assert!(!ui.get_settings_dirty() && !ui.get_scale_settings_dirty());
    checks.push("search-keyboard-does-not-change-settings".into());

    ui.set_settings_picker_target("printer".into());
    ui.invoke_select_settings_device("Test Windows printer".into(), "".into(), "".into(), 0);
    assert_eq!(ui.get_settings_driver_name(), "Test Windows printer");
    assert!(ui.get_settings_dirty());
    assert_eq!(ui.get_settings_picker_target(), "");
    checks.push("device-selection-updates-printer-only".into());
    ui.set_settings_dirty(false);
    ui.set_settings_picker_target("printer".into());
    ui.invoke_select_settings_device("".into(), "".into(), "".into(), 0);
    assert_eq!(ui.get_settings_driver_name(), "");
    assert!(ui.get_settings_dirty());
    checks.push("default-windows-printer-is-selectable".into());
    ui.set_settings_picker_target("printer-serial".into());
    ui.set_settings_busy(true);
    let before = ui.get_settings_serial_port();
    ui.invoke_select_settings_device("COM9".into(), "".into(), "".into(), 0);
    assert_eq!(ui.get_settings_serial_port(), before);
    assert_eq!(ui.get_settings_picker_target(), "printer-serial");
    ui.set_settings_busy(false);
    ui.invoke_select_settings_device("COM9".into(), "".into(), "".into(), 0);
    assert_eq!(ui.get_settings_serial_port(), "COM9");
    checks.push("serial-choice-honors-busy-state".into());
    ui.set_scale_settings_protocol("generic".into());
    ui.set_scale_settings_baud_rate("115200".into());
    ui.set_settings_picker_target("scale-protocol".into());
    ui.invoke_select_settings_device("generic".into(), "Generic".into(), "".into(), 9600);
    assert_eq!(ui.get_scale_settings_baud_rate(), "115200");
    checks.push("same-protocol-preserves-custom-baud".into());
    ui.set_settings_picker_target("scale-protocol".into());
    ui.invoke_select_settings_device(
        "cas".into(),
        "CAS".into(),
        "Protocol description".into(),
        19200,
    );
    assert_eq!(ui.get_scale_settings_protocol(), "cas");
    assert_eq!(ui.get_scale_settings_protocol_name(), "CAS");
    assert_eq!(ui.get_scale_settings_baud_rate(), "19200");
    assert!(ui.get_scale_settings_dirty());
    checks.push("new-protocol-sets-default-baud".into());

    let choices = ModelRc::new(VecModel::from(vec![
        PrinterChoiceRow {
            value: "COM3".into(),
            label: "Принтер Упаковки".into(),
            details: "USB".into(),
        },
        PrinterChoiceRow {
            value: "COM7".into(),
            label: "Весы".into(),
            details: "USB".into(),
        },
    ]));
    assert_eq!(
        ui.invoke_filter_settings_devices(choices.clone(), "упакОВки com3".into())
            .row_count(),
        1
    );
    assert_eq!(
        ui.invoke_filter_settings_devices(choices.clone(), " ".into())
            .row_count(),
        2
    );
    assert_eq!(
        ui.invoke_filter_settings_devices(choices, "nothing matches".into())
            .row_count(),
        0
    );
    checks.push("device-model-search-and-empty-results".into());
    let protocols = ModelRc::new(VecModel::from(vec![
        ScaleProtocolRow {
            id: "generic".into(),
            name: "Generic".into(),
            default_baud_rate: 9600,
            ..Default::default()
        },
        ScaleProtocolRow {
            id: "simulator".into(),
            ..Default::default()
        },
    ]));
    assert_eq!(
        ui.invoke_filter_settings_protocols(protocols.clone(), "".into())
            .row_count(),
        1
    );
    assert_eq!(
        ui.invoke_filter_settings_protocols(protocols, "9600".into())
            .row_count(),
        1
    );
    checks.push("protocol-search-excludes-simulator".into());
    let jobs = ModelRc::new(VecModel::from(
        [
            "queued",
            "rendering",
            "sending",
            "accepted",
            "failed",
            "uncertain",
            "cancelled",
        ]
        .into_iter()
        .map(|state| PrintQueueRow {
            state: state.into(),
            ..Default::default()
        })
        .collect::<Vec<_>>(),
    ));
    for (filter, count) in [("all", 7), ("active", 3), ("problems", 2), ("accepted", 1)] {
        assert_eq!(
            ui.invoke_filter_settings_jobs(jobs.clone(), filter.into())
                .row_count(),
            count
        );
    }
    checks.push("queue-model-filters-all-states".into());
    Ok(checks)
}
