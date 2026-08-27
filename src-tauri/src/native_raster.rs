use crate::generator::GenerationPayload;
use ab_glyph::{point, Font, FontArc, Glyph, PxScale, ScaleFont};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::{DynamicImage, GenericImageView, ImageReader, Limits, Rgba};
use rxing::{BarcodeFormat, EncodeHints, MultiFormatWriter, Writer};
use serde_json::{Map, Value};
use std::io::Cursor;
use std::sync::OnceLock;
use std::time::Instant;

const MAX_BITMAP_PIXELS: usize = 9_000_000;
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_SOURCE_PIXELS: u64 = 16_000_000;
const MAX_BARCODE_VALUE_BYTES: usize = 4_096;
const RXING_CODE128_FNC1: char = '\u{00f1}';

#[derive(Clone, Debug)]
pub struct RasterizedLabel {
    pub width_dots: usize,
    pub height_dots: usize,
    pub bytes_per_row: usize,
    pub width_mm: f64,
    pub height_mm: f64,
    pub mono: Vec<u8>,
    pub native_zpl_commands: Vec<String>,
    pub render_micros: u64,
}

struct FontCatalog {
    inter_regular: FontArc,
    inter_bold: FontArc,
    montserrat: FontArc,
    roboto: FontArc,
    ubuntu_regular: FontArc,
    ubuntu_bold: FontArc,
}

fn fonts() -> &'static FontCatalog {
    static FONTS: OnceLock<FontCatalog> = OnceLock::new();
    FONTS.get_or_init(|| FontCatalog {
        inter_regular: FontArc::try_from_slice(include_bytes!(
            "../../resources/fonts/Inter-Regular.ttf"
        ))
        .expect("embedded Inter Regular"),
        inter_bold: FontArc::try_from_slice(include_bytes!("../../resources/fonts/Inter-Bold.ttf"))
            .expect("embedded Inter Bold"),
        montserrat: FontArc::try_from_slice(include_bytes!(
            "../../resources/fonts/Montserrat-Variable.ttf"
        ))
        .expect("embedded Montserrat"),
        roboto: FontArc::try_from_slice(include_bytes!(
            "../../resources/fonts/Roboto-Variable.ttf"
        ))
        .expect("embedded Roboto"),
        ubuntu_regular: FontArc::try_from_slice(include_bytes!(
            "../../resources/fonts/Ubuntu-Regular.ttf"
        ))
        .expect("embedded Ubuntu Regular"),
        ubuntu_bold: FontArc::try_from_slice(include_bytes!(
            "../../resources/fonts/Ubuntu-Bold.ttf"
        ))
        .expect("embedded Ubuntu Bold"),
    })
}

pub(crate) fn warmup_static_assets() -> usize {
    let catalog = fonts();
    // Touch every embedded family once so the first Unicode label avoids
    // parsing several font tables on the production print path.
    [
        &catalog.inter_regular,
        &catalog.inter_bold,
        &catalog.montserrat,
        &catalog.roboto,
        &catalog.ubuntu_regular,
        &catalog.ubuntu_bold,
    ]
    .len()
}

fn font_for(family: &str, bold: bool) -> &'static FontArc {
    let catalog = fonts();
    match family.trim().to_ascii_lowercase().as_str() {
        "montserrat" => &catalog.montserrat,
        "roboto" => &catalog.roboto,
        "ubuntu" if bold => &catalog.ubuntu_bold,
        "ubuntu" => &catalog.ubuntu_regular,
        _ if bold => &catalog.inter_bold,
        _ => &catalog.inter_regular,
    }
}

#[derive(Clone, Copy)]
struct Geometry {
    width_dots: usize,
    height_dots: usize,
    scale_x: f32,
    scale_y: f32,
    dpi: f64,
    width_mm: f64,
    height_mm: f64,
}

