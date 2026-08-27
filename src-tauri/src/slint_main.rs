#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use labelpilot_tauri_lib::runtime_selector::append_runtime_log;

fn main() {
    if std::env::var_os("SLINT_BACKEND").is_none() {
        std::env::set_var("SLINT_BACKEND", "winit-femtovg");
    }
    append_runtime_log("starting standalone slint sidecar backend=winit-femtovg");
    if let Err(error) = labelpilot_tauri_lib::slint_runtime::run() {
        append_runtime_log(&format!("standalone slint runtime failed: {error}"));
        std::process::exit(3);
    }
    append_runtime_log("standalone slint runtime stopped cleanly");
}
