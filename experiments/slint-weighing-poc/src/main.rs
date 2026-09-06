#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use labelpilot_core::native_ui::{Event as CoreEvent, NativeUiRuntime};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    env,
    rc::Rc,
    sync::mpsc::{self, TryRecvError},
    thread,
    time::Duration,
};

slint::include_modules!();

enum UiMessage {
    Core(CoreEvent),
    PrintFinished {
        repeat: bool,
        number: String,
        outcome: Result<Value, String>,
    },
}

fn show_toast(ui: &WeighingPrototype, message: &str) {
    ui.set_toast_text(message.into());
    ui.set_toast_visible(true);
    let weak = ui.as_weak();
    slint::Timer::single_shot(Duration::from_millis(1_800), move || {
        if let Some(ui) = weak.upgrade() {
            ui.set_toast_visible(false);
        }
    });
}

fn show_alert(ui: &WeighingPrototype, message: &str) {
    ui.set_alert_text(message.into());
    ui.set_alert_visible(true);
}

fn has_argument(argument: &str) -> bool {
    env::args_os().any(|value| value == argument)
}

fn native_runtime_enabled() -> bool {
    has_argument("--native-runtime") || env::var_os("LABELPILOT_SLINT_NATIVE_RUNTIME").is_some()
}

fn live_weight_enabled() -> bool {
    has_argument("--live-weight") || env::var_os("LABELPILOT_SLINT_LIVE_WEIGHT").is_some()
}