pub fn render(payload: &GenerationPayload) -> Result<RasterizedLabel, String> {
    let started = Instant::now();
    let config = object(&payload.config, "printer config")?;
    let doc = object(&payload.doc, "label document")?;
    let data = object(&payload.data, "label data")?;
    let geometry = geometry(config, doc)?;
    let protocol = string(config.get("protocol"))
        .unwrap_or("zpl")
        .to_ascii_lowercase();
    let connection = string(config.get("connection"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let supports_zpl_commands =
        matches!(protocol.as_str(), "zpl" | "image") && connection != "windows_driver";
    let elements = doc
        .get("elements")
        .and_then(Value::as_array)
        .ok_or_else(|| "label document has no elements array".to_owned())?;
    if elements.len() > 1_024 {
        return Err("label elements exceed 1024 items".to_owned());
    }
    let bytes_per_row = geometry.width_dots.div_ceil(8);
    let mut mono = vec![0_u8; bytes_per_row * geometry.height_dots];
    let mut native_zpl_commands = Vec::new();
    for raw in elements {
        let element = object(raw, "label element")?;
        match string(element.get("type")).unwrap_or_default() {
            "text" => draw_text(&mut mono, bytes_per_row, geometry, element, data)?,
            "rect" => draw_rect(&mut mono, bytes_per_row, geometry, element),
            "table" => draw_table(&mut mono, bytes_per_row, geometry, element, data)?,
            "image" => draw_image(&mut mono, bytes_per_row, geometry, element)?,
            "barcode" if supports_zpl_commands && native_zpl_barcode_eligible(element, data)? => {
                native_zpl_commands.push(zpl_barcode(element, data, geometry)?);
            }
            "barcode" => draw_barcode(&mut mono, bytes_per_row, geometry, element, data)?,
            other => return Err(format!("unsupported native raster element: {other}")),
        }
    }
    Ok(RasterizedLabel {
        width_dots: geometry.width_dots,
        height_dots: geometry.height_dots,
        bytes_per_row,
        width_mm: geometry.width_mm,
        height_mm: geometry.height_mm,
        mono,
        native_zpl_commands,
        render_micros: started.elapsed().as_micros().min(u64::MAX as u128) as u64,
    })
}

pub fn encode(protocol: &str, bitmap: &RasterizedLabel, config: &Value) -> Result<Vec<u8>, String> {
    let config = object(config, "printer config")?;
    let bytes = match protocol.trim().to_ascii_lowercase().as_str() {
        "zpl" | "image" => encode_zpl(bitmap, config),
        "tspl" => encode_tspl(bitmap, config),
        "epl" => encode_epl(bitmap, config),
        "cpcl" => encode_cpcl(bitmap, config),
        "dpl" => encode_dpl(bitmap, config),
        "sbpl" => encode_sbpl(bitmap),
        other => Err(format!("unsupported portable raster protocol: {other}")),
    }?;
    if bytes.is_empty() || bytes.len() > MAX_OUTPUT_BYTES {
        return Err(format!(
            "portable raster output must contain 1..{MAX_OUTPUT_BYTES} bytes"
        ));
    }
    Ok(bytes)
}

fn geometry(config: &Map<String, Value>, doc: &Map<String, Value>) -> Result<Geometry, String> {
    let canvas = doc
        .get("canvas")
        .and_then(Value::as_object)
        .ok_or_else(|| "label document has no canvas object".to_owned())?;
    let dpi = finite(config.get("dpi"))
        .or_else(|| finite(doc.get("dpi")))
        .or_else(|| finite(canvas.get("dpi")))
        .unwrap_or(203.0);
    if !matches!(dpi.round() as i64, 203 | 300 | 600) {
        return Err(format!("unsupported printer DPI: {dpi}"));
    }
    let source_dpi = finite(canvas.get("dpi"))
        .filter(|value| *value > 0.0)
        .unwrap_or(96.0);
    let source_width = finite(canvas.get("width")).unwrap_or(0.0);
    let source_height = finite(canvas.get("height")).unwrap_or(0.0);
    let width_mm = finite(doc.get("widthMm"))
        .or_else(|| finite(config.get("widthMm")))
        .filter(|value| *value > 0.0)
        .or_else(|| {
            finite(canvas.get("widthCm"))
                .filter(|value| *value > 0.0)
                .map(|value| value * 10.0)
        })
        .unwrap_or(source_width * 25.4 / source_dpi);
    let height_mm = finite(doc.get("heightMm"))
        .or_else(|| finite(config.get("heightMm")))
        .filter(|value| *value > 0.0)
        .or_else(|| {
            finite(canvas.get("heightCm"))
                .filter(|value| *value > 0.0)
                .map(|value| value * 10.0)
        })
        .unwrap_or(source_height * 25.4 / source_dpi);
    if source_width <= 0.0 || source_height <= 0.0 || width_mm <= 0.0 || height_mm <= 0.0 {
        return Err("label dimensions and canvas dimensions must be positive".to_owned());
    }
    let width_dots = (width_mm * dpi / 25.4).round().max(1.0) as usize;
    let height_dots = (height_mm * dpi / 25.4).round().max(1.0) as usize;
    let pixels = width_dots
        .checked_mul(height_dots)
        .ok_or_else(|| "label bitmap dimensions overflow".to_owned())?;
    if pixels > MAX_BITMAP_PIXELS {
        return Err(format!(
            "bitmap fallback exceeds {MAX_BITMAP_PIXELS} pixels"
        ));
    }
    Ok(Geometry {
        width_dots,
        height_dots,
        scale_x: width_dots as f32 / source_width as f32,
        scale_y: height_dots as f32 / source_height as f32,
        dpi,
        width_mm,
        height_mm,
    })
}

fn draw_text(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    element: &Map<String, Value>,
    data: &Map<String, Value>,
) -> Result<(), String> {
    let x = scaled(element, "x", geometry.scale_x).round() as i32;
    let y = scaled(element, "y", geometry.scale_y).round() as i32;
    let width = scaled(element, "w", geometry.scale_x).round().max(1.0) as i32;
    let height = scaled(element, "h", geometry.scale_y).round().max(1.0) as i32;
    let font_size =
        (finite(element.get("fontSize")).unwrap_or(12.0) as f32 * geometry.scale_y).max(1.0);
    let weight = finite(element.get("fontWeight")).unwrap_or_else(|| {
        string(element.get("fontWeight")).map_or(400.0, |value| {
            if value.eq_ignore_ascii_case("bold") {
                700.0
            } else {
                400.0
            }
        })
    });
    let font = font_for(
        string(element.get("fontFamily")).unwrap_or("Inter"),
        weight >= 600.0,
    );
    let scale = PxScale::from(font_size);
    let text = interpolate(string(element.get("text")).unwrap_or_default(), data);
    let lines = wrap_text(font, scale, &text, width as f32);
    let line_height = font_size * 1.2;
    let block_height = lines.len() as f32 * line_height;
    let start_y = match string(element.get("verticalAlign")).unwrap_or("middle") {
        "top" => y as f32,
        "bottom" => y as f32 + height as f32 - block_height,
        _ => y as f32 + (height as f32 - block_height) / 2.0,
    };
    let align = string(element.get("textAlign")).unwrap_or("left");
    let clip = (
        x.max(0),
        y.max(0),
        (x + width).min(geometry.width_dots as i32),
        (y + height).min(geometry.height_dots as i32),
    );
    for (line_index, line) in lines.iter().enumerate() {
        let measured = measure_text(font, scale, line);
        let line_x = match align {
            "center" => x as f32 + (width as f32 - measured) / 2.0,
            "right" => x as f32 + width as f32 - measured,
            _ => x as f32,
        };
        let line_y = start_y + line_index as f32 * line_height;
        draw_glyph_line(
            mono, stride, geometry, clip, font, scale, line, line_x, line_y,
        );
        if string(element.get("textDecoration"))
            .unwrap_or_default()
            .contains("underline")
        {
            fill_rect(
                mono,
                stride,
                geometry,
                line_x.round() as i32,
                (line_y + font_size + geometry.scale_y).round() as i32,
                measured.round() as i32,
                geometry.scale_y.round().max(1.0) as i32,
            );
        }
    }
    Ok(())
}

fn wrap_text(font: &FontArc, scale: PxScale, text: &str, width: f32) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = String::new();
        for word in paragraph.split(' ') {
            let candidate = if current.is_empty() {
                word.to_owned()
            } else {
                format!("{current} {word}")
            };
            if !current.is_empty() && measure_text(font, scale, &candidate) > width {
                lines.push(current);
                current = word.to_owned();
            } else {
                current = candidate;
            }
        }
        lines.push(current);
    }
    lines
}

fn measure_text(font: &FontArc, scale: PxScale, text: &str) -> f32 {
    let scaled = font.as_scaled(scale);
    let mut width = 0.0;
    let mut previous = None;
    for character in text.chars() {
        let id = scaled.glyph_id(character);
        if let Some(previous) = previous {
            width += scaled.kern(previous, id);
        }
        width += scaled.h_advance(id);
        previous = Some(id);
    }
    width
}

#[allow(clippy::too_many_arguments)]
fn draw_glyph_line(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    clip: (i32, i32, i32, i32),
    font: &FontArc,
    scale: PxScale,
    text: &str,
    x: f32,
    top: f32,
) {
    let scaled = font.as_scaled(scale);
    let mut cursor = x;
    let baseline = top + scaled.ascent();
    let mut previous = None;
    for character in text.chars() {
        let id = scaled.glyph_id(character);
        if let Some(previous) = previous {
            cursor += scaled.kern(previous, id);
        }
        let glyph = Glyph {
            id,
            scale,
            position: point(cursor, baseline),
        };
        if let Some(outline) = font.outline_glyph(glyph) {
            let bounds = outline.px_bounds();
            outline.draw(|gx, gy, coverage| {
                if coverage < 0.32 {
                    return;
                }
                let px = bounds.min.x as i32 + gx as i32;
                let py = bounds.min.y as i32 + gy as i32;
                if px >= clip.0 && py >= clip.1 && px < clip.2 && py < clip.3 {
                    set_pixel(mono, stride, geometry, px, py);
                }
            });
        }
        cursor += scaled.h_advance(id);
        previous = Some(id);
    }
}

