//! Snapshot the real settings pages with synthetic data and no native runtime.
#[path = "support/settings_checks.rs"]
mod settings_checks;

use labelpilot_tauri_lib::slint_runtime::{
    PrintQueueRow, PrinterChoiceRow, PrinterDiagnosticRow, PrinterSettingsRoleRow,
    ScaleProtocolRow, WeighingPrototype,
};
use serde::Deserialize;
use serde_json::json;
use slint::{ComponentHandle, Model, ModelRc, VecModel};
use std::{cell::RefCell, path::PathBuf, rc::Rc, time::Duration};

#[derive(Deserialize)]
#[serde(default)]
struct Fixture {
    page: i32,
    connection: String,
    advanced: bool,
    dirty: bool,
    language: String,
    dark: bool,
    preferences: bool,
    empty: bool,
    scroll: bool,
    section: i32,
    picker: String,
    query: String,
    filter: String,
    busy: bool,
    keyboard: bool,
    discard: bool,
    long_text: bool,
    locale_audit: bool,
    alert: bool,
}
impl Default for Fixture {
    fn default() -> Self {
        Self {
            page: 3,
            connection: "windows_driver".into(),
            advanced: false,
            dirty: false,
            language: "ru".into(),
            dark: false,
            preferences: false,
            empty: false,
            scroll: false,
            section: 0,
            picker: String::new(),
            query: String::new(),
            filter: "all".into(),
            busy: false,
            keyboard: false,
            discard: false,
            long_text: false,
            locale_audit: false,
            alert: false,
        }
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err("usage: settings_ui_probe <fixture.json> <output.png> <width> <height>".into());
    }
    let f: Fixture = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let path = PathBuf::from(&args[1]);
    let width: f32 = args[2].parse()?;
    let height: f32 = args[3].parse()?;
    if !width.is_finite()
        || !height.is_finite()
        || !(1024.0..=3840.0).contains(&width)
        || !(600.0..=2160.0).contains(&height)
    {
        return Err("unsupported viewport".into());
    }
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    if std::env::var_os("SLINT_BACKEND").is_none() {
        std::env::set_var("SLINT_BACKEND", "winit-skia-opengl");
    }
    let mut callback_checks = settings_checks::verify()?;
    callback_checks.extend(settings_checks::verify_preferences(&path.with_extension("preferences-data"))?);
    let ui = WeighingPrototype::new()?;
    ui.set_kiosk_mode(false);
    ui.set_compact(width < 1280.0);
    ui.set_narrow(width < 1120.0);
    ui.set_short(height < 720.0);
    ui.set_wide(width >= 1600.0);
    ui.set_tall(height >= 900.0);
    ui.set_operator_login_visible(false);
    ui.set_operator_name("Оператор".into());
    ui.set_station_number("02".into());
    ui.set_server_online(true);
    labelpilot_tauri_lib::slint_runtime::initialize_ui_preferences(&ui, None);
    ui.invoke_change_ui_language(f.language.clone().into());
    ui.invoke_change_ui_theme(f.dark);
    if f.preferences { ui.invoke_open_preferences(); }
    ui.set_update_current_version(env!("CARGO_PKG_VERSION").into());
    ui.set_active_page(f.page);
    ui.set_settings_active(true);
    ui.set_settings_connection(f.connection.clone().into());
    ui.set_settings_name("Основной принтер упаковок".into());
    ui.set_settings_ip("192.0.2.50".into());
    ui.set_settings_driver_name("Принтер этикеток — производственная линия № 2".into());
    ui.set_settings_serial_port("COM3".into());
    ui.set_settings_protocol("zpl".into());
    ui.set_settings_advanced_visible(f.advanced);
    ui.set_settings_dirty(f.dirty);
    ui.set_settings_auto_print(false);
    ui.set_settings_status("Настройки загружены · 14:32:08".into());
    ui.set_settings_width_mm("58".into());
    ui.set_settings_height_mm("40".into());
    ui.set_settings_gap_mm("2".into());
    let roles = ["packPrinter", "boxPrinter", "palletPrinter"]
        .into_iter()
        .enumerate()
        .map(|(i, role)| PrinterSettingsRoleRow {
            role: role.into(),
            role_label: ["Упаковка", "Короб", "Паллета"][i].into(),
            active: i != 2,
            connection: "Driver".into(),
            name: format!("Принтер {}", i + 1).into(),
            ..Default::default()
        })
        .collect::<Vec<_>>();
    ui.set_printer_settings_roles(ModelRc::new(VecModel::from(roles)));
    let choices = if f.empty {
        vec![]
    } else {
        (1..=9)
            .map(|i| PrinterChoiceRow {
                value: format!("COM{i}").into(),
                label: format!("COM{i} — USB Serial Port").into(),
                details: "USB · измерительное оборудование".into(),
            })
            .collect::<Vec<_>>()
    };
    ui.set_settings_serial_ports(ModelRc::new(VecModel::from(choices.clone())));
    ui.set_scale_settings_serial_ports(ModelRc::new(VecModel::from(choices)));
    let printers = if f.empty {
        vec![]
    } else {
        (1..=8)
            .map(|i| PrinterChoiceRow {
                value: format!("Принтер этикеток — производственная линия № {i}").into(),
                label: format!("Принтер этикеток — производственная линия № {i}").into(),
                details: if i == 2 {
                    "По умолчанию · USB".into()
                } else {
                    "Windows · USB".into()
                },
            })
            .collect::<Vec<_>>()
    };
    ui.set_settings_system_printers(ModelRc::new(VecModel::from(printers)));
    ui.set_scale_settings_connection(
        if f.connection == "windows_driver" {
            "serial"
        } else {
            &f.connection
        }
        .into(),
    );
    ui.set_scale_settings_protocol("generic".into());
    ui.set_scale_settings_protocol_name("Generic Text".into());
    ui.set_scale_settings_protocol_description(
        "Универсальный текстовый протокол: стабильный вес, единицы измерения и статус устройства"
            .into(),
    );
    ui.set_scale_settings_serial_path("COM3".into());
    ui.set_scale_settings_host("192.0.2.20".into());
    ui.set_scale_settings_endpoint("COM3 · 9600 baud".into());
    ui.set_scale_settings_runtime_status("connected".into());
    ui.set_scale_settings_status("Настройки загружены · 14:32:08".into());
    ui.set_scale_settings_dirty(f.dirty);
    let protocols = if f.empty {
        vec![]
    } else {
        ["generic", "cas", "mettler", "sartorius", "aandd", "ohaus"]
            .into_iter()
            .map(|id| ScaleProtocolRow {
                id: id.into(),
                name: id.to_uppercase().into(),
                description: "Текстовый протокол весов, стабильность и единицы измерения".into(),
                default_baud_rate: 9600,
                serial_format: "8N1".into(),
                polling_required: false,
            })
            .collect::<Vec<_>>()
    };
    ui.set_scale_settings_protocols(ModelRc::new(VecModel::from(protocols)));
    let jobs = if f.empty {
        vec![]
    } else {
        ["failed", "uncertain", "queued", "accepted"].into_iter().enumerate().map(|(i, state)| PrintQueueRow {
        job_id: format!("fixture-{i}").into(), short_id: format!("0000{i}").into(), state: state.into(),
        state_label: ["Ошибка", "Не подтверждено", "В очереди", "Принято"][i].into(),
        printer_name: "Принтер этикеток — производственная линия № 2".into(), route: "ZPL / TCP".into(),
        action: "Печать".into(), payload: "58.0 KiB".into(), attempts: 1,
        updated: "08.09.2026 14:32:08".into(), error: if i < 2 { "Нет подтверждения от принтера. Проверьте подключение кабеля, наличие этикеток и состояние оборудования перед повторной отправкой задания.".into() } else { "".into() },
        can_retry: i < 2, can_cancel: i < 3, uncertain: i == 1, good: i == 3, warning: i == 1,
    }).collect::<Vec<_>>()
    };
    ui.set_queue_total(jobs.len() as i32);
    ui.set_queue_waiting(if f.empty { 0 } else { 1 });
    ui.set_queue_accepted(if f.empty { 0 } else { 1 });
    ui.set_queue_problems(if f.empty { 0 } else { 2 });
    ui.set_durable_jobs(ModelRc::new(VecModel::from(jobs)));
    ui.set_queue_status("Последнее обновление · 14:32:08".into());
    let diagnostics = if f.empty {
        vec![]
    } else {
        ["packPrinter", "boxPrinter", "palletPrinter"].into_iter().enumerate().map(|(i, role)| PrinterDiagnosticRow {
        role: role.into(), role_label: ["Упаковка", "Короб", "Паллета"][i].into(), printer_name: "Принтер этикеток — производственная линия № 2".into(),
        endpoint: "192.0.2.50:9100".into(), transport: "TCP".into(), status: ["ok", "error", "not_configured"][i].into(),
        status_label: ["Доступен", "Нет соединения", "Не настроен"][i].into(),
        details: if i == 1 { "Соединение не установлено за 5 секунд. Проверьте адрес, кабель, питание принтера и доступность порта 9100.".into() } else { "Проверка подключения завершена".into() },
        reachable: i == 0, configured: i < 2, queried: "14:32:08".into(),
    }).collect::<Vec<_>>()
    };
    ui.set_printer_diagnostics(ModelRc::new(VecModel::from(diagnostics)));
    ui.set_diagnostics_status("Проверено 3 устройства · 14:32:08".into());
    labelpilot_tauri_lib::slint_runtime::initialize_settings_models(&ui);
    ui.set_settings_printer_section(f.section);
    ui.set_settings_scale_section(f.section);
    ui.set_settings_picker_target(f.picker.clone().into());
    ui.set_settings_picker_search(f.query.clone().into());
    ui.set_settings_queue_filter(f.filter.clone().into());
    if f.long_text {
        let name =
            "Принтер этикеток производственной линии со специальными параметрами подключения "
                .repeat(4);
        ui.set_settings_driver_name(name.clone().into());
        let devices = ui.get_settings_system_printers();
        if let Some(mut row) = devices.row_data(0) {
            row.label = name.clone().into();
            devices.set_row_data(0, row);
        }
        let jobs = ui.get_durable_jobs();
        if let Some(mut row) = jobs.row_data(0) {
            row.printer_name = name.clone().into();
            row.error = "Проверьте питание и сетевое подключение принтера. "
                .repeat(12)
                .into();
            jobs.set_row_data(0, row);
        }
        let devices = ui.get_printer_diagnostics();
        if let Some(mut row) = devices.row_data(1) {
            row.printer_name = name.into();
            row.details = "Проверьте адрес устройства, кабель и доступность порта. "
                .repeat(12)
                .into();
            devices.set_row_data(1, row);
        }
    }
    if f.keyboard {
        ui.invoke_open_settings_input(
            "printer-port".into(),
            "Порт принтера".into(),
            ui.get_settings_port(),
            2,
        );
    }
    if f.discard {
        if f.page == 4 {
            ui.set_scale_settings_dirty(true);
        } else {
            ui.set_settings_dirty(true);
        }
        ui.invoke_request_settings_reload(f.page == 4);
    }
    if f.busy {
        match f.page {
            1 => ui.set_queue_busy(true),
            2 => ui.set_diagnostics_busy(true),
            4 => ui.set_scale_settings_busy(true),
            _ => ui.set_settings_busy(true),
        }
    }

