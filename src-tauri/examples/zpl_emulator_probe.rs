use labelpilot_tauri_lib::zpl_emulator_probe;
use std::env;

fn main() {
    if let Err(error) = run() {
        eprintln!("ZPL emulator probe failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let host = arguments.next().unwrap_or_else(|| "127.0.0.1".to_owned());
    let port = arguments
        .next()
        .map(|value| {
            value
                .parse::<u16>()
                .map_err(|error| format!("invalid emulator port '{value}': {error}"))
        })
        .transpose()?
        .unwrap_or(9_100);
    if arguments.next().is_some() {
        return Err("usage: zpl_emulator_probe [HOST] [PORT]".to_owned());
    }

    let report = zpl_emulator_probe::run(&host, port)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report)
            .map_err(|error| format!("serialize probe report: {error}"))?
    );
    Ok(())
}