fn draw_table(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    element: &Map<String, Value>,
    data: &Map<String, Value>,
) -> Result<(), String> {
    let columns = element
        .get("columns")
        .and_then(Value::as_array)
        .ok_or_else(|| "table has no columns array".to_owned())?;
    if columns.is_empty() {
        return Err("table has no columns".to_owned());
    }
    let x = scaled(element, "x", geometry.scale_x).round() as i32;
    let y = scaled(element, "y", geometry.scale_y).round() as i32;
    let width = scaled(element, "w", geometry.scale_x).round().max(1.0) as i32;
    let height = scaled(element, "h", geometry.scale_y).round().max(1.0) as i32;
    let font_size =
        (finite(element.get("fontSize")).unwrap_or(10.0) as f32 * geometry.scale_y).max(6.0);
    let padding = (4.0 * geometry.scale_x.min(geometry.scale_y))
        .round()
        .max(2.0) as i32;
    let row_height = (font_size * 1.2).round() as i32 + padding * 2;
    let show_headers = element.get("showHeaders").and_then(Value::as_bool) != Some(false);
    let show_borders = element.get("showBorders").and_then(Value::as_bool) != Some(false);
    let mut current_y = y;
    let rows = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut draw_row =
        |row: Option<&Map<String, Value>>, header: bool, current_y: i32| -> Result<(), String> {
            let mut current_x = x;
            for (index, raw_column) in columns.iter().enumerate() {
                let column = object(raw_column, "table column")?;
                let ratio =
                    finite(column.get("widthRatio")).unwrap_or(100.0 / columns.len() as f64);
                let cell_width = if index + 1 == columns.len() {
                    x + width - current_x
                } else {
                    (width as f64 * ratio / 100.0).round().max(1.0) as i32
                };
                let key = string(column.get("key")).unwrap_or_default();
                let text = if header {
                    string(column.get("title"))
                        .filter(|value| !value.is_empty())
                        .unwrap_or(key)
                        .to_owned()
                } else {
                    row.and_then(|row| row.get(key))
                        .map(value_text)
                        .unwrap_or_default()
                };
                let mut cell = element.clone();
                cell.insert("type".to_owned(), json_value("text"));
                cell.insert(
                    "x".to_owned(),
                    Value::from(current_x as f64 / geometry.scale_x as f64),
                );
                cell.insert(
                    "y".to_owned(),
                    Value::from(current_y as f64 / geometry.scale_y as f64),
                );
                cell.insert(
                    "w".to_owned(),
                    Value::from(cell_width as f64 / geometry.scale_x as f64),
                );
                cell.insert(
                    "h".to_owned(),
                    Value::from(row_height as f64 / geometry.scale_y as f64),
                );
                cell.insert("text".to_owned(), Value::String(text));
                cell.insert(
                    "fontSize".to_owned(),
                    Value::from(font_size as f64 / geometry.scale_y as f64),
                );
                cell.insert(
                    "fontWeight".to_owned(),
                    Value::from(if header { 700 } else { 400 }),
                );
                cell.insert("verticalAlign".to_owned(), json_value("middle"));
                cell.insert("textAlign".to_owned(), json_value("left"));
                draw_text(mono, stride, geometry, &cell, &Map::new())?;
                if show_borders {
                    line_h(mono, stride, geometry, current_x, current_y, cell_width);
                    line_h(
                        mono,
                        stride,
                        geometry,
                        current_x,
                        current_y + row_height - 1,
                        cell_width,
                    );
                    line_v(mono, stride, geometry, current_x, current_y, row_height);
                    line_v(
                        mono,
                        stride,
                        geometry,
                        current_x + cell_width - 1,
                        current_y,
                        row_height,
                    );
                }
                current_x += cell_width;
            }
            Ok(())
        };
    if show_headers && current_y + row_height <= y + height {
        draw_row(None, true, current_y)?;
        current_y += row_height;
    }
    for row in &rows {
        if current_y + row_height > y + height {
            break;
        }
        draw_row(row.as_object(), false, current_y)?;
        current_y += row_height;
    }
    Ok(())
}

fn json_value(value: &str) -> Value {
    Value::String(value.to_owned())
}
fn draw_rect(mono: &mut [u8], stride: usize, geometry: Geometry, element: &Map<String, Value>) {
    let x = scaled(element, "x", geometry.scale_x).round() as i32;
    let y = scaled(element, "y", geometry.scale_y).round() as i32;
    let width = scaled(element, "w", geometry.scale_x).round().max(1.0) as i32;
    let height = scaled(element, "h", geometry.scale_y).round().max(1.0) as i32;
    let filled = string(element.get("fill"))
        .is_some_and(|fill| fill != "transparent" && fill != "#ffffff" && fill != "white");
    if filled {
        fill_rect(mono, stride, geometry, x, y, width, height);
    }
    let border = (finite(element.get("borderWidth")).unwrap_or(0.0) as f32
        * geometry.scale_x.min(geometry.scale_y))
    .round() as i32;
    for offset in 0..border.max(0) {
        line_h(mono, stride, geometry, x, y + offset, width);
        line_h(mono, stride, geometry, x, y + height - 1 - offset, width);
        line_v(mono, stride, geometry, x + offset, y, height);
        line_v(mono, stride, geometry, x + width - 1 - offset, y, height);
    }
}

fn zpl_barcode(
    element: &Map<String, Value>,
    data: &Map<String, Value>,
    geometry: Geometry,
) -> Result<String, String> {
    let value = interpolate(
        string(element.get("value"))
            .or_else(|| string(element.get("text")))
            .unwrap_or_default(),
        data,
    );
    if value.is_empty() || value.contains("{{") {
        return Err("barcode has unresolved data".to_owned());
    }
    let kind = normalize_barcode(string(element.get("barcodeType")).unwrap_or("code128"));
    let x = scaled(element, "x", geometry.scale_x).round().max(0.0) as usize;
    let y = scaled(element, "y", geometry.scale_y).round().max(0.0) as usize;
    let width = scaled(element, "w", geometry.scale_x).round().max(1.0) as usize;
    let height = scaled(element, "h", geometry.scale_y).round().max(1.0) as usize;
    let modules = match kind.as_str() {
        "ean13" => 95,
        "ean8" => 67,
        "upca" => 95,
        "upce" => 51,
        "code39" => value.chars().count() * 13 + 25,
        _ => value.chars().count() * 11 + 35,
    };
    let module = (width / modules).clamp(1, 10);
    let symbol_width = modules * module;
    let symbol_x = x + width.saturating_sub(symbol_width) / 2;
    let show_text = element
        .get("showText")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reserve = if show_text {
        ((20.0 * geometry.scale_y).round() as usize).clamp(12, height.saturating_sub(1).max(12))
    } else {
        0
    };
    let bar_height = height.saturating_sub(reserve).max(1);
    let human = if show_text { "Y" } else { "N" };
    let command = match kind.as_str() {
        "ean13" => format!("^BEN,{bar_height},{human},N"),
        "ean8" => format!("^B8N,{bar_height},{human},N"),
        "upca" => format!("^BUN,{bar_height},{human},N,Y"),
        "upce" => format!("^B9N,{bar_height},{human},N,Y"),
        "code39" => format!("^B3N,N,{bar_height},{human},N"),
        "code128" | "gs1-128" => format!("^BCN,{bar_height},{human},N,N"),
        other => {
            return Err(format!(
                "unsupported ZPL barcode type in raster path: {other}"
            ))
        }
    };
    Ok(format!(
        "^FO{symbol_x},{y}^BY{module},3.0,{bar_height}{command}^FD{value}^FS\n"
    ))
}

fn barcode_value(
    element: &Map<String, Value>,
    data: &Map<String, Value>,
) -> Result<String, String> {
    let value = interpolate(
        string(element.get("value"))
            .or_else(|| string(element.get("text")))
            .unwrap_or_default(),
        data,
    );
    if value.is_empty() || value.contains("{{") {
        return Err(format!(
            "barcode {} has unresolved data",
            string(element.get("id")).unwrap_or_default()
        ));
    }
    if value.len() > MAX_BARCODE_VALUE_BYTES {
        return Err(format!(
            "barcode value exceeds {MAX_BARCODE_VALUE_BYTES} UTF-8 bytes"
        ));
    }
    Ok(value)
}

fn native_zpl_barcode_eligible(
    element: &Map<String, Value>,
    data: &Map<String, Value>,
) -> Result<bool, String> {
    let Ok(value) = barcode_value(element, data) else {
        return Ok(false);
    };
    let kind = normalize_barcode(string(element.get("barcodeType")).unwrap_or("code128"));
    if has_gs1_ai(&value) || kind.starts_with("gs1") || kind.starts_with("databar") {
        return Ok(false);
    }
    if value
        .bytes()
        .any(|byte| matches!(byte, b'^' | b'~' | b'\r' | b'\n'))
    {
        return Ok(false);
    }
    let eligible = match kind.as_str() {
        "ean13" => numeric_length(&value, 12, 13),
        "ean8" => numeric_length(&value, 7, 8),
        "upca" => numeric_length(&value, 11, 12),
        "upce" => numeric_length(&value, 6, 8),
        "code128" => value.is_ascii() && value.len() <= 128,
        _ => false,
    };
    Ok(eligible)
}