    if f.locale_audit {
        ui.set_settings_active((1..=4).contains(&f.page));
        ui.set_product_name("МӘРМӘР СИЫР / СТЕЙК НЬЮ-ЙОРК".into());
        ui.set_product_article("22171111".into());
        ui.set_scale_status("Весы: подключены".into());
        ui.set_printer_status("Принтер: недоступен".into());
        ui.set_fixed_status("Товар готов · установите упаковку на весы".into());
        ui.set_fixed_product_name("МӘРМӘР СИЫР / СТЕЙК НЬЮ-ЙОРК".into());
        ui.set_queue_status("424 заданий · обновлено 08:12:14".into());
        ui.set_settings_status("Системные устройства обновлены · 08:11:37".into());
        ui.set_license_status("Связь установлена · проверено 08:11:13".into());
        ui.set_license_server_online(true);
        ui.set_license_server_configured(true);
        ui.set_license_server_compatible(true);
        ui.set_license_server_version("1.1.32".into());
        ui.set_license_min_client_version("1.3.12".into());
        ui.set_license_station_name("Station 192.0.2.20".into());
        ui.set_license_active(true);
        ui.set_license_expires("Бессрочно".into());
        ui.set_license_stations("1 · без лимита".into());
        ui.set_license_features("Функции не указаны".into());
        ui.set_license_signature("Обычный режим".into());
        ui.set_update_status("Установлена актуальная версия".into());
        let error = "Операция repeat: TCP printer connect 127.0.0.1:9100: Подключение не установлено, т.к. конечный компьютер отверг запрос на подключение. (os error 10061)";
        ui.set_alert_text(error.into());
        ui.set_alert_visible(f.alert);
        let jobs = ui.get_durable_jobs();
        if let Some(mut job) = jobs.row_data(0) {
            job.state_label = "НЕЯСНО".into();
            job.updated = "1 мин назад".into();
            job.action = "Этикетка".into();
            job.route = "ZPL / TCP".into();
            job.payload = "58.0 KiB".into();
            job.error = error.into();
            job.uncertain = true;
            job.warning = true;
            jobs.set_row_data(0, job);
        }
        for (language, expected) in [
            ("de", "424 Aufträge · aktualisiert 08:12:14"),
            ("en", "424 jobs · updated 08:12:14"),
            ("uk", "424 завдань · оновлено 08:12:14"),
            ("ru", "424 заданий · обновлено 08:12:14"),
            ("de", "424 Aufträge · aktualisiert 08:12:14"),
        ] {
            ui.invoke_change_ui_language(language.into());
            assert_eq!(ui.get_localized_queue_status().as_str(), expected);
            assert_eq!(ui.get_queue_status().as_str(), "424 заданий · обновлено 08:12:14");
            assert_eq!(ui.get_product_name().as_str(), "МӘРМӘР СИЫР / СТЕЙК НЬЮ-ЙОРК");
        }
        assert!(ui.get_localized_alert_text().contains("Verbindung abgelehnt (os error 10061)"));
        ui.invoke_change_ui_language(f.language.clone().into());
        callback_checks.push("live-locales-de-en-uk-ru-de-preserve-model-data".into());
    }

