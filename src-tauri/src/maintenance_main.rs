#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = labelpilot_tauri_lib::native_update::run_maintenance_cli() {
        eprintln!("LabelPilot maintenance error: {error}");
        std::process::exit(1);
    }
}
