#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use labelpilot_tauri_lib::runtime_selector::append_runtime_log;

const DEFAULT_SLINT_BACKEND: &str = "winit-skia-opengl";

fn main() {
    let backend = match std::env::var_os("SLINT_BACKEND") {
        Some(value) => value.to_string_lossy().into_owned(),
        None => {
            std::env::set_var("SLINT_BACKEND", DEFAULT_SLINT_BACKEND);
            DEFAULT_SLINT_BACKEND.to_owned()
        }
    };
    append_runtime_log(&format!(
        "starting standalone slint sidecar backend={backend} text=subpixel"
    ));
    if let Err(error) = labelpilot_tauri_lib::slint_runtime::run() {
        append_runtime_log(&format!("standalone slint runtime failed: {error}"));
        std::process::exit(3);
    }
    append_runtime_log("standalone slint runtime stopped cleanly");
}
