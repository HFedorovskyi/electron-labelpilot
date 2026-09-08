//! Render the real weighing UI with fixture data, without starting a runtime,
//! database, network client, scale, or printer. The window stays off-screen.
use labelpilot_tauri_lib::slint_runtime::WeighingPrototype;
use serde::Deserialize;
use serde_json::json;
use slint::ComponentHandle;
use std::{cell::RefCell, path::PathBuf, rc::Rc, time::Duration};

#[derive(Deserialize)]
struct Fixture {
    name: String,
    article: String,
    expiration_days: i32,
    station_number: String,
    operator_name: String,
    #[serde(default)]
    scroll_to_bottom: bool,
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 5 || !matches!(args[4].as_str(), "online" | "offline") {
        return Err("usage: weighing_ui_probe <fixture.json> <output.png> <width> <height> <online|offline>".into());
    }
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let path = PathBuf::from(&args[1]);
    let width: f32 = args[2].parse()?;
    let height: f32 = args[3].parse()?;
    if !width.is_finite()
        || !height.is_finite()
        || !(1024.0..=3840.0).contains(&width)
        || !(600.0..=2160.0).contains(&height)
    {
        return Err("logical window size is outside 1024x600..3840x2160".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::env::var_os("SLINT_BACKEND").is_none() {
        std::env::set_var("SLINT_BACKEND", "winit-skia-opengl");
    }
    let ui = WeighingPrototype::new()?;
    ui.set_kiosk_mode(false);
    ui.set_compact(width < 1280.0);
    ui.set_narrow(width < 1120.0);
    ui.set_short(height < 720.0);
    ui.set_wide(width >= 1600.0);
    ui.set_tall(height >= 900.0);
    ui.set_operator_login_visible(false);
    ui.set_product_name(fixture.name.into());
    ui.set_product_article(fixture.article.into());
    ui.set_expiration_days(fixture.expiration_days);
    ui.set_station_number(fixture.station_number.into());
    ui.set_operator_name(fixture.operator_name.into());
    ui.set_server_online(args[4] == "online");
    ui.set_update_current_version(env!("CARGO_PKG_VERSION").into());
    ui.set_gross_weight("3.131".into());
    ui.set_net_weight("3.121".into());
    ui.set_stable(true);
    ui.set_units_in_box(2);
    ui.set_box_limit(10);
    ui.set_box_number("0288".into());
    ui.set_pack_number("02000631".into());
    ui.set_boxes_on_pallet(45);
    ui.set_total_units(631);
    ui.set_labeling_date("08.09.2026".into());
    // Exercise the same callback the picker TouchArea invokes.
    ui.invoke_open_product_picker();
    assert!(ui.get_alert_visible() && !ui.get_product_modal_visible());
    ui.set_alert_visible(false);
    ui.set_units_in_box(0);
    ui.set_product_selection_busy(true);
    ui.invoke_open_product_picker();
    assert!(ui.get_alert_visible() && !ui.get_product_modal_visible());
    ui.set_alert_visible(false);
    ui.set_product_selection_busy(false);
    ui.invoke_open_product_picker();
    assert!(ui.get_product_modal_visible() && !ui.get_alert_visible());
    ui.set_product_modal_visible(false);
    ui.set_touch_keyboard_visible(false);
    ui.set_units_in_box(2);

    ui.window().set_size(slint::LogicalSize::new(width, height));
    ui.window()
        .set_position(slint::LogicalPosition::new(-20000.0, -20000.0));
    ui.show()?;
    let result = Rc::new(RefCell::new(None));
    let scroll_to_bottom = fixture.scroll_to_bottom;
    if scroll_to_bottom {
        let weak = ui.as_weak();
        let scroll_result = result.clone();
        slint::Timer::single_shot(Duration::from_millis(500), move || {
            if let Some(ui) = weak.upgrade() {
                if let Err(error) =
                    ui.window()
                        .try_dispatch_event(slint::platform::WindowEvent::PointerScrolled {
                            position: slint::LogicalPosition::new(width * 0.45, height * 0.5),
                            delta_x: 0.0,
                            delta_y: -100_000.0,
                        })
                {
                    *scroll_result.borrow_mut() = Some(Err(error.to_string()));
                    let _ = slint::quit_event_loop();
                }
            }
        });
    }
    let result_for_timer = result.clone();
    let weak = ui.as_weak();
    slint::Timer::single_shot(Duration::from_millis(1000), move || {
        let outcome = (|| -> Result<(), String> {
            let ui = weak.upgrade().ok_or("probe window closed")?;
            let pixels = ui.window().take_snapshot().map_err(|e| e.to_string())?;
            image::save_buffer(
                &path,
                pixels.as_bytes(),
                pixels.width(),
                pixels.height(),
                image::ColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
            let metadata = json!({
                "output": path, "requested_logical_size": [width, height],
                "physical_size": [pixels.width(), pixels.height()],
                "scale_factor": ui.window().scale_factor(),
                "server_online": ui.get_server_online(),
                "name": ui.get_product_name().as_str(),
                "runtime_started": false,
                "scrolled_to_bottom": scroll_to_bottom,
                "picker_checks": {"open_box_blocked": true, "selection_inflight_blocked": true, "closed_box_allowed": true}
            });
            std::fs::write(
                path.with_extension("json"),
                serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            println!("{metadata}");
            Ok(())
        })();
        *result_for_timer.borrow_mut() = Some(outcome);
        let _ = slint::quit_event_loop();
    });
    slint::run_event_loop()?;
    result
        .borrow_mut()
        .take()
        .ok_or("probe ended before capture")??;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
