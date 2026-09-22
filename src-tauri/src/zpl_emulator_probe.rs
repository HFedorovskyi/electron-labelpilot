use crate::generator::{GenerationPayload, GeneratorState};
use crate::native_raster;
use crate::printer::PrinterTransportState;
use crate::runtime_events::{NativeRuntimeEvent, RuntimeEventSink};
use serde_json::{json, Value};
use std::time::Instant;

const TEST_DPI: u16 = 300;

/// Sends representative ZPL jobs through the production generator and transport.
/// Intended for a local emulator or a dedicated test printer.
pub fn run(host: &str, port: u16) -> Result<Value, String> {
    if host.trim().is_empty() {
        return Err("ZPL emulator host must not be empty".to_owned());
    }
    if port == 0 {
        return Err("ZPL emulator port must be in 1..65535".to_owned());
    }

    let generator = GeneratorState::default();
    let transport = PrinterTransportState::new();
    let sink = RuntimeEventSink::callback(|event| {
        if let NativeRuntimeEvent::Log {
            subsystem,
            level,
            message,
        } = event
        {
            eprintln!("[{level}] {subsystem}: {message}");
        }
    });

    let scenarios = [
        ("native-ascii", false, false),
        ("hybrid-cyrillic-rle", true, false),
        ("hybrid-cyrillic-z64", true, true),
    ];
    let mut reports = Vec::with_capacity(scenarios.len());

    for (index, (name, cyrillic, z64)) in scenarios.into_iter().enumerate() {
        let config = printer_config(host, port, name, z64, index);
        let payload = GenerationPayload {
            config: config.clone(),
            doc: label_document(name, cyrillic),
            data: json!({}),
        };
        let plan = generator.plan(&payload)?;
        let started = Instant::now();
        let (bytes, mode, render_micros, raster_regions, native_commands) =
            match generator.generate_if_native(&payload)? {
                Some(generated) => (
                    generated.bytes,
                    "native",
                    0,
                    0,
                    payload
                        .doc
                        .get("elements")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len),
                ),
                None => {
                    let bitmap = native_raster::render(&payload)?;
                    let render_micros = bitmap.render_micros;
                    let raster_regions = bitmap.zpl_raster_regions.as_ref().map_or(1, Vec::len);
                    let native_commands = bitmap.native_zpl_commands.len();
                    let bytes = native_raster::encode("zpl", &bitmap, &config)?;
                    (
                        bytes,
                        "hybrid-raster",
                        render_micros,
                        raster_regions,
                        native_commands,
                    )
                }
            };

        validate_stream(name, &bytes, cyrillic, z64)?;
        let byte_count = bytes.len();
        let gfa_fields = count_occurrences(&bytes, b"^GFA");
        let z64_fields = count_occurrences(&bytes, b":Z64:");
        let native_boxes = count_occurrences(&bytes, b"^GB");
        let native_barcodes = count_occurrences(&bytes, b"^BC");
        let generate_micros = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let receipt = transport.submit_generated_with_sink(sink.clone(), config, bytes)?;

        reports.push(json!({
            "name": name,
            "mode": mode,
            "profileId": plan.profile_id,
            "fallbackReasons": plan.reasons,
            "bytes": byte_count,
            "generateMicros": generate_micros,
            "renderMicros": render_micros,
            "rasterRegions": raster_regions,
            "nativeCommands": native_commands,
            "gfaFields": gfa_fields,
            "z64Fields": z64_fields,
            "nativeBoxes": native_boxes,
            "nativeBarcodes": native_barcodes,
            "transport": receipt,
        }));
    }

    transport.disconnect_all();
    let ascii_bytes = reports[0]["bytes"].as_u64().unwrap_or_default();
    let rle_bytes = reports[1]["bytes"].as_u64().unwrap_or_default();
    let z64_bytes = reports[2]["bytes"].as_u64().unwrap_or_default();
    Ok(json!({
        "ok": true,
        "endpoint": format!("{host}:{port}"),
        "jobs": reports,
        "comparison": {
            "nativeAsciiBytes": ascii_bytes,
            "hybridRleBytes": rle_bytes,
            "hybridZ64Bytes": z64_bytes,
            "z64VsRlePercent": if rle_bytes == 0 {
                0.0
            } else {
                (z64_bytes as f64 / rle_bytes as f64) * 100.0
            }
        }
    }))
}