    ui.window().set_size(slint::LogicalSize::new(width, height));
    ui.window()
        .set_position(slint::LogicalPosition::new(-20000.0, -20000.0));
    ui.show()?;
    let result = Rc::new(RefCell::new(None));
    if f.scroll {
        let weak = ui.as_weak();
        let r = result.clone();
        slint::Timer::single_shot(Duration::from_millis(400), move || {
            if let Some(ui) = weak.upgrade() {
                if let Err(e) =
                    ui.window()
                        .try_dispatch_event(slint::platform::WindowEvent::PointerScrolled {
                            position: slint::LogicalPosition::new(width * 0.6, height * 0.65),
                            delta_x: 0.0,
                            delta_y: -100000.0,
                        })
                {
                    *r.borrow_mut() = Some(Err(e.to_string()));
                    let _ = slint::quit_event_loop();
                }
            }
        });
    }
    let r = result.clone();
    let weak = ui.as_weak();
    slint::Timer::single_shot(Duration::from_millis(900), move || {
        let outcome = (|| -> Result<(), String> {
            let ui = weak.upgrade().ok_or("window closed")?;
            let pixels = ui.window().take_snapshot().map_err(|e| e.to_string())?;
            image::save_buffer(
                &path,
                pixels.as_bytes(),
                pixels.width(),
                pixels.height(),
                image::ColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
            let meta = json!({"page": f.page, "connection": f.connection, "section": f.section, "picker": f.picker, "language": f.language, "dark": f.dark, "preferences": f.preferences, "logical_size": [width, height], "physical_size": [pixels.width(), pixels.height()], "scale_factor": ui.window().scale_factor(), "flags": {"query": f.query, "filter": f.filter, "busy": f.busy, "keyboard": f.keyboard, "discard": f.discard, "long_text": f.long_text}, "runtime_started": false, "callback_checks": callback_checks});
            std::fs::write(
                path.with_extension("json"),
                serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            println!("{}", meta);
            Ok(())
        })();
        *r.borrow_mut() = Some(outcome);
        let _ = slint::quit_event_loop();
    });
    slint::run_event_loop()?;
    let outcome = result.borrow_mut().take().ok_or("snapshot did not run")?;
    outcome.map_err(Into::into)
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