fn draw_barcode(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    element: &Map<String, Value>,
    data: &Map<String, Value>,
) -> Result<(), String> {
    let value = match barcode_value(element, data) {
        Ok(value) => value,
        Err(error) => {
            if let Some(source) = string(element.get("imageData")).filter(|value| !value.is_empty())
            {
                return draw_embedded_image(mono, stride, geometry, element, source, false);
            }
            return Err(error);
        }
    };
    let kind = normalize_barcode(string(element.get("barcodeType")).unwrap_or("code128"));
    let (format, maximum_length, gs1, linear) = match barcode_format(&kind, &value) {
        Some(spec) => spec,
        None => {
            if let Some(source) = string(element.get("imageData")).filter(|value| !value.is_empty())
            {
                return draw_embedded_image(mono, stride, geometry, element, source, false);
            }
            return Err(format!("native raster barcode {kind} has no Rust encoder"));
        }
    };
    if value.len() > maximum_length {
        if let Some(source) = string(element.get("imageData")).filter(|value| !value.is_empty()) {
            return draw_embedded_image(mono, stride, geometry, element, source, false);
        }
        return Err(format!(
            "barcode {kind} exceeds its {maximum_length}-byte limit"
        ));
    }
    if let Err(error) = validate_barcode_value(&kind, &value) {
        if let Some(source) = string(element.get("imageData")).filter(|value| !value.is_empty()) {
            return draw_embedded_image(mono, stride, geometry, element, source, false);
        }
        return Err(error);
    }
    let content = rxing_content(&value, format, gs1)?;
    let x = scaled(element, "x", geometry.scale_x).round() as i32;
    let y = scaled(element, "y", geometry.scale_y).round() as i32;
    let destination_width = scaled(element, "w", geometry.scale_x).round().max(1.0) as usize;
    let destination_height = scaled(element, "h", geometry.scale_y).round().max(1.0) as usize;
    let turns = quarter_turns(finite(element.get("rotation")).unwrap_or(0.0))?;
    let (local_width, local_height) = if turns % 2 == 0 {
        (destination_width, destination_height)
    } else {
        (destination_height, destination_width)
    };
    let show_text = linear
        && element
            .get("showText")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let text_height = if show_text {
        ((local_height as f32 * 0.18).round() as usize)
            .max(12)
            .min(local_height.saturating_sub(1).max(1))
    } else {
        0
    };
    let symbol_height = local_height.saturating_sub(text_height).max(1);
    let mut hints = EncodeHints {
        CharacterSet: Some("UTF-8".to_owned()),
        Gs1Format: Some(gs1),
        Margin: Some(
            match format {
                BarcodeFormat::QR_CODE => 4,
                BarcodeFormat::DATA_MATRIX => 1,
                BarcodeFormat::AZTEC => 2,
                _ => 10,
            }
            .to_string(),
        ),
        ..EncodeHints::default()
    };
    if format == BarcodeFormat::DATA_MATRIX {
        hints.DataMatrixCompact = Some(true);
    }
    if format == BarcodeFormat::QR_CODE {
        let correction = string(element.get("errorCorrection"))
            .unwrap_or("M")
            .trim()
            .to_ascii_uppercase();
        if matches!(correction.as_str(), "L" | "M" | "Q" | "H") {
            hints.ErrorCorrection = Some(correction);
        }
    }
    let matrix = match MultiFormatWriter.encode_with_hints(
        &content,
        &format,
        local_width
            .try_into()
            .map_err(|_| "barcode width overflow")?,
        symbol_height
            .try_into()
            .map_err(|_| "barcode height overflow")?,
        &hints,
    ) {
        Ok(matrix) => matrix,
        Err(error) => {
            if let Some(source) = string(element.get("imageData")).filter(|value| !value.is_empty())
            {
                return draw_embedded_image(mono, stride, geometry, element, source, false);
            }
            return Err(format!("encode {kind}: {error}"));
        }
    };
    if matrix.getWidth() as usize > local_width || matrix.getHeight() as usize > symbol_height {
        return Err(format!(
            "barcode {kind} requires {}x{} dots but element provides {local_width}x{symbol_height}",
            matrix.getWidth(),
            matrix.getHeight()
        ));
    }
    let local_stride = local_width.div_ceil(8);
    let mut local = vec![0_u8; local_stride * local_height];
    let offset_x = (local_width - matrix.getWidth() as usize) / 2;
    let offset_y = (symbol_height - matrix.getHeight() as usize) / 2;
    for matrix_y in 0..matrix.getHeight() {
        for matrix_x in 0..matrix.getWidth() {
            if matrix.get(matrix_x, matrix_y) {
                set_local_pixel(
                    &mut local,
                    local_stride,
                    local_width,
                    local_height,
                    offset_x + matrix_x as usize,
                    offset_y + matrix_y as usize,
                );
            }
        }
    }
    if show_text && text_height > 0 {
        let local_geometry = local_geometry(local_width, local_height, geometry.dpi);
        let font = font_for("Inter", false);
        let scale = PxScale::from(text_height as f32 * 0.78);
        let measured = measure_text(font, scale, &value);
        draw_glyph_line(
            &mut local,
            local_stride,
            local_geometry,
            (
                0,
                symbol_height as i32,
                local_width as i32,
                local_height as i32,
            ),
            font,
            scale,
            &value,
            ((local_width as f32 - measured) / 2.0).max(0.0),
            symbol_height as f32,
        );
    }
    blit_local_bitmap(
        mono,
        stride,
        geometry,
        x,
        y,
        &local,
        local_width,
        local_height,
        turns,
    );
    Ok(())
}

fn barcode_format(kind: &str, value: &str) -> Option<(BarcodeFormat, usize, bool, bool)> {
    let has_ai = has_gs1_ai(value);
    Some(match kind {
        "ean13" => (BarcodeFormat::EAN_13, 13, false, true),
        "ean8" => (BarcodeFormat::EAN_8, 8, false, true),
        "upca" => (BarcodeFormat::UPC_A, 12, false, true),
        "upce" => (BarcodeFormat::UPC_E, 8, false, true),
        "code128" => (BarcodeFormat::CODE_128, 80, has_ai, true),
        "gs1-128" => (BarcodeFormat::CODE_128, 80, true, true),
        "code39" => (BarcodeFormat::CODE_39, 128, false, true),
        "interleaved2of5" => (BarcodeFormat::ITF, 128, false, true),
        "qrcode" => (BarcodeFormat::QR_CODE, 4_096, has_ai, false),
        "gs1qrcode" => (BarcodeFormat::QR_CODE, 4_096, true, false),
        "datamatrix" => (BarcodeFormat::DATA_MATRIX, 3_116, has_ai, false),
        "gs1datamatrix" => (BarcodeFormat::DATA_MATRIX, 3_116, true, false),
        "pdf417" => (BarcodeFormat::PDF_417, 1_850, has_ai, false),
        "azteccode" => (BarcodeFormat::AZTEC, 3_067, has_ai, false),
        "databarexpandedstacked" => return None,
        _ => return None,
    })
}

fn validate_barcode_value(kind: &str, value: &str) -> Result<(), String> {
    let valid = match kind {
        "ean13" => numeric_length(value, 12, 13),
        "ean8" => numeric_length(value, 7, 8),
        "upca" => numeric_length(value, 11, 12),
        "upce" => numeric_length(value, 6, 8),
        "interleaved2of5" => !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
        "code128" | "gs1-128" | "code39" => value.is_ascii(),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("barcode {kind} contains invalid data: {value}"))
    }
}

fn numeric_length(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn has_gs1_ai(value: &str) -> bool {
    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'(' {
            continue;
        }
        for length in 2..=4 {
            let close = start + length + 1;
            if close < bytes.len()
                && bytes[close] == b')'
                && bytes[start + 1..close]
                    .iter()
                    .all(|byte| byte.is_ascii_digit())
            {
                return true;
            }
        }
    }
    false
}