fn printer_config(host: &str, port: u16, name: &str, z64: bool, index: usize) -> Value {
    json!({
        "id": format!("zpl-emulator-probe-{index}"),
        "active": true,
        "name": format!("LabelPilot {name}"),
        "connection": "tcp",
        "protocol": "zpl",
        "compatibilityMode": "compatible",
        "ip": host,
        "port": port,
        "tcpJobBoundary": "stream",
        "jobIdempotencyKey": format!("zpl-emulator-probe-{name}"),
        "dpi": TEST_DPI,
        "widthMm": 58.0,
        "heightMm": 40.0,
        "z64": z64,
    })
}

fn label_document(name: &str, cyrillic: bool) -> Value {
    let (title, subtitle) = if cyrillic {
        (
            "ТЕСТ КИРИЛЛИЦЫ: Привет, мир!",
            "Партия АБВ-123 · Сыр фермерский",
        )
    } else {
        ("LABELPILOT NATIVE ASCII", "Batch ABC-123")
    };
    json!({
        "id": format!("zpl-emulator-{name}"),
        "name": format!("ZPL emulator {name}"),
        "widthMm": 58.0,
        "heightMm": 40.0,
        "canvas": { "width": 580, "height": 400, "dpi": 96 },
        "elements": [
            {
                "id": "frame", "type": "rect",
                "x": 8, "y": 8, "w": 564, "h": 384,
                "borderWidth": 3, "borderRadius": 0
            },
            {
                "id": "title", "type": "text",
                "x": 24, "y": 28, "w": 532, "h": 72,
                "text": title, "fontFamily": "Inter",
                "fontSize": 27, "fontWeight": 700,
                "textAlign": "center"
            },
            {
                "id": "subtitle", "type": "text",
                "x": 24, "y": 116, "w": 532, "h": 55,
                "text": subtitle, "fontFamily": "Inter",
                "fontSize": 20, "fontWeight": 400,
                "textAlign": "center"
            },
            {
                "id": "barcode", "type": "barcode",
                "x": 90, "y": 215, "w": 400, "h": 105,
                "barcodeType": "code128", "value": "LP-2026-000001",
                "showText": true
            },
            {
                "id": "footer", "type": "text",
                "x": 24, "y": 342, "w": 532, "h": 32,
                "text": name, "fontFamily": "Inter",
                "fontSize": 14, "fontWeight": 400,
                "textAlign": "center"
            }
        ]
    })
}

fn validate_stream(
    name: &str,
    bytes: &[u8],
    cyrillic: bool,
    requested_z64: bool,
) -> Result<(), String> {
    if !bytes.starts_with(b"^XA") || !bytes.ends_with(b"^XZ") {
        return Err(format!(
            "{name}: generated stream is not a complete ZPL label"
        ));
    }
    let gfa = count_occurrences(bytes, b"^GFA");
    let z64 = count_occurrences(bytes, b":Z64:");
    if cyrillic && gfa == 0 {
        return Err(format!(
            "{name}: Cyrillic safe-profile label did not use raster fields"
        ));
    }
    if cyrillic && count_occurrences(bytes, b"^GB") == 0 {
        return Err(format!("{name}: hybrid label lost its native frame"));
    }
    if cyrillic && count_occurrences(bytes, b"^BC") == 0 {
        return Err(format!("{name}: hybrid label lost its native barcode"));
    }
    if requested_z64 && z64 == 0 {
        return Err(format!(
            "{name}: Z64 was requested but was not selected for any raster field"
        ));
    }
    if !requested_z64 && z64 != 0 {
        return Err(format!("{name}: unexpected Z64 field"));
    }
    Ok(())
}

fn count_occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count()
}