fn scale_config() -> Value {
    match (
        env::var("LABELPILOT_SCALE_HOST").ok(),
        env::var("LABELPILOT_SCALE_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok()),
    ) {
        (Some(host), Some(port)) => json!({
            "type": "tcp",
            "protocolId": env::var("LABELPILOT_SCALE_PROTOCOL")
                .unwrap_or_else(|_| "generic".to_owned()),
            "host": host,
            "port": port,
            "pollingInterval": 120,
            "stabilityCount": 4
        }),
        _ => json!({
            "type": "simulator",
            "protocolId": "simulator",
            "pollingInterval": 120,
            "stabilityCount": 4
        }),
    }
}

fn printer_config() -> Value {
    json!({
        "id": "slint-weighing",
        "active": true,
        "name": "Slint ZPL virtual printer",
        "connection": "tcp",
        "protocol": "zpl",
        "ip": env::var("LABELPILOT_PRINTER_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned()),
        "port": env::var("LABELPILOT_PRINTER_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(9100),
        "persistentConnection": true
    })
}

fn zpl_test_label(number: &str, gross_weight: &str) -> Vec<u8> {
    let barcode: String = number.chars().filter(char::is_ascii_digit).collect();
    let barcode = if barcode.is_empty() {
        "000000000001"
    } else {
        barcode.as_str()
    };
    format!(
        "^XA^CI28^PW600^LL360^LH0,0\n\
         ^FO28,24^A0N,34,34^FDLabelPilot Slint / Rust core^FS\n\
         ^FO28,78^A0N,25,25^FDPackage: {number}^FS\n\
         ^FO28,116^A0N,25,25^FDGross: {gross_weight} kg^FS\n\
         ^FO55,170^BY2,3,86^BCN,86,Y,N,N^FD{barcode}^FS\n\
         ^XZ"
    )
    .into_bytes()
}

fn apply_core_event(ui: &WeighingPrototype, event: CoreEvent) {
    match event {
        CoreEvent::Event { name, payload } if name == "scale-reading" => {
            if let Some(weight) = payload.get("weight").and_then(Value::as_f64) {
                ui.set_gross_weight(format!("{weight:.3}").into());
                ui.set_net_weight(format!("{:.3}", (weight - 0.042).max(0.0)).into());
            }
            ui.set_stable(
                payload
                    .get("stable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
        }
        CoreEvent::Event { name, payload } if name == "scale-error" => {
            let message = payload
                .as_str()
                .unwrap_or("Ошибка подключения промышленных весов");
            show_alert(ui, message);
        }
        CoreEvent::Event { name, payload } if name == "printer-status-update" => {
            if payload.get("status").and_then(Value::as_str) == Some("error") {
                show_alert(ui, "Ошибка транспорта принтера");
            }
        }
        CoreEvent::Log {
            subsystem,
            level,
            message,
        } if level == "ERROR" || level == "WARN" => {
            show_alert(ui, &format!("{subsystem}: {message}"));
        }
        _ => {}
    }
}

fn sync_adaptive_layout(ui: &WeighingPrototype) {
    let scale_factor = ui.window().scale_factor().max(f32::EPSILON);
    let size = ui.window().size();
    let width = size.width as f32 / scale_factor;
    let height = size.height as f32 / scale_factor;
    ui.set_compact(width < 1280.0);
    ui.set_narrow(width < 1120.0);
    ui.set_short(height < 720.0);
}

fn main() -> Result<(), slint::PlatformError> {
    let ui = WeighingPrototype::new()?;
    let initial_width = env::var("LABELPILOT_SLINT_WINDOW_WIDTH")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(1366.0);
    let initial_height = env::var("LABELPILOT_SLINT_WINDOW_HEIGHT")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(768.0);
    ui.window()
        .set_size(slint::LogicalSize::new(initial_width, initial_height));
    if env::var_os("LABELPILOT_SLINT_WINDOWED").is_none()
        && env::var_os("LABELPILOT_SLINT_SELF_TEST").is_none()
    {
        ui.window().set_fullscreen(true);
    }
    sync_adaptive_layout(&ui);
    let (message_tx, message_rx) = mpsc::channel::<UiMessage>();

    let runtime = if native_runtime_enabled() {
        let callback_tx = message_tx.clone();
        let runtime = NativeUiRuntime::new(move |event| {
            let _ = callback_tx.send(UiMessage::Core(event));
        });
        if let Err(error) = runtime.connect_scale(scale_config()) {
            let _ = message_tx.send(UiMessage::Core(CoreEvent::Log {
                subsystem: "scale".to_owned(),
                level: "ERROR".to_owned(),
                message: error,
            }));
        }
        Some(runtime)
    } else {
        None
    };

    ui.on_print_label({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if let Some(runtime) = runtime.clone() {
                let number = ui.get_pack_number().to_string();
                let gross_weight = ui.get_gross_weight().to_string();
                show_toast(&ui, "Этикетка передана в Rust-очередь");
                let message_tx = message_tx.clone();
                thread::spawn(move || {
                    let outcome =
                        runtime.send_raw(printer_config(), zpl_test_label(&number, &gross_weight));
                    let _ = message_tx.send(UiMessage::PrintFinished {
                        repeat: false,
                        number,
                        outcome,
                    });
                });
                return;
            }

            let units = ui.get_units_in_box() + 1;
            ui.set_units_in_box(units);
            ui.set_total_units(ui.get_total_units() + 1);
            ui.set_last_print(format!("#01000247 · {}", chrono_like_time()).into());
            show_toast(&ui, "Этикетка отправлена в очередь");
        }
    });

    ui.on_repeat_print({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if let Some(runtime) = runtime.clone() {
                let number = ui.get_pack_number().to_string();
                let gross_weight = ui.get_gross_weight().to_string();
                show_toast(&ui, "Повтор передан в Rust-очередь");
                let message_tx = message_tx.clone();
                thread::spawn(move || {
                    let outcome =
                        runtime.send_raw(printer_config(), zpl_test_label(&number, &gross_weight));
                    let _ = message_tx.send(UiMessage::PrintFinished {
                        repeat: true,
                        number,
                        outcome,
                    });
                });
            } else {
                show_toast(&ui, "Последняя этикетка отправлена повторно");
            }
        }
    });

    ui.on_close_box({
        let weak = ui.as_weak();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if ui.get_units_in_box() == 0 {
                show_alert(&ui, "В текущем коробе ещё нет упаковок");
                return;
            }
            ui.set_boxes_on_pallet(ui.get_boxes_on_pallet() + 1);
            ui.set_units_in_box(0);
            ui.set_box_number(format!("0100{:04}", ui.get_boxes_on_pallet() + 24).into());
            show_toast(&ui, "Короб закрыт, коробная этикетка сформирована");
        }
    });

    ui.on_print_pallet({
        let weak = ui.as_weak();
        move || {
            if let Some(ui) = weak.upgrade() {
                show_toast(&ui, "Паллетный лист сформирован");
            }
        }
    });

    ui.on_quit_app(|| {
        let _ = slint::quit_event_loop();
    });
    ui.on_delete_last({
        let weak = ui.as_weak();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if ui.get_units_in_box() == 0 {
                show_alert(&ui, "В текущем коробе нет упаковок для удаления");
                return;
            }
            ui.set_units_in_box(ui.get_units_in_box() - 1);
            ui.set_total_units((ui.get_total_units() - 1).max(0));
            show_toast(&ui, "Последняя упаковка удалена");
        }
    });

    if env::var_os("LABELPILOT_SLINT_SELF_TEST").is_some() {
        let initial_total = ui.get_total_units();
        let initial_boxes = ui.get_boxes_on_pallet();
        ui.invoke_print_label();
        assert_eq!(ui.get_units_in_box(), 8);
        assert_eq!(ui.get_total_units(), initial_total + 1);
        assert!(ui.get_toast_visible());

        ui.invoke_repeat_print();
        assert!(ui.get_toast_text().contains("повторно"));

        ui.invoke_close_box();
        assert_eq!(ui.get_units_in_box(), 0);
        assert_eq!(ui.get_boxes_on_pallet(), initial_boxes + 1);

        ui.invoke_close_box();
        assert!(ui.get_alert_visible());
        ui.set_alert_visible(false);

        ui.set_units_in_box(1);
        ui.invoke_delete_last();
        assert_eq!(ui.get_units_in_box(), 0);
        assert_eq!(ui.get_total_units(), initial_total);

        ui.invoke_print_pallet();
        assert!(ui.get_toast_text().contains("Паллетный"));
        std::process::exit(0);
    }

    let adaptive_timer = slint::Timer::default();
    {
        let weak = ui.as_weak();
        adaptive_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(100),
            move || {
                if let Some(ui) = weak.upgrade() {
                    sync_adaptive_layout(&ui);
                }
            },
        );
    }

    let event_timer = slint::Timer::default();
    if runtime.is_some() {
        let weak = ui.as_weak();
        event_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(30),
            move || loop {
                match message_rx.try_recv() {
                    Ok(UiMessage::Core(event)) => {
                        if let Some(ui) = weak.upgrade() {
                            apply_core_event(&ui, event);
                        }
                    }
                    Ok(UiMessage::PrintFinished {
                        repeat,
                        number,
                        outcome,
                    }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        match outcome {
                            Ok(_) if repeat => {
                                ui.set_last_print(
                                    format!("#{number} · {}", chrono_like_time()).into(),
                                );
                                show_toast(&ui, "Этикетка повторно принята принтером");
                            }
                            Ok(_) => {
                                ui.set_units_in_box(ui.get_units_in_box() + 1);
                                ui.set_total_units(ui.get_total_units() + 1);
                                ui.set_last_print(
                                    format!("#{number} · {}", chrono_like_time()).into(),
                                );
                                show_toast(&ui, "Принтер принял этикетку");
                            }
                            Err(error) => show_alert(&ui, &format!("Печать: {error}")),
                        }
                    }
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                }
            },
        );
    }

    // Kept only for the original UI-only benchmark; native mode always uses ScaleState.
    let live_weight_timer = slint::Timer::default();
    if runtime.is_none() && live_weight_enabled() {
        let weak = ui.as_weak();
        let tick = Rc::new(Cell::new(0_u32));
        let tick_for_timer = Rc::clone(&tick);
        live_weight_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(120),
            move || {
                let Some(ui) = weak.upgrade() else { return };
                let next = tick_for_timer.get().wrapping_add(1);
                tick_for_timer.set(next);
                let grams = 3_406_i32 + ((next % 7) as i32 - 3);
                let gross = grams as f32 / 1_000.0;
                ui.set_gross_weight(format!("{gross:.3}").into());
                ui.set_net_weight(format!("{:.3}", (gross - 0.042).max(0.0)).into());
                ui.set_stable(next % 9 >= 3);
            },
        );
    }
    let result = ui.run();
    if let Some(runtime) = &runtime {
        runtime.shutdown();
    }
    result
}

fn chrono_like_time() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    let seconds_in_day = seconds % 86_400;
    format!(
        "{:02}:{:02}:{:02}",
        seconds_in_day / 3_600,
        (seconds_in_day % 3_600) / 60,
        seconds_in_day % 60
    )
}
