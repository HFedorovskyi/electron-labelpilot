use super::types::{
    interpolate, js_round, normalize_barcode, Geometry, LabelElement, ParsedInput, Profile,
};
use serde_json::{Map, Value};

pub(super) fn generate(input: &ParsedInput, geometry: Geometry) -> Result<Vec<u8>, String> {
    let mut output = String::with_capacity(input.doc.elements.len() * 96 + 128);
    output.push_str("^XA\n");
    output.push_str(&format!("^PW{}\n", geometry.width_dots));
    output.push_str(&format!("^LL{}\n", geometry.height_dots));
    output.push_str("^PON\n");
    if let Some(darkness) = input.config.darkness {
        output.push_str(&format!("^MD{}\n", js_number(darkness)));
    }
    if let Some(speed) = input.config.print_speed {
        output.push_str(&format!("^PR{}\n", js_number(speed)));
    }
    if input.profile.native_utf8_text {
        output.push_str("^CI28\n");
    }
    for element in &input.doc.elements {
        append_element(&mut output, element, &input.data, geometry, input.profile)?;
        if output.len() > super::MAX_GENERATED_BYTES {
            return Err(format!(
                "generated ZPL exceeds {} bytes",
                super::MAX_GENERATED_BYTES
            ));
        }
    }
    output.push_str("^XZ");
    if input.profile.terminator == "\r\n" {
        output = output.replace('\n', "\r\n");
    }
    Ok(output.into_bytes())
}

fn append_element(
    output: &mut String,
    element: &LabelElement,
    data: &Map<String, Value>,
    geometry: Geometry,
    profile: Profile,
) -> Result<(), String> {
    let x = js_round(element.x * geometry.scale_x);
    let y = js_round(element.y * geometry.scale_y);
    let orientation = orientation(element.rotation);
    output.push_str(&format!("^FO{x},{y}"));

    match element.kind.as_str() {
        "text" => {
            let value = interpolate(element.text.as_deref().unwrap_or(""), data);
            let size = js_round(element.font_size.unwrap_or(12.0) * geometry.scale_y);
            if element.w != 0.0 {
                let width = js_round(element.w * geometry.scale_x);
                let justification = match element.text_align.as_deref() {
                    Some("center") => "C",
                    Some("right") => "R",
                    _ => "L",
                };
                // Only real line breaks become FB instructions. Literal backslashes
                // are routed to raster by the planner because FB gives them semantics.
                let value = value
                    .replace("\r\n", "\n")
                    .replace('\r', "\n")
                    .replace('\n', "\\&");
                output.push_str(&format!(
                    "^FB{width},20,0,{justification},0^A0{orientation},{size},{size}"
                ));
                append_field_data(output, &value)?;
            } else {
                output.push_str(&format!("^A0{orientation},{size},{size}"));
                append_field_data(output, &value)?;
            }
        }
        "rect" => {
            let mut width = js_round(element.w * geometry.scale_x);
            let mut height = js_round(element.h * geometry.scale_y);
            if matches!(orientation, "R" | "B") {
                std::mem::swap(&mut width, &mut height);
            }
            let border = js_round(element.border_width.unwrap_or(1.0) * geometry.scale_x);
            let radius = if profile.rounded_boxes {
                js_round(element.border_radius.unwrap_or(0.0) * geometry.scale_x)
            } else {
                0
            };
            let thickness = if element
                .fill
                .as_deref()
                .is_some_and(|fill| !fill.is_empty() && fill != "transparent")
            {
                height
            } else {
                border
            };
            output.push_str(&format!("^GB{width},{height},{thickness},B,{radius}^FS\n"));
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
            let height = js_round(element.h * geometry.scale_y);
            let module = js_round(2.0 * (geometry.scale_x / 2.1)).max(2);
            let human = if element.show_text { "Y" } else { "N" };
            let barcode = normalize_barcode(element.barcode_type.as_ref());
            match barcode.as_str() {
                "code128" | "gs1-128" => output.push_str(&format!(
                    "^BY{module},3.0,{height}^BC{orientation},{height},{human},N,N"
                )),
                "ean13" => output.push_str(&format!(
                    "^BY{module},3.0,{height}^BE{orientation},{height},{human},N"
                )),
                "ean8" => output.push_str(&format!(
                    "^BY{module},3.0,{height}^B8{orientation},{height},{human},N"
                )),
                "upca" => output.push_str(&format!(
                    "^BY{module},3.0,{height}^BU{orientation},{height},{human},N,Y"
                )),
                "upce" => output.push_str(&format!(
                    "^BY{module},3.0,{height}^B9{orientation},{height},{human},N,Y"
                )),
                "qrcode" | "gs1qrcode" => {
                    let magnification = js_round(geometry.scale_x * 2.0).max(3);
                    output.push_str(&format!("^BQ{orientation},2,{magnification}"));
                }
                "datamatrix" | "gs1datamatrix" => {
                    let magnification = js_round(geometry.scale_x * 2.0).max(3);
                    output.push_str(&format!("^BX{orientation},{magnification},200"));
                }
                "code39" => output.push_str(&format!(
                    "^BY{module},3.0,{height}^B3{orientation},N,{height},{human},N"
                )),
                "interleaved2of5" => output.push_str(&format!(
                    "^BY{module},3.0,{height}^B2{orientation},{height},{human},N,N"
                )),
                other => return Err(format!("native ZPL barcode is unsupported: {other}")),
            }
            if matches!(barcode.as_str(), "qrcode" | "gs1qrcode") {
                append_field_data(output, &format!("QA,{value}"))?;
            } else {
                append_field_data(output, &value)?;
            }
        }
        other => {
            return Err(format!("native ZPL element is unsupported: {other}"));
        }
    }
    Ok(())
}

