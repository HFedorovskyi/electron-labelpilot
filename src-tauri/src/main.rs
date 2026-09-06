#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use labelpilot_tauri_lib::runtime_selector::{
    append_runtime_log, runtime_probe_path, select_current, slint_sidecar_path, write_probe,
    RuntimeSelection, UiRuntime,
};
use std::{env, ffi::OsString, process::Command, thread, time::Duration};

fn main() {
    let selection = match select_current() {
        Ok(selection) => selection,
        Err(error) => {
            append_runtime_log(&format!(
                "invalid runtime selector: {error}; falling back to tauri"
            ));
            RuntimeSelection::tauri_default()
        }
    };

    if let Some(path) = runtime_probe_path() {
        if let Err(error) = write_probe(&path, &selection) {
            append_runtime_log(&format!("runtime probe failed: {error}"));
            std::process::exit(2);
        }
        return;
    }

    append_runtime_log(&format!(
        "selected={} source={} fallback={} slint_sidecar={}",
        selection.runtime.as_str(),
        selection.source.as_str(),
        selection.fallback_enabled,
        slint_sidecar_path().is_some()
    ));

    match selection.runtime {
        UiRuntime::Tauri => labelpilot_tauri_lib::run(),
        UiRuntime::Slint => run_slint_sidecar(selection.fallback_enabled),
    }
}

fn forwarded_slint_arguments() -> Vec<OsString> {
    let arguments: Vec<OsString> = env::args_os().skip(1).collect();
    let mut forwarded = Vec::with_capacity(arguments.len());
    let mut index = 0;
    while index < arguments.len() {
        let text = arguments[index].to_string_lossy();
        if text == "--ui-runtime" {
            index += 2;
            continue;
        }
        if text.starts_with("--ui-runtime=")
            || text == "--slint-ui"
            || text == "--tauri-ui"
            || text.starts_with("--runtime-probe=")
        {
            index += 1;
            continue;
        }
        forwarded.push(arguments[index].clone());
        index += 1;
    }
    forwarded
}

fn start_slint_sidecar() -> Result<(), String> {
    let executable = slint_sidecar_path().ok_or_else(|| {
        "labelpilot-slint sidecar is missing next to the main executable".to_owned()
    })?;
    let mut child = Command::new(&executable)
        .args(forwarded_slint_arguments())
        .env("LABELPILOT_UI_RUNTIME", "slint")
        .spawn()
        .map_err(|error| format!("start {}: {error}", executable.display()))?;

    thread::sleep(Duration::from_millis(750));
    match child
        .try_wait()
        .map_err(|error| format!("inspect Slint sidecar startup: {error}"))?
    {
        None => {
            append_runtime_log(&format!(
                "slint sidecar started pid={} path={}",
                child.id(),
                executable.display()
            ));
            Ok(())
        }
        Some(status) if status.success() => {
            append_runtime_log("slint sidecar completed during startup with exit=0");
            Ok(())
        }
        Some(status) => Err(format!(
            "Slint sidecar exited during startup with status {status}"
        )),
    }
}

fn run_slint_sidecar(fallback_enabled: bool) {
    match start_slint_sidecar() {
        Ok(()) => {}
        Err(error) if fallback_enabled => {
            append_runtime_log(&format!("{error}; falling back to tauri"));
            labelpilot_tauri_lib::run();
        }
        Err(error) => {
            append_runtime_log(&format!("{error}; fallback is disabled"));
            std::process::exit(4);
        }
    }
}
