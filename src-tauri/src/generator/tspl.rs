use super::types::{
    interpolate, js_round, native_barcode_value_safe, needs_gs1_parse, normalize_barcode,
    tspl_text_requires_bitmap, Geometry, LabelElement, ParsedInput, Profile,
};
use serde_json::{Map, Value};

pub(super) fn generate(input: &ParsedInput, geometry: Geometry) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.doc.elements.len() * 96 + 160);
    push(
        &mut output,
        &format!(
            "SIZE {} mm,{} mm",
            number(geometry.width_mm),
            number(geometry.height_mm)
        ),
    );
    push(
        &mut output,
        &format!("GAP {} mm,0 mm", number(input.config.gap_mm.unwrap_or(2.0))),
    );
    push(&mut output, "DIRECTION 1");
    push(&mut output, "REFERENCE 0,0");
    push(
        &mut output,
        &format!(
            "SPEED {}",
            clamp(input.config.print_speed.unwrap_or(4.0), 1, 12)
        ),
    );
    push(
        &mut output,
        &format!(
            "DENSITY {}",
            clamp(
                input
                    .config
                    .darkness
                    .map(|value| value / 2.0)
                    .unwrap_or(8.0),
                0,
                15,
            )
        ),
    );
    if input.profile.native_utf8_text {
        push(&mut output, "CODEPAGE UTF-8");
    }
    push(&mut output, "CLS");

    for element in &input.doc.elements {
        append_element(&mut output, element, &input.data, geometry, input.profile)?;
        if output.len() > super::MAX_GENERATED_BYTES {
            return Err(format!(
                "generated TSPL exceeds {} bytes",
                super::MAX_GENERATED_BYTES
            ));
        }
    }
    push(&mut output, "PRINT 1,1");
    Ok(output)
}