fn orientation(rotation: Option<f64>) -> &'static str {
    match rotation {
        Some(90.0) => "R",
        Some(180.0) => "I",
        Some(270.0) => "B",
        _ => "N",
    }
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

/// Hex-escape only field data, never format commands. Keeping ordinary fields
/// unchanged preserves the existing golden streams and avoids unnecessary bytes.
fn append_field_data(output: &mut String, value: &str) -> Result<(), String> {
    fn escape(character: char) -> bool {
        matches!(character, '^' | '~' | '_') || character.is_ascii_control()
    }
    let escaped = value.chars().any(escape);
    let length: usize = value
        .chars()
        .map(|ch| if escape(ch) { 3 } else { ch.len_utf8() })
        .sum();
    let overhead = if escaped { 11 } else { 7 }; // FH_ (optional), FD, FS, newline.
    if output.len().saturating_add(length).saturating_add(overhead) > super::MAX_GENERATED_BYTES {
        return Err(format!(
            "generated ZPL exceeds {} bytes",
            super::MAX_GENERATED_BYTES
        ));
    }
    if escaped {
        output.push_str("^FH_");
    }
    output.push_str("^FD");
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for character in value.chars() {
        if escape(character) {
            let byte = character as u8;
            output.push('_');
            output.push(HEX[usize::from(byte >> 4)] as char);
            output.push(HEX[usize::from(byte & 15)] as char);
        } else {
            output.push(character);
        }
    }
    output.push_str("^FS\n");
    Ok(())
}

/// FH prevents ZPL commands in data but does not remove symbology-specific
/// invocation syntax. Render these values literally with the existing encoder.
pub(crate) fn barcode_requires_bitmap(barcode: &str, value: &str) -> bool {
    value.is_empty()
        || value.chars().any(char::is_control)
        || match barcode {
            "code128" => !value.is_ascii() || value.contains(['>', '^', '~']),
            // Modern BX uses underscore; legacy firmware uses tilde.
            "datamatrix" => value.contains(['_', '~']),
            "code39" => !value.bytes().all(|byte| {
                byte.is_ascii_uppercase() || byte.is_ascii_digit() || b" -. $/+%".contains(&byte)
            }),
            "ean13" | "ean8" | "upca" | "upce" | "interleaved2of5" => {
                !value.bytes().all(|byte| byte.is_ascii_digit())
            }
            _ => false,
        }
}