fn rxing_content(value: &str, format: BarcodeFormat, gs1: bool) -> Result<String, String> {
    let content = if gs1 {
        gs1_content(value)?
    } else {
        value.to_owned()
    };
    if gs1 && format == BarcodeFormat::CODE_128 {
        let mut encoded = String::with_capacity(content.len() + 1);
        encoded.push(RXING_CODE128_FNC1);
        for character in content.chars() {
            encoded.push(if character == '\u{1d}' {
                RXING_CODE128_FNC1
            } else {
                character
            });
        }
        Ok(encoded)
    } else {
        Ok(content)
    }
}

fn gs1_content(value: &str) -> Result<String, String> {
    if !value.starts_with('(') {
        return Ok(value.to_owned());
    }
    let bytes = value.as_bytes();
    let mut cursor = 0_usize;
    let mut output = String::with_capacity(value.len());
    while cursor < bytes.len() {
        if bytes[cursor] != b'(' {
            return Err(format!("invalid GS1 AI at byte {cursor}"));
        }
        let close = bytes[cursor + 1..]
            .iter()
            .position(|byte| *byte == b')')
            .map(|offset| cursor + 1 + offset)
            .ok_or_else(|| "GS1 AI is missing ')'".to_owned())?;
        let ai = &value[cursor + 1..close];
        if !(2..=4).contains(&ai.len()) || !ai.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("invalid GS1 application identifier: {ai}"));
        }
        let value_start = close + 1;
        let next = next_gs1_ai(value, value_start).unwrap_or(value.len());
        if next == value_start {
            return Err(format!("GS1 application identifier {ai} has no value"));
        }
        output.push_str(ai);
        output.push_str(&value[value_start..next]);
        if next < value.len() && !fixed_length_ai(ai) {
            output.push('\u{1d}');
        }
        cursor = next;
    }
    Ok(output)
}

fn next_gs1_ai(value: &str, from: usize) -> Option<usize> {
    let bytes = value.as_bytes();
    for start in from..bytes.len() {
        if bytes[start] != b'(' {
            continue;
        }
        for length in 2..=4 {
            let close = start + length + 1;
            if close < bytes.len()
                && bytes[close] == b')'
                && bytes[start + 1..close]
                    .iter()
                    .all(|byte| byte.is_ascii_digit())
            {
                return Some(start);
            }
        }
    }
    None
}

fn fixed_length_ai(ai: &str) -> bool {
    if matches!(
        ai,
        "00" | "01"
            | "02"
            | "11"
            | "12"
            | "13"
            | "15"
            | "16"
            | "17"
            | "20"
            | "402"
            | "410"
            | "411"
            | "412"
            | "413"
            | "414"
            | "415"
            | "416"
            | "417"
            | "422"
            | "424"
            | "425"
            | "426"
            | "7001"
            | "8001"
            | "8005"
            | "8006"
            | "8017"
            | "8018"
            | "8100"
            | "8101"
            | "8102"
            | "8111"
    ) {
        return true;
    }
    ai.len() == 4
        && ai.bytes().all(|byte| byte.is_ascii_digit())
        && matches!(&ai[..2], "31" | "32" | "33" | "34" | "35" | "36")
}

fn quarter_turns(rotation: f64) -> Result<u8, String> {
    let normalized = rotation.rem_euclid(360.0);
    let turns = (normalized / 90.0).round();
    if (normalized - turns * 90.0).abs() > 0.01 {
        return Err(format!(
            "native barcode/image rotation must be a multiple of 90 degrees: {rotation}"
        ));
    }
    Ok((turns as i32).rem_euclid(4) as u8)
}

fn local_geometry(width: usize, height: usize, dpi: f64) -> Geometry {
    Geometry {
        width_dots: width,
        height_dots: height,
        scale_x: 1.0,
        scale_y: 1.0,
        dpi,
        width_mm: width as f64 * 25.4 / dpi,
        height_mm: height as f64 * 25.4 / dpi,
    }
}

fn set_local_pixel(
    mono: &mut [u8],
    stride: usize,
    width: usize,
    height: usize,
    x: usize,
    y: usize,
) {
    if x < width && y < height {
        mono[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
}

#[allow(clippy::too_many_arguments)]
fn blit_local_bitmap(
    destination: &mut [u8],
    destination_stride: usize,
    geometry: Geometry,
    x: i32,
    y: i32,
    source: &[u8],
    source_width: usize,
    source_height: usize,
    turns: u8,
) {
    let source_stride = source_width.div_ceil(8);
    for source_y in 0..source_height {
        for source_x in 0..source_width {
            if source[source_y * source_stride + (source_x >> 3)] & (0x80 >> (source_x & 7)) == 0 {
                continue;
            }
            let (destination_x, destination_y) = match turns {
                1 => (source_height - 1 - source_y, source_x),
                2 => (source_width - 1 - source_x, source_height - 1 - source_y),
                3 => (source_y, source_width - 1 - source_x),
                _ => (source_x, source_y),
            };
            set_pixel(
                destination,
                destination_stride,
                geometry,
                x + destination_x as i32,
                y + destination_y as i32,
            );
        }
    }
}

fn draw_image(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    element: &Map<String, Value>,
) -> Result<(), String> {
    let source = string(element.get("imageData"))
        .or_else(|| string(element.get("src")))
        .filter(|source| !source.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "image {} has no embedded source",
                string(element.get("id")).unwrap_or_default()
            )
        })?;
    draw_embedded_image(mono, stride, geometry, element, source, true)
}

fn draw_embedded_image(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    element: &Map<String, Value>,
    source: &str,
    fit: bool,
) -> Result<(), String> {
    let image = decode_image_source(source)?;
    let x = scaled(element, "x", geometry.scale_x).round() as i32;
    let y = scaled(element, "y", geometry.scale_y).round() as i32;
    let destination_width = scaled(element, "w", geometry.scale_x).round().max(1.0) as usize;
    let destination_height = scaled(element, "h", geometry.scale_y).round().max(1.0) as usize;
    let turns = quarter_turns(finite(element.get("rotation")).unwrap_or(0.0))?;
    let (local_width, local_height) = if turns % 2 == 0 {
        (destination_width, destination_height)
    } else {
        (destination_height, destination_width)
    };
    let local_stride = local_width.div_ceil(8);
    let mut local = vec![0_u8; local_stride * local_height];
    draw_decoded_image(
        &mut local,
        local_stride,
        local_width,
        local_height,
        &image,
        fit,
    );
    blit_local_bitmap(
        mono,
        stride,
        geometry,
        x,
        y,
        &local,
        local_width,
        local_height,
        turns,
    );
    Ok(())
}