fn append_element(
    output: &mut Vec<u8>,
    element: &LabelElement,
    data: &Map<String, Value>,
    geometry: Geometry,
    profile: Profile,
) -> Result<(), String> {
    let x = js_round(element.x * geometry.scale_x).max(0);
    let y = js_round(element.y * geometry.scale_y).max(0);
    let rotation = rotation(element.rotation);

    match element.kind.as_str() {
        "text" => {
            let value = interpolate(element.text.as_deref().unwrap_or(""), data);
            if value.is_empty() {
                return Ok(());
            }
            if tspl_text_requires_bitmap(element, &value) {
                return Err(format!("TSPL text requires bitmap: {}", element.id));
            }
            let point = js_round(element.font_size.unwrap_or(12.0) * 72.0 / 96.0).max(1);
            let alignment = match element.text_align.as_deref() {
                Some("center") => 2,
                Some("right") => 3,
                _ => 1,
            };
            push(
                output,
                &format!(
                    "TEXT {x},{y},\"0\",{rotation},{point},{point},{alignment},\"{}\"",
                    escape(&value)
                ),
            );
        }
        "rect" => {
            let mut width = js_round(element.w * geometry.scale_x).max(1);
            let mut height = js_round(element.h * geometry.scale_y).max(1);
            if matches!(rotation, 90 | 270) {
                std::mem::swap(&mut width, &mut height);
            }
            if element
                .fill
                .as_deref()
                .is_some_and(|fill| !fill.is_empty() && fill != "transparent")
            {
                push(output, &format!("BAR {x},{y},{width},{height}"));
            } else {
                let thickness = js_round(
                    element.border_width.unwrap_or(1.0) * geometry.scale_x.min(geometry.scale_y),
                )
                .max(1);
                let radius = if profile.rounded_boxes {
                    js_round(
                        element.border_radius.unwrap_or(0.0)
                            * geometry.scale_x.min(geometry.scale_y),
                    )
                    .max(0)
                } else {
                    0
                };
                let suffix = if radius > 0 {
                    format!(",{radius}")
                } else {
                    String::new()
                };
                push(
                    output,
                    &format!(
                        "BOX {x},{y},{},{},{thickness}{suffix}",
                        x + width,
                        y + height
                    ),
                );
            }
        }
        "barcode" => {
            let value = interpolate(
                element
                    .value
                    .as_deref()
                    .or(element.text.as_deref())
                    .unwrap_or(""),
                data,
            );
            if value.is_empty() {
                return Ok(());
            }
            let barcode = normalize_barcode(element.barcode_type.as_ref());
            if !native_barcode_value_safe(&value) || needs_gs1_parse(&barcode, &value) {
                return Err(format!("TSPL barcode requires bitmap: {}", element.id));
            }
            let width = js_round(element.w * geometry.scale_x).max(1);
            let height = js_round(element.h * geometry.scale_y).max(1);
            let escaped = escape(&value);

            if barcode == "qrcode" {
                let default_cell = (width.min(height) as f64 / 29.0).floor();
                let cell = clamp(element.module_width.unwrap_or(default_cell), 1, 10);
                push(
                    output,
                    &format!("QRCODE {x},{y},M,{cell},A,{rotation},M2,S7,\"{escaped}\""),
                );
            } else if barcode == "datamatrix" {
                let default_cell = (width.min(height) as f64 / 24.0).floor();
                let cell = clamp(element.module_width.unwrap_or(default_cell), 2, 10);
                push(
                    output,
                    &format!(
                        "DMATRIX {x},{y},{width},{height},c126,x{cell},r{rotation},\"{}\"",
                        escaped.replace('~', "~~")
                    ),
                );
            } else {
                let tspl_type = match barcode.as_str() {
                    "code128" => "128",
                    "ean13" => "EAN13",
                    "ean8" => "EAN8",
                    "upca" => "UPCA",
                    "upce" => "UPCE",
                    "code39" => "39",
                    "interleaved2of5" => "25",
                    other => {
                        return Err(format!("native TSPL barcode is unsupported: {other}"));
                    }
                };
                let default_module = fit_module_width(&barcode, &value, width);
                let module = clamp(element.module_width.unwrap_or(default_module as f64), 1, 10);
                let wide = (module + 1).max(module * 2);
                let human = i32::from(element.show_text);
                push(
                    output,
                    &format!(
                        "BARCODE {x},{y},\"{tspl_type}\",{height},{human},{rotation},{module},{wide},\"{escaped}\""
                    ),
                );
            }
        }
        other => {
            return Err(format!("native TSPL element is unsupported: {other}"));
        }
    }
    Ok(())
}

fn push(output: &mut Vec<u8>, line: &str) {
    output.extend_from_slice(line.as_bytes());
    output.extend_from_slice(b"\r\n");
}

fn rotation(value: Option<f64>) -> i64 {
    let rounded = js_round(value.unwrap_or(0.0));
    let normalized = ((rounded % 360) + 360) % 360;
    if matches!(normalized, 90 | 180 | 270) {
        normalized
    } else {
        0
    }
}

fn escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut previous_break = false;
    for character in value.chars() {
        match character {
            '\r' | '\n' => {
                if !previous_break {
                    output.push(' ');
                    previous_break = true;
                }
            }
            '"' => {
                output.push('\'');
                previous_break = false;
            }
            other => {
                output.push(other);
                previous_break = false;
            }
        }
    }
    output
}

fn fit_module_width(barcode: &str, value: &str, width: i64) -> i64 {
    let modules = match barcode {
        "ean13" | "upca" => 95,
        "ean8" => 67,
        "upce" => 51,
        "code128" => value.chars().count() as i64 * 11 + 35,
        _ => value.chars().count() as i64 * 14 + 30,
    };
    (width / modules.max(1)).max(1)
}

fn clamp(value: f64, min: i64, max: i64) -> i64 {
    js_round(value).clamp(min, max)
}

fn number(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded == 0.0 {
        return "0".to_owned();
    }
    let mut output = format!("{rounded:.2}");
    while output.ends_with('0') {
        output.pop();
    }
    if output.ends_with('.') {
        output.pop();
    }
    output
}