fn decode_image_source(source: &str) -> Result<DynamicImage, String> {
    let bytes = image_source_bytes(source)?;
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("detect embedded image format: {error}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(8_192);
    limits.max_image_height = Some(8_192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("decode embedded image: {error}"))?;
    let (width, height) = image.dimensions();
    if width == 0
        || height == 0
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_SOURCE_PIXELS
    {
        return Err(format!(
            "embedded image dimensions {width}x{height} exceed the {MAX_IMAGE_SOURCE_PIXELS}-pixel limit"
        ));
    }
    Ok(image)
}

fn image_source_bytes(source: &str) -> Result<Vec<u8>, String> {
    let source = source.trim();
    let encoded = if source.starts_with("data:") {
        let (metadata, encoded) = source
            .split_once(',')
            .ok_or_else(|| "embedded image data URI has no comma".to_owned())?;
        if !metadata.to_ascii_lowercase().contains(";base64") {
            return Err("embedded image data URI must use base64".to_owned());
        }
        encoded
    } else {
        if source.contains("://") || source.starts_with("file:") || source.starts_with("blob:") {
            return Err("native image source must be embedded base64 data".to_owned());
        }
        source
    };
    let compact: String = encoded
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let maximum_encoded = MAX_IMAGE_SOURCE_BYTES.div_ceil(3) * 4 + 8;
    if compact.is_empty() || compact.len() > maximum_encoded {
        return Err(format!(
            "embedded image source must contain 1..{maximum_encoded} base64 characters"
        ));
    }
    let bytes = BASE64_STANDARD
        .decode(compact)
        .map_err(|error| format!("decode embedded image base64: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_SOURCE_BYTES {
        return Err(format!(
            "embedded image must contain 1..{MAX_IMAGE_SOURCE_BYTES} decoded bytes"
        ));
    }
    Ok(bytes)
}

fn draw_decoded_image(
    mono: &mut [u8],
    stride: usize,
    width: usize,
    height: usize,
    image: &DynamicImage,
    fit: bool,
) {
    let (source_width, source_height) = image.dimensions();
    let (target_width, target_height) = if fit {
        let scale =
            (width as f64 / f64::from(source_width)).min(height as f64 / f64::from(source_height));
        (
            (f64::from(source_width) * scale).round().max(1.0) as usize,
            (f64::from(source_height) * scale).round().max(1.0) as usize,
        )
    } else {
        (width, height)
    };
    let offset_x = (width - target_width) / 2;
    let offset_y = (height - target_height) / 2;
    for target_y in 0..target_height {
        let source_y = ((target_y as u64 * u64::from(source_height)) / target_height as u64)
            .min(u64::from(source_height - 1)) as u32;
        for target_x in 0..target_width {
            let source_x = ((target_x as u64 * u64::from(source_width)) / target_width as u64)
                .min(u64::from(source_width - 1)) as u32;
            if image_pixel_is_black(image.get_pixel(source_x, source_y)) {
                set_local_pixel(
                    mono,
                    stride,
                    width,
                    height,
                    offset_x + target_x,
                    offset_y + target_y,
                );
            }
        }
    }
}

fn image_pixel_is_black(pixel: Rgba<u8>) -> bool {
    let [red, green, blue, alpha] = pixel.0;
    let luminance = f32::from(red) * 0.299 + f32::from(green) * 0.587 + f32::from(blue) * 0.114;
    alpha > 32 && luminance < 180.0
}
fn encode_zpl(bitmap: &RasterizedLabel, config: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let total = bitmap.mono.len();
    let compressed = compress_zpl(&bitmap.mono, bitmap.bytes_per_row, bitmap.height_dots);
    let mut stream = format!(
        "^XA\n^PW{}\n^LL{}\n^PON\n",
        bitmap.width_dots, bitmap.height_dots
    );
    if let Some(value) = finite(config.get("darkness")) {
        stream.push_str(&format!("^MD{value}\n"));
    }
    if let Some(value) = finite(config.get("printSpeed")) {
        stream.push_str(&format!("^PR{value}\n"));
    }
    stream.push_str(&format!(
        "^FO0,0^GFA,{total},{total},{},{}^FS\n",
        bitmap.bytes_per_row, compressed
    ));
    for command in &bitmap.native_zpl_commands {
        stream.push_str(command);
    }
    stream.push_str("^XZ");
    Ok(stream.into_bytes())
}

fn compress_zpl(mono: &[u8], stride: usize, height: usize) -> String {
    let mut output = String::new();
    let mut previous = String::new();
    for row in 0..height {
        let bytes = &mono[row * stride..(row + 1) * stride];
        let hex = bytes
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        if row > 0 && hex == previous {
            output.push(':');
        } else if bytes.iter().all(|byte| *byte == 0) {
            output.push(',');
        } else if bytes.iter().all(|byte| *byte == 0xff) {
            output.push('!');
        } else {
            output.push_str(&compress_row(&hex));
        }
        previous = hex;
    }
    output
}

fn compress_row(row: &str) -> String {
    let chars: Vec<char> = row.chars().collect();
    let mut output = String::new();
    let mut index = 0;
    while index < chars.len() {
        let mut count = 1;
        while index + count < chars.len() && chars[index + count] == chars[index] {
            count += 1;
        }
        if count >= 2 {
            output.push_str(&repeat_count(count));
        }
        output.push(chars[index]);
        index += count;
    }
    output
}

fn repeat_count(mut count: usize) -> String {
    let mut result = String::new();
    while count >= 20 {
        let high = (count / 20).min(20);
        result.push(char::from_u32('f' as u32 + high as u32).unwrap());
        count -= high * 20;
    }
    if count > 0 {
        result.push(char::from_u32('F' as u32 + count as u32).unwrap());
    }
    result
}

fn encode_tspl(bitmap: &RasterizedLabel, config: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let dpi = finite(config.get("dpi")).unwrap_or(203.0);
    let width_mm = bitmap.width_dots as f64 * 25.4 / dpi;
    let height_mm = bitmap.height_dots as f64 * 25.4 / dpi;
    let density = (finite(config.get("darkness")).unwrap_or(15.0) / 2.0)
        .round()
        .clamp(0.0, 15.0);
    let speed = finite(config.get("printSpeed"))
        .unwrap_or(4.0)
        .round()
        .clamp(1.0, 12.0);
    let gap = finite(config.get("gapMm")).unwrap_or(2.0).max(0.0);
    let mut bytes = format!("SIZE {width_mm:.2} mm,{height_mm:.2} mm\r\nGAP {gap} mm,0 mm\r\nSPEED {speed}\r\nDENSITY {density}\r\nCLS\r\nBITMAP 0,0,{},{},0,", bitmap.bytes_per_row, bitmap.height_dots).into_bytes();
    bytes.extend_from_slice(&bitmap.mono);
    bytes.extend_from_slice(b"\r\nPRINT 1,1\r\n");
    Ok(bytes)
}

fn encode_epl(bitmap: &RasterizedLabel, config: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let dpi = finite(config.get("dpi")).unwrap_or(203.0);
    let gap = (finite(config.get("gapMm")).unwrap_or(2.0) * dpi / 25.4)
        .round()
        .max(0.0) as usize;
    let mut bytes = format!(
        "N\nq{}\nQ{},{}\nGW0,0,{},{},",
        bitmap.width_dots, bitmap.height_dots, gap, bitmap.bytes_per_row, bitmap.height_dots
    )
    .into_bytes();
    bytes.extend_from_slice(&bitmap.mono);
    bytes.extend_from_slice(b"\nP1\n");
    Ok(bytes)
}

fn encode_cpcl(bitmap: &RasterizedLabel, config: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let dpi = finite(config.get("dpi")).unwrap_or(203.0).round() as usize;
    let hex = bitmap
        .mono
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    Ok(format!(
        "! 0 {dpi} {dpi} {} 1\r\nPAGE-WIDTH {}\r\nEG {} {} 0 0 {hex}\r\nFORM\r\nPRINT\r\n",
        bitmap.height_dots, bitmap.width_dots, bitmap.bytes_per_row, bitmap.height_dots
    )
    .into_bytes())
}

fn encode_dpl(bitmap: &RasterizedLabel, config: &Map<String, Value>) -> Result<Vec<u8>, String> {
    if bitmap.width_dots > 9_999 || bitmap.height_dots > 9_999 {
        return Err("DPL raster dimensions must be in 1..9999 dots".to_owned());
    }
    let name = format!("LP{:08X}", fnv1a(bitmap));
    let bmp = encode_bmp8(
        bitmap,
        finite(config.get("dpi")).unwrap_or(203.0).round() as u32,
    )?;
    let mut output = format!("\x02xD{name}\r\x02IDb{name}\r").into_bytes();
    output.extend_from_slice(&bmp);
    output.extend_from_slice(format!("\r\x02L\rD11\r1Y1100000000000{name}\rQ0001\rE\r").as_bytes());
    Ok(output)
}

fn encode_bmp8(bitmap: &RasterizedLabel, dpi: u32) -> Result<Vec<u8>, String> {
    let row_bytes = (bitmap.width_dots + 3) & !3;
    let pixel_bytes = row_bytes
        .checked_mul(bitmap.height_dots)
        .ok_or("DPL BMP size overflow")?;
    let pixel_offset = 14 + 40 + 256 * 4;
    let file_size = pixel_offset + pixel_bytes;
    if file_size > MAX_OUTPUT_BYTES - 256 {
        return Err("DPL BMP exceeds output limit".to_owned());
    }
    let mut bmp = vec![0_u8; file_size];
    bmp[0..2].copy_from_slice(b"BM");
    put_u32(&mut bmp, 2, file_size as u32);
    put_u32(&mut bmp, 10, pixel_offset as u32);
    put_u32(&mut bmp, 14, 40);
    put_u32(&mut bmp, 18, bitmap.width_dots as u32);
    put_u32(&mut bmp, 22, bitmap.height_dots as u32);
    put_u16(&mut bmp, 26, 1);
    put_u16(&mut bmp, 28, 8);
    put_u32(&mut bmp, 34, pixel_bytes as u32);
    let ppm = ((dpi as f64) / 0.0254).round().max(1.0) as u32;
    put_u32(&mut bmp, 38, ppm);
    put_u32(&mut bmp, 42, ppm);
    put_u32(&mut bmp, 46, 256);
    put_u32(&mut bmp, 50, 2);
    for value in 0..256 {
        let at = 54 + value * 4;
        bmp[at] = value as u8;
        bmp[at + 1] = value as u8;
        bmp[at + 2] = value as u8;
    }
    for sy in 0..bitmap.height_dots {
        let target = pixel_offset + (bitmap.height_dots - 1 - sy) * row_bytes;
        for x in 0..bitmap.width_dots {
            bmp[target + x] =
                if bitmap.mono[sy * bitmap.bytes_per_row + (x >> 3)] & (0x80 >> (x & 7)) != 0 {
                    0
                } else {
                    255
                };
        }
        bmp[target + bitmap.width_dots..target + row_bytes].fill(255);
    }
    Ok(bmp)
}

fn encode_sbpl(bitmap: &RasterizedLabel) -> Result<Vec<u8>, String> {
    let horizontal = bitmap.width_dots.div_ceil(8);
    let vertical = bitmap.height_dots.div_ceil(8);
    if bitmap.width_dots > 9_999 || bitmap.height_dots > 9_999 || horizontal > 999 || vertical > 999
    {
        return Err("SBPL raster dimensions exceed command bounds".to_owned());
    }
    let mut hex = String::with_capacity(horizontal * vertical * 16);
    for block_y in 0..vertical {
        for block_x in 0..horizontal {
            for row in 0..8 {
                let y = block_y * 8 + row;
                let byte = if y < bitmap.height_dots {
                    bitmap.mono[y * bitmap.bytes_per_row + block_x]
                } else {
                    0
                };
                hex.push_str(&format!("{byte:02X}"));
            }
        }
    }
    Ok(format!(
        "\x1bA\x1bA1{:04}{:04}\x1bH0000\x1bV0000\x1bGH{:03}{:03}{hex}\x1bQ1\x1bZ",
        bitmap.height_dots, bitmap.width_dots, horizontal, vertical
    )
    .into_bytes())
}

fn fnv1a(bitmap: &RasterizedLabel) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for value in bitmap
        .mono
        .iter()
        .copied()
        .chain(bitmap.width_dots.to_le_bytes())
        .chain(bitmap.height_dots.to_le_bytes())
    {
        hash ^= u32::from(value);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn put_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn interpolate(template: &str, data: &Map<String, Value>) -> String {
    let lower = data
        .iter()
        .map(|(key, value)| (key.to_lowercase(), value))
        .collect::<std::collections::HashMap<_, _>>();
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };
        let key = after[..end].trim();
        if let Some(value) = data
            .get(key)
            .or_else(|| lower.get(&key.to_lowercase()).copied())
        {
            output.push_str(&value_text(value));
        } else {
            output.push_str(&rest[start..start + 2 + end + 2]);
        }
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    output
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))
}
fn finite(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}
fn string(value: Option<&Value>) -> Option<&str> {
    value?.as_str()
}
fn scaled(element: &Map<String, Value>, field: &str, scale: f32) -> f32 {
    finite(element.get(field)).unwrap_or(0.0) as f32 * scale
}
fn normalize_barcode(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
    match normalized.as_str() {
        "21" | "ean13" | "ean-13" | "ean13-kz" | "ean13kz" => "ean13",
        "22" | "ean8" | "ean-8" => "ean8",
        "23" | "code128" | "code-128" => "code128",
        "gs1-128" | "gs1128" | "ean128" => "gs1-128",
        "upc" | "upca" | "upc-a" => "upca",
        "upce" | "upc-e" => "upce",
        "qr" | "qrcode" => "qrcode",
        "gs1qr" | "gs1qrcode" | "qrdatabar" | "gs-1" => "gs1qrcode",
        "datamatrix" | "dm" => "datamatrix",
        "gs1datamatrix" | "gs1dm" => "gs1datamatrix",
        "databar" | "gs1databar" | "databarexpandedstacked" => "databarexpandedstacked",
        "itf" | "itf14" | "itf-14" | "i2of5" | "interleaved2of5" => "interleaved2of5",
        "code39" | "code-39" => "code39",
        "pdf417" => "pdf417",
        "aztec" | "azteccode" => "azteccode",
        "" => "code128",
        other => other,
    }
    .to_owned()
}

fn set_pixel(mono: &mut [u8], stride: usize, geometry: Geometry, x: i32, y: i32) {
    if x >= 0 && y >= 0 && (x as usize) < geometry.width_dots && (y as usize) < geometry.height_dots
    {
        mono[y as usize * stride + (x as usize >> 3)] |= 0x80 >> (x as usize & 7);
    }
}
fn fill_rect(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    for py in y.max(0)..(y + height).min(geometry.height_dots as i32) {
        for px in x.max(0)..(x + width).min(geometry.width_dots as i32) {
            set_pixel(mono, stride, geometry, px, py);
        }
    }
}
fn line_h(mono: &mut [u8], stride: usize, geometry: Geometry, x: i32, y: i32, width: i32) {
    fill_rect(mono, stride, geometry, x, y, width, 1);
}
fn line_v(mono: &mut [u8], stride: usize, geometry: Geometry, x: i32, y: i32, height: i32) {
    fill_rect(mono, stride, geometry, x, y, 1, height);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_unicode_inter_text_and_ean13_to_zpl_bitmap() {
        let payload = GenerationPayload {
            config: json!({"protocol":"image","dpi":300}),
            doc: json!({"canvas":{"width":600,"height":300,"widthCm":5.08,"heightCm":2.54,"dpi":300},"elements":[
                {"id":"t","type":"text","x":10,"y":10,"w":580,"h":100,"text":"Этикетка {{name}}","fontFamily":"Inter","fontSize":24,"fontWeight":600,"textAlign":"center"},
                {"id":"b","type":"barcode","x":100,"y":140,"w":400,"h":120,"barcodeType":"ean13","value":"{{barcode}}","showText":true}
            ]}),
            data: json!({"name":"готова","barcode":"4870254930240"}),
        };
        let bitmap = render(&payload).unwrap();
        assert!(bitmap.mono.iter().any(|byte| *byte != 0));
        assert_eq!(bitmap.native_zpl_commands.len(), 1);
        let zpl = encode("image", &bitmap, &payload.config).unwrap();
        assert!(zpl.starts_with(b"^XA"));
        assert!(zpl.ends_with(b"^XZ"));
        assert!(String::from_utf8(zpl).unwrap().contains("^BEN"));
    }
    fn tiny_png_data_uri() -> String {
        use image::{ImageFormat, RgbaImage};
        let image = RgbaImage::from_fn(4, 3, |x, y| {
            if (x + y) % 2 == 0 {
                Rgba([0, 0, 0, 255])
            } else {
                Rgba([255, 255, 255, 255])
            }
        });
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(bytes.into_inner())
        )
    }

    fn barcode_payload(dpi: u32, kind: &str, value: &str) -> GenerationPayload {
        GenerationPayload {
            config: json!({
                "connection": "windows_driver",
                "protocol": "image",
                "dpi": dpi
            }),
            doc: json!({
                "canvas": {
                    "width": 600,
                    "height": 400,
                    "widthCm": 6.0,
                    "heightCm": 4.0,
                    "dpi": 254
                },
                "elements": [{
                    "id": "matrix",
                    "type": "barcode",
                    "x": 20,
                    "y": 20,
                    "w": 560,
                    "h": 360,
                    "barcodeType": kind,
                    "value": "{{barcode}}",
                    "showText": false
                }]
            }),
            data: json!({"barcode": value}),
        }
    }

    #[test]
    fn renders_fourteen_symbologies_at_203_300_and_600_dpi() {
        let cases = [
            ("ean13", "4870254930134"),
            ("ean8", "96385074"),
            ("upca", "036000291452"),
            ("upce", "04252614"),
            ("code128", "LP-2026-000001"),
            ("gs1-128", "(01)04870254930134(10)BATCH26"),
            ("qrcode", "https://labelpilot.local/LP-2026-000001"),
            ("gs1qrcode", "(01)04870254930134(10)BATCH26"),
            ("datamatrix", "LP:2026:000001"),
            ("gs1datamatrix", "(01)04870254930134(10)BATCH26"),
            ("pdf417", "LP|2026|000001|BATCH26"),
            ("code39", "LP2026000001"),
            ("interleaved2of5", "12345678901234"),
            ("azteccode", "LP:2026:000001"),
        ];
        for dpi in [203, 300, 600] {
            for (kind, value) in cases {
                let bitmap = render(&barcode_payload(dpi, kind, value))
                    .unwrap_or_else(|error| panic!("{kind} at {dpi} DPI: {error}"));
                assert!(
                    bitmap.mono.iter().any(|byte| *byte != 0),
                    "{kind} at {dpi} DPI rendered blank"
                );
                assert!(bitmap.native_zpl_commands.is_empty());
            }
        }
    }

    #[test]
    fn hybrid_zpl_keeps_only_safe_linear_barcode_native() {
        let payload = GenerationPayload {
            config: json!({"connection":"tcp","protocol":"image","dpi":300}),
            doc: json!({"canvas":{"width":600,"height":400,"widthCm":6.0,"heightCm":4.0,"dpi":254},"elements":[
                {"id":"text","type":"text","x":10,"y":5,"w":580,"h":60,"text":"Партия {{batch}}","fontSize":20},
                {"id":"qr","type":"barcode","x":30,"y":80,"w":180,"h":180,"barcodeType":"qrcode","value":"{{qr}}"},
                {"id":"gs1","type":"barcode","x":230,"y":80,"w":340,"h":110,"barcodeType":"gs1-128","value":"{{gs1}}"},
                {"id":"linear","type":"barcode","x":230,"y":220,"w":340,"h":110,"barcodeType":"code128","value":"{{linear}}"}
            ]}),
            data: json!({
                "batch":"A-26",
                "qr":"https://labelpilot.local/A-26",
                "gs1":"(01)04870254930134(10)A26",
                "linear":"LP-A26-0001"
            }),
        };
        let bitmap = render(&payload).unwrap();
        assert_eq!(bitmap.native_zpl_commands.len(), 1);
        assert!(bitmap.native_zpl_commands[0].contains("^BCN"));
        let stream = String::from_utf8(encode("image", &bitmap, &payload.config).unwrap()).unwrap();
        assert!(stream.contains("^GFA"));
        assert!(stream.contains("LP-A26-0001"));
        assert!(!stream.contains("(01)"));
    }

    #[test]
    fn parses_variable_length_gs1_fields_with_group_separator() {
        assert_eq!(
            gs1_content("(01)04870254930134(10)BATCH26(17)260831").unwrap(),
            "010487025493013410BATCH26\u{1d}17260831"
        );
        assert_eq!(
            gs1_content("(01)04870254930134(17)260831").unwrap(),
            "010487025493013417260831"
        );
        assert!(gs1_content("(XX)broken").is_err());
        assert_eq!(
            rxing_content(
                "(01)04870254930134(10)BATCH26(17)260831",
                BarcodeFormat::CODE_128,
                true
            )
            .unwrap(),
            "\u{f1}010487025493013410BATCH26\u{f1}17260831"
        );
        assert_eq!(
            rxing_content("(01)04870254930134(17)260831", BarcodeFormat::QR_CODE, true).unwrap(),
            "010487025493013417260831"
        );
    }

    #[test]
    fn renders_embedded_image_and_server_databar_preview() {
        let image = tiny_png_data_uri();
        let payload = GenerationPayload {
            config: json!({"connection":"windows_driver","protocol":"image","dpi":300}),
            doc: json!({"canvas":{"width":400,"height":240,"widthCm":4.0,"heightCm":2.4,"dpi":254},"elements":[
                {"id":"logo","type":"image","x":10,"y":10,"w":120,"h":100,"rotation":90,"imageData":image},
                {"id":"databar","type":"barcode","x":150,"y":20,"w":230,"h":180,"barcodeType":"databarexpandedstacked","value":"{{missing}}","imageData":image}
            ]}),
            data: json!({}),
        };
        let bitmap = render(&payload).unwrap();
        assert!(bitmap.mono.iter().any(|byte| *byte != 0));
        assert!(bitmap.native_zpl_commands.is_empty());
    }

    #[test]
    fn rejects_external_or_malformed_image_sources_before_decode() {
        assert!(image_source_bytes("https://labelpilot.local/logo.png").is_err());
        assert!(image_source_bytes("data:image/png,not-base64").is_err());
        assert!(decode_image_source("not base64!").is_err());
        assert!(quarter_turns(45.0).is_err());
    }
    #[test]
    fn renders_external_readonly_label_database_when_configured() {
        let Some(path) = std::env::var_os("LABELPILOT_NATIVE_TEMPLATE_DB") else {
            return;
        };
        let connection = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        let mut statement = connection
            .prepare("SELECT id, structure FROM labels ORDER BY id")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        let mut rendered = 0_usize;
        for row in rows {
            let (id, structure) = row.unwrap();
            let doc: Value = serde_json::from_str(&structure).unwrap();
            let payload = GenerationPayload {
                config: json!({
                    "connection":"windows_driver",
                    "protocol":"image",
                    "dpi":300
                }),
                doc,
                data: json!({
                    "barcode":"4870254930134",
                    "pack_number":"07000001",
                    "box_number":"07000001",
                    "pallet_number":"P-000001",
                    "name":"Проверка реального шаблона",
                    "batch_number":"B-26",
                    "weight_netto":"1.000",
                    "weight_netto_pack":"1.000",
                    "weight_netto_box":"10.000",
                    "weight_netto_pallet":"100.000",
                    "production_date":"24.08.2026",
                    "expiration_date":"03.09.2026",
                    "items":[{
                        "name":"Проверка",
                        "quantity":1,
                        "weight_netto_pack":"1.000",
                        "batch_number":"B-26"
                    }]
                }),
            };
            let bitmap =
                render(&payload).unwrap_or_else(|error| panic!("real label {id}: {error}"));
            assert!(
                bitmap.mono.iter().any(|byte| *byte != 0),
                "real label {id} is blank"
            );
            rendered += 1;
        }
        assert!(rendered > 0);
    }
}
