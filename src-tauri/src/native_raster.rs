use crate::generator::GenerationPayload;
use ab_glyph::{point, Font, Glyph, GlyphId, PxScale, ScaleFont};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::{DynamicImage, GenericImageView, ImageReader, Limits, Rgba};
use rxing::{BarcodeFormat, EncodeHints, MultiFormatWriter, Writer};
use serde_json::{Map, Value};
use std::io::{Cursor, Write};
use std::time::Instant;

const MAX_BITMAP_PIXELS: usize = 9_000_000;
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_SOURCE_PIXELS: u64 = 16_000_000;
const MAX_BARCODE_VALUE_BYTES: usize = 4_096;
const MAX_ZPL_RASTER_REGIONS: usize = 64;
const ZPL_RASTER_ROW_GAP: usize = 4;
const ZPL_RASTER_COLUMN_GAP_BYTES: usize = 8;
const RXING_CODE128_FNC1: char = '\u{00f1}';

#[derive(Clone, Debug)]
pub struct RasterRegion {
    pub x_dots: usize,
    pub y_dots: usize,
    pub height_dots: usize,
    pub bytes_per_row: usize,
    pub mono: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct RasterizedLabel {
    pub width_dots: usize,
    pub height_dots: usize,
    pub bytes_per_row: usize,
    pub width_mm: f64,
    pub height_mm: f64,
    pub mono: Vec<u8>,
    pub native_zpl_commands: Vec<String>,
    /// Some means the renderer was allowed to separate ZPL-native fields from
    /// tightly cropped bitmap regions. An empty vector is a native-only label.
    pub zpl_raster_regions: Option<Vec<RasterRegion>>,
    pub render_micros: u64,
}

mod font;
pub(crate) use font::warmup_static_assets;
use font::{css_px_scale, font_for, RasterFont};

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
            "rect" if supports_zpl_commands => {
                if let Some(command) = zpl_rect(element, geometry) {
                    if !command.is_empty() {
                        native_zpl_commands.push(command);
                    }
                } else {
                    draw_rect(&mut mono, bytes_per_row, geometry, element);
                }
            }
            "rect" => draw_rect(&mut mono, bytes_per_row, geometry, element),
            "table" => {
                draw_table(&mut mono, bytes_per_row, geometry, element, data)?;
            }
            "image" => draw_image(&mut mono, bytes_per_row, geometry, element)?,
            "barcode" if supports_zpl_commands && native_zpl_barcode_eligible(element, data)? => {
                native_zpl_commands.push(zpl_barcode(element, data, geometry)?);
            }
            "barcode" => draw_barcode(&mut mono, bytes_per_row, geometry, element, data)?,
            other => return Err(format!("unsupported native raster element: {other}")),
        }
    }
    let zpl_raster_regions = supports_zpl_commands
        .then(|| zpl_raster_regions(&mono, bytes_per_row, geometry.height_dots));
    Ok(RasterizedLabel {
        width_dots: geometry.width_dots,
        height_dots: geometry.height_dots,
        bytes_per_row,
        width_mm: geometry.width_mm,
        height_mm: geometry.height_mm,
        mono,
        native_zpl_commands,
        zpl_raster_regions,
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

struct TextLayout {
    font: &'static RasterFont,
    font_size: f32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    line_height: f32,
    start_y: f32,
    lines: Vec<String>,
}

/// Wrap in authored CSS pixels, before applying printer DPI. Rounding a box
/// in output dots must not change the line breaks at 203/300/600 DPI.
fn text_layout(element: &Map<String, Value>, data: &Map<String, Value>) -> TextLayout {
    let x = finite(element.get("x")).unwrap_or(0.0) as f32;
    let y = finite(element.get("y")).unwrap_or(0.0) as f32;
    let width = (finite(element.get("w")).unwrap_or(1.0) as f32).max(1.0);
    let height = (finite(element.get("h")).unwrap_or(1.0) as f32).max(1.0);
    let font_size = (finite(element.get("fontSize")).unwrap_or(12.0) as f32).max(1.0);
    let weight = finite(element.get("fontWeight")).unwrap_or_else(|| {
        if string(element.get("fontWeight")).is_some_and(|value| value.eq_ignore_ascii_case("bold"))
        {
            700.0
        } else {
            400.0
        }
    });
    let font = font_for(
        string(element.get("fontFamily")).unwrap_or("Inter"),
        weight >= 600.0,
    );
    let text = interpolate(string(element.get("text")).unwrap_or_default(), data);
    let lines = wrap_text(font, css_px_scale(font, font_size), &text, width);
    let line_height = font_size * 1.2;
    let block_height = lines.len() as f32 * line_height;
    let start_y = match string(element.get("verticalAlign")).unwrap_or("middle") {
        "top" => y,
        "bottom" => y + height - block_height,
        _ => y + (height - block_height) / 2.0,
    };
    TextLayout {
        font,
        font_size,
        x,
        y,
        width,
        height,
        line_height,
        start_y,
        lines,
    }
}

#[derive(Clone, Copy)]
struct TextTransform {
    turns: u8,
    source_center: (f32, f32),
    target_center: (f32, f32),
}

impl TextTransform {
    const IDENTITY: Self = Self {
        turns: 0,
        source_center: (0.0, 0.0),
        target_center: (0.0, 0.0),
    };

    fn point(self, x: f32, y: f32) -> (f32, f32) {
        if self.turns == 0 {
            return (x, y);
        }
        let dx = x - self.source_center.0;
        let dy = y - self.source_center.1;
        let (dx, dy) = match self.turns {
            1 => (-dy, dx),
            2 => (-dx, -dy),
            _ => (dy, -dx),
        };
        (self.target_center.0 + dx, self.target_center.1 + dy)
    }

    fn pixel(self, x: i32, y: i32) -> (i32, i32) {
        if self.turns == 0 {
            return (x, y);
        }
        let (x, y) = self.point(x as f32 + 0.5, y as f32 + 0.5);
        ((x - 0.5).round() as i32, (y - 0.5).round() as i32)
    }
}

fn draw_text(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    element: &Map<String, Value>,
    data: &Map<String, Value>,
) -> Result<(), String> {
    let layout = text_layout(element, data);
    // Preserve the established quarter-turn contract. Other angles retain the
    // unrotated layout. Transform pixels after rasterizing; no box-sized
    // temporary bitmap is needed, and overflowing text stays visible.
    let turns = quarter_turns(finite(element.get("rotation")).unwrap_or(0.0)).unwrap_or(0);
    let (scale_x, scale_y) = if matches!(turns, 1 | 3) {
        (geometry.scale_y, geometry.scale_x)
    } else {
        (geometry.scale_x, geometry.scale_y)
    };
    let center = (
        layout.x + layout.width / 2.0,
        layout.y + layout.height / 2.0,
    );
    let transform = TextTransform {
        turns,
        source_center: (center.0 * scale_x, center.1 * scale_y),
        target_center: (center.0 * geometry.scale_x, center.1 * geometry.scale_y),
    };
    let source_scale = css_px_scale(layout.font, layout.font_size);
    let scale = PxScale {
        x: source_scale.x * scale_x,
        y: source_scale.y * scale_y,
    };
    // CSS line boxes distribute leading equally above ascent and below
    // descent, even when the authored line-height is smaller than the font.
    let leading = (layout.line_height - source_scale.y) / 2.0;
    let align = string(element.get("textAlign")).unwrap_or("left");
    // The designer uses overflow:visible on text; only the label clips ink.
    let clip = (
        0,
        0,
        geometry.width_dots as i32,
        geometry.height_dots as i32,
    );
    for (index, line) in layout.lines.iter().enumerate() {
        let measured = measure_text(layout.font, source_scale, line);
        let line_x = layout.x
            + match align {
                "center" => (layout.width - measured) / 2.0,
                "right" => layout.width - measured,
                _ => 0.0,
            };
        let line_y = layout.start_y + index as f32 * layout.line_height;
        draw_glyph_line_transformed(
            mono,
            stride,
            geometry,
            clip,
            layout.font,
            scale,
            line,
            line_x * scale_x,
            (line_y + leading) * scale_y,
            transform,
        );
        if string(element.get("textDecoration"))
            .unwrap_or_default()
            .contains("underline")
        {
            let x = line_x * scale_x;
            let y = (line_y + layout.font_size + 1.0) * scale_y;
            let (left, top) = transform.point(x, y);
            let (right, bottom) = transform.point(x + measured * scale_x, y + scale_y.max(1.0));
            fill_rect(
                mono,
                stride,
                geometry,
                left.min(right).round() as i32,
                top.min(bottom).round() as i32,
                (right - left).abs().round().max(1.0) as i32,
                (bottom - top).abs().round().max(1.0) as i32,
            );
        }
    }
    Ok(())
}

/// Canonical word wrap: breaks on spaces and hard-splits words wider than the
/// line (mirrors wrapText from the server's table renderer).
fn wrap_text(font: &RasterFont, scale: PxScale, text: &str, width: f32) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = String::new();
        for word in paragraph.split(' ') {
            if measure_text(font, scale, word) > width {
                if !current.is_empty() {
                    lines.push(std::mem::take(&mut current));
                }
                for character in word.chars() {
                    let candidate = format!("{current}{character}");
                    if measure_text(font, scale, &candidate) > width && !current.is_empty() {
                        lines.push(std::mem::take(&mut current));
                    }
                    current.push(character);
                }
                continue;
            }
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

fn measure_text(font: &RasterFont, scale: PxScale, text: &str) -> f32 {
    let shaped = font.shape(text);
    let advance: i64 = shaped
        .glyph_positions()
        .iter()
        .map(|position| i64::from(position.x_advance))
        .sum();
    advance as f32 * scale.x / font.height_unscaled()
}

#[allow(clippy::too_many_arguments)]
fn draw_glyph_line(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    clip: (i32, i32, i32, i32),
    font: &RasterFont,
    scale: PxScale,
    text: &str,
    x: f32,
    top: f32,
) {
    draw_glyph_line_transformed(
        mono,
        stride,
        geometry,
        clip,
        font,
        scale,
        text,
        x,
        top,
        TextTransform::IDENTITY,
    );
}

#[allow(clippy::too_many_arguments)]
fn draw_glyph_line_transformed(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    clip: (i32, i32, i32, i32),
    font: &RasterFont,
    scale: PxScale,
    text: &str,
    x: f32,
    top: f32,
    transform: TextTransform,
) {
    let baseline = top + font.as_scaled(scale).ascent();
    let factor_x = scale.x / font.height_unscaled();
    let factor_y = scale.y / font.height_unscaled();
    let shaped = font.shape(text);
    let mut cursor_x = 0_i64;
    let mut cursor_y = 0_i64;
    for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
        let glyph = Glyph {
            id: GlyphId(info.glyph_id as u16),
            scale,
            position: point(
                x + (cursor_x + i64::from(position.x_offset)) as f32 * factor_x,
                baseline - (cursor_y + i64::from(position.y_offset)) as f32 * factor_y,
            ),
        };
        if let Some(outline) = font.outline_glyph(glyph) {
            let bounds = outline.px_bounds();
            outline.draw(|gx, gy, coverage| {
                if coverage < 0.32 {
                    return;
                }
                let (px, py) = transform.pixel(
                    bounds.min.x as i32 + gx as i32,
                    bounds.min.y as i32 + gy as i32,
                );
                if px >= clip.0 && py >= clip.1 && px < clip.2 && py < clip.3 {
                    set_pixel(mono, stride, geometry, px, py);
                }
            });
        }
        cursor_x += i64::from(position.x_advance);
        cursor_y += i64::from(position.y_advance);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TableSummary {
    total_rows: usize,
    drawn_rows: usize,
}

struct TableColumn {
    key: String,
    title: String,
    width: i32,
}

fn draw_table(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    element: &Map<String, Value>,
    data: &Map<String, Value>,
) -> Result<TableSummary, String> {
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
    let raw_font_size = finite(element.get("fontSize")).unwrap_or(10.0);
    let font_size = (raw_font_size as f32 * geometry.scale_y).max(6.0);
    let padding = (4.0 * geometry.scale_x.min(geometry.scale_y))
        .round()
        .max(1.0) as i32;
    let line_height = font_size * 1.1;
    let row_height = (font_size * 1.5).round().max(1.0) as i32;
    let show_headers = element.get("showHeaders").and_then(Value::as_bool) != Some(false);
    let show_borders = element.get("showBorders").and_then(Value::as_bool) != Some(false);
    let family = string(element.get("fontFamily"))
        .unwrap_or("Inter")
        .to_owned();
    let body_font = font_for(&family, false);
    let bold_font = font_for(&family, true);
    let body_scale = css_px_scale(body_font, font_size);
    let bold_scale = css_px_scale(bold_font, font_size);
    let clip = (
        x.max(0),
        y.max(0),
        (x + width).min(geometry.width_dots as i32),
        (y + height).min(geometry.height_dots as i32),
    );
    let right = x + width;
    let bottom = y + height;
    let footer_height = (row_height as f32 * 3.0).round() as i32;
    let body_limit = bottom - footer_height;

    let mut table_columns = Vec::with_capacity(columns.len());
    let mut used = 0_i32;
    for (index, raw_column) in columns.iter().enumerate() {
        let column = object(raw_column, "table column")?;
        let ratio = finite(column.get("widthRatio")).unwrap_or(100.0 / columns.len() as f64);
        let cell_width = if index + 1 == columns.len() {
            (width - used).max(1)
        } else {
            ((width as f64 * ratio / 100.0).round().max(1.0) as i32).max(1)
        };
        let key = string(column.get("key")).unwrap_or_default().to_owned();
        let title = string(column.get("title"))
            .filter(|value| !value.is_empty())
            .unwrap_or(&key)
            .to_owned();
        table_columns.push(TableColumn {
            key,
            title,
            width: cell_width,
        });
        used += cell_width;
    }

    // Rows come from data.items[] (canonical draw-table.ts); a table without
    // items renders the whole data object as a single row.
    let fallback_row = Value::Object(data.clone());
    let mut items: Vec<&Value> = match data.get("items") {
        Some(Value::Array(values)) => values.iter().collect(),
        _ => vec![&fallback_row],
    };
    if let Some(max_rows) = finite(element.get("maxRows")).filter(|value| *value > 0.0) {
        items.truncate(max_rows.round() as usize);
    }
    sort_table_items(
        &mut items,
        string(element.get("sortBy")).unwrap_or_default(),
    );
    let total_count = items.len();

    let mut current_y = y;
    let mut header_height = 0;
    if show_headers {
        let mut header_cells: Vec<(i32, Vec<String>)> = Vec::with_capacity(table_columns.len());
        let mut max_lines = 1;
        let mut current_x = x;
        for column in &table_columns {
            let inner = (column.width - padding * 2).max(1) as f32;
            let lines = wrap_text(bold_font, bold_scale, &column.title, inner);
            max_lines = max_lines.max(lines.len());
            header_cells.push((current_x, lines));
            current_x += column.width;
        }
        header_height =
            row_height.max((max_lines as f32 * line_height).round() as i32 + padding * 2);
        for (cell_x, lines) in &header_cells {
            for (line_index, line) in lines.iter().enumerate() {
                let top = y as f32 + padding as f32 + line_index as f32 * line_height;
                draw_glyph_line(
                    mono,
                    stride,
                    geometry,
                    clip,
                    bold_font,
                    bold_scale,
                    line,
                    (cell_x + padding) as f32,
                    top,
                );
            }
        }
        current_y += header_height;
    }

    if show_borders {
        line_h(mono, stride, geometry, x, y, width);
        line_h(mono, stride, geometry, x, bottom - 1, width);
        line_v(mono, stride, geometry, x, y, height);
        line_v(mono, stride, geometry, right - 1, y, height);
        if show_headers {
            line_h(mono, stride, geometry, x, y + header_height, width);
        }
        let mut current_x = x;
        for column in &table_columns[..table_columns.len() - 1] {
            current_x += column.width;
            line_v(mono, stride, geometry, current_x, y, height);
        }
    }

    let mut drawn_count = 0_usize;
    let group_by = string(element.get("groupBy"))
        .unwrap_or_default()
        .to_owned();
    if group_by == "nomenclature" || group_by == "batch" {
        let field = if group_by == "batch" {
            "batch_number"
        } else {
            "name"
        };
        let mut order: Vec<String> = Vec::new();
        let mut groups: std::collections::HashMap<String, Vec<&Value>> =
            std::collections::HashMap::new();
        for item in &items {
            let key = table_row_value(item, field).unwrap_or_else(|| "—".to_owned());
            let key = if key.is_empty() {
                "—".to_owned()
            } else {
                key
            };
            if !groups.contains_key(&key) {
                order.push(key.clone());
            }
            groups.entry(key).or_default().push(item);
        }
        'groups: for key in &order {
            let group_items = &groups[key];
            let label = table_group_label(
                &group_by,
                key,
                group_items.first().and_then(|value| value.as_object()),
            );
            match draw_table_group_header(
                mono,
                stride,
                geometry,
                clip,
                bold_font,
                bold_scale,
                &label,
                x,
                current_y,
                row_height,
                padding,
                body_limit,
                width,
                show_borders,
            )? {
                Some(band_height) => current_y += band_height,
                None => break,
            }
            for item in group_items {
                match draw_table_row(
                    mono,
                    stride,
                    geometry,
                    clip,
                    &table_columns,
                    body_font,
                    body_scale,
                    line_height,
                    padding,
                    row_height,
                    x,
                    current_y,
                    body_limit,
                    width,
                    show_borders,
                    item,
                )? {
                    Some(row_height) => {
                        current_y += row_height;
                        drawn_count += 1;
                    }
                    None => break 'groups,
                }
            }
        }
    } else {
        for item in &items {
            match draw_table_row(
                mono,
                stride,
                geometry,
                clip,
                &table_columns,
                body_font,
                body_scale,
                line_height,
                padding,
                row_height,
                x,
                current_y,
                body_limit,
                width,
                show_borders,
                item,
            )? {
                Some(row_height) => {
                    current_y += row_height;
                    drawn_count += 1;
                }
                None => break,
            }
        }
    }

    if total_count > 0 {
        line_h(mono, stride, geometry, x, body_limit, width);
        let footer_text = table_footer_text(total_count, drawn_count);
        let footer_size =
            ((raw_font_size * 1.8).round().max(13.0) as f32 * geometry.scale_y).max(1.0);
        let footer_scale = css_px_scale(bold_font, footer_size);
        let scaled_font = bold_font.as_scaled(footer_scale);
        let em_height = scaled_font.ascent() - scaled_font.descent();
        let middle = body_limit as f32 + footer_height as f32 / 2.0;
        let top = middle - em_height / 2.0;
        draw_glyph_line(
            mono,
            stride,
            geometry,
            clip,
            bold_font,
            footer_scale,
            &footer_text,
            (x + padding * 2) as f32,
            top,
        );
    }

    Ok(TableSummary {
        total_rows: total_count,
        drawn_rows: drawn_count,
    })
}

fn table_footer_text(total: usize, drawn: usize) -> String {
    if drawn < total {
        let pages = ((total as f64 / drawn.max(1) as f64).ceil() as usize).max(2);
        format!("Стр. 1 / {pages}   ·   показано {drawn} из {total} позиций")
    } else {
        format!("Стр. 1 / 1   ·   всего {total} позиций")
    }
}

fn sort_table_items(items: &mut [&Value], sort_by: &str) {
    match sort_by {
        "name" => items.sort_by(|a, b| {
            ru_order(
                &table_row_value(a, "name").unwrap_or_default(),
                &table_row_value(b, "name").unwrap_or_default(),
            )
        }),
        "date" => items.sort_by(|a, b| {
            table_row_value(a, "production_date_batch")
                .unwrap_or_default()
                .cmp(&table_row_value(b, "production_date_batch").unwrap_or_default())
        }),
        _ => {}
    }
}

/// Approximates `String.prototype.localeCompare(..., "ru")`: case-insensitive
/// with `ё` folded onto `е`.
fn ru_order(a: &str, b: &str) -> std::cmp::Ordering {
    fn key(value: &str) -> Vec<char> {
        value
            .to_lowercase()
            .chars()
            .map(|character| if character == 'ё' { 'е' } else { character })
            .collect()
    }
    key(a).cmp(&key(b))
}

fn table_row_value(row: &Value, key: &str) -> Option<String> {
    row.as_object().and_then(|map| map.get(key)).map(value_text)
}

/// Mirrors `processDynamicText` from the canonical table renderer: missing row
/// keys keep the literal `{{ key }}` placeholder, all-digit pack/box numbers
/// are zero-padded to 12 characters.
fn resolve_table_cell(key: &str, row: Option<&Map<String, Value>>) -> String {
    let Some(map) = row else {
        return format!("{{{{ {key} }}}}");
    };
    let value = map.get(key).or_else(|| {
        let lowered = key.to_lowercase();
        map.iter()
            .find(|(name, _)| name.to_lowercase() == lowered)
            .map(|(_, value)| value)
    });
    let Some(value) = value else {
        return format!("{{{{ {key} }}}}");
    };
    let mut text = value_text(value);
    if !text.is_empty()
        && text.chars().all(|character| character.is_ascii_digit())
        && matches!(key, "pack_number" | "box_number")
    {
        while text.len() < 12 {
            text.insert(0, '0');
        }
    }
    text
}

fn table_group_label(kind: &str, key: &str, first: Option<&Map<String, Value>>) -> String {
    if kind != "batch" {
        return key.to_owned();
    }
    let mut label = format!("Партия {key}");
    let production = first
        .and_then(|row| row.get("production_date_batch"))
        .map(value_text)
        .filter(|value| !value.is_empty());
    if let Some(value) = production {
        label.push_str(&format!(" · Произв.: {value}"));
    }
    let expiration = first
        .and_then(|row| row.get("exp_date_full"))
        .map(value_text)
        .filter(|value| !value.is_empty());
    if let Some(value) = expiration {
        label.push_str(&format!(" · Годен до: {value}"));
    }
    label
}

#[allow(clippy::too_many_arguments)]
fn draw_table_group_header(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    clip: (i32, i32, i32, i32),
    font: &RasterFont,
    scale: PxScale,
    label: &str,
    x: i32,
    y: i32,
    band_height: i32,
    padding: i32,
    body_limit: i32,
    width: i32,
    show_borders: bool,
) -> Result<Option<i32>, String> {
    if y + band_height > body_limit {
        return Ok(None);
    }
    let scaled_font = font.as_scaled(scale);
    let em_height = scaled_font.ascent() - scaled_font.descent();
    let middle = y as f32 + band_height as f32 / 2.0;
    let top = middle - em_height / 2.0;
    draw_glyph_line(
        mono,
        stride,
        geometry,
        clip,
        font,
        scale,
        label,
        (x + padding) as f32,
        top,
    );
    if show_borders {
        line_h(mono, stride, geometry, x, y + band_height, width);
    }
    Ok(Some(band_height))
}

#[allow(clippy::too_many_arguments)]
fn draw_table_row(
    mono: &mut [u8],
    stride: usize,
    geometry: Geometry,
    clip: (i32, i32, i32, i32),
    columns: &[TableColumn],
    font: &RasterFont,
    scale: PxScale,
    line_height: f32,
    padding: i32,
    min_row_height: i32,
    x: i32,
    y: i32,
    body_limit: i32,
    width: i32,
    show_borders: bool,
    row: &Value,
) -> Result<Option<i32>, String> {
    let mut max_lines = 1;
    let mut cell_lines: Vec<Vec<String>> = Vec::with_capacity(columns.len());
    for column in columns {
        let value = resolve_table_cell(&column.key, row.as_object());
        let inner = (column.width - padding * 2).max(1) as f32;
        let lines = wrap_text(font, scale, &value, inner);
        max_lines = max_lines.max(lines.len());
        cell_lines.push(lines);
    }
    let row_height =
        min_row_height.max((max_lines as f32 * line_height).round() as i32 + padding * 2);
    if y + row_height > body_limit {
        return Ok(None);
    }
    let mut current_x = x;
    for (index, column) in columns.iter().enumerate() {
        for (line_index, line) in cell_lines[index].iter().enumerate() {
            let top = y as f32 + padding as f32 + line_index as f32 * line_height;
            draw_glyph_line(
                mono,
                stride,
                geometry,
                clip,
                font,
                scale,
                line,
                (current_x + padding) as f32,
                top,
            );
        }
        current_x += column.width;
    }
    if show_borders {
        line_h(mono, stride, geometry, x, y + row_height, width);
    }
    Ok(Some(row_height))
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

fn zpl_rect(element: &Map<String, Value>, geometry: Geometry) -> Option<String> {
    if finite(element.get("borderRadius")).unwrap_or(0.0) != 0.0
        || finite(element.get("rotation")).unwrap_or(0.0) != 0.0
    {
        return None;
    }
    let x = scaled(element, "x", geometry.scale_x).round() as i32;
    let y = scaled(element, "y", geometry.scale_y).round() as i32;
    let width = scaled(element, "w", geometry.scale_x).round().max(1.0) as i32;
    let height = scaled(element, "h", geometry.scale_y).round().max(1.0) as i32;
    if x < 0
        || y < 0
        || x.saturating_add(width) > geometry.width_dots as i32
        || y.saturating_add(height) > geometry.height_dots as i32
    {
        return None;
    }
    let filled = string(element.get("fill"))
        .is_some_and(|fill| fill != "transparent" && fill != "#ffffff" && fill != "white");
    let border = (finite(element.get("borderWidth")).unwrap_or(0.0) as f32
        * geometry.scale_x.min(geometry.scale_y))
    .round()
    .max(0.0) as i32;
    if !filled && border == 0 {
        return Some(String::new());
    }
    let thickness = if filled {
        height
    } else {
        border.min(width).min(height)
    };
    Some(format!(
        "^FO{x},{y}^GB{width},{height},{thickness},B,0^FS\n"
    ))
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
    if has_gs1_ai(&value)
        || kind.starts_with("gs1")
        || kind.starts_with("databar")
        || crate::generator::zpl_barcode_requires_bitmap(&kind, &value)
    {
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
            return Err(format!(
                "native raster barcode {kind} has no Rust encoder; provide an embedded imageData preview or switch the template to a supported symbology"
            ));
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

fn zpl_raster_regions(mono: &[u8], stride: usize, height: usize) -> Vec<RasterRegion> {
    if stride == 0 || height == 0 || mono.is_empty() {
        return Vec::new();
    }
    let mut bands = Vec::new();
    let mut band_start = None;
    let mut last_ink_row = 0;
    for row in 0..height {
        let has_ink = mono[row * stride..(row + 1) * stride]
            .iter()
            .any(|byte| *byte != 0);
        if has_ink {
            if band_start.is_none() {
                band_start = Some(row);
            }
            last_ink_row = row;
        } else if let Some(start) = band_start {
            if row.saturating_sub(last_ink_row) > ZPL_RASTER_ROW_GAP {
                bands.push((start, last_ink_row + 1));
                band_start = None;
            }
        }
    }
    if let Some(start) = band_start {
        bands.push((start, last_ink_row + 1));
    }

    let mut regions = Vec::new();
    for (top, bottom) in bands {
        let mut column_start = None;
        let mut last_ink_column = 0;
        for column in 0..stride {
            let has_ink = (top..bottom).any(|row| mono[row * stride + column] != 0);
            if has_ink {
                if column_start.is_none() {
                    column_start = Some(column);
                }
                last_ink_column = column;
            } else if let Some(left) = column_start {
                if column.saturating_sub(last_ink_column) > ZPL_RASTER_COLUMN_GAP_BYTES {
                    regions.push(crop_raster_region(
                        mono,
                        stride,
                        left,
                        last_ink_column + 1,
                        top,
                        bottom,
                    ));
                    column_start = None;
                }
            }
        }
        if let Some(left) = column_start {
            regions.push(crop_raster_region(
                mono,
                stride,
                left,
                last_ink_column + 1,
                top,
                bottom,
            ));
        }
        if regions.len() > MAX_ZPL_RASTER_REGIONS {
            return tight_raster_region(mono, stride, height)
                .into_iter()
                .collect();
        }
    }
    regions
}

fn crop_raster_region(
    mono: &[u8],
    stride: usize,
    left: usize,
    right: usize,
    top: usize,
    bottom: usize,
) -> RasterRegion {
    let bytes_per_row = right - left;
    let mut cropped = Vec::with_capacity(bytes_per_row * (bottom - top));
    for row in top..bottom {
        cropped.extend_from_slice(&mono[row * stride + left..row * stride + right]);
    }
    RasterRegion {
        x_dots: left * 8,
        y_dots: top,
        height_dots: bottom - top,
        bytes_per_row,
        mono: cropped,
    }
}

fn tight_raster_region(mono: &[u8], stride: usize, height: usize) -> Option<RasterRegion> {
    let mut top = height;
    let mut bottom = 0;
    let mut left = stride;
    let mut right = 0;
    for row in 0..height {
        for column in 0..stride {
            if mono[row * stride + column] != 0 {
                top = top.min(row);
                bottom = bottom.max(row + 1);
                left = left.min(column);
                right = right.max(column + 1);
            }
        }
    }
    (top < bottom && left < right)
        .then(|| crop_raster_region(mono, stride, left, right, top, bottom))
}

fn encode_zpl(bitmap: &RasterizedLabel, config: &Map<String, Value>) -> Result<Vec<u8>, String> {
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
    match &bitmap.zpl_raster_regions {
        Some(regions) => {
            for region in regions {
                append_zpl_graphic(
                    &mut stream,
                    region.x_dots,
                    region.y_dots,
                    &region.mono,
                    region.bytes_per_row,
                    region.height_dots,
                    config,
                )?;
            }
        }
        None => append_zpl_graphic(
            &mut stream,
            0,
            0,
            &bitmap.mono,
            bitmap.bytes_per_row,
            bitmap.height_dots,
            config,
        )?,
    }
    for command in &bitmap.native_zpl_commands {
        stream.push_str(command);
    }
    stream.push_str("^XZ");
    Ok(stream.into_bytes())
}

fn append_zpl_graphic(
    stream: &mut String,
    x: usize,
    y: usize,
    mono: &[u8],
    bytes_per_row: usize,
    height: usize,
    config: &Map<String, Value>,
) -> Result<(), String> {
    if mono.is_empty() {
        return Ok(());
    }
    let total = mono.len();
    let graphic = match zpl_graphic_encoding(config) {
        ZplGraphicEncoding::None => encode_zpl_hex(mono),
        ZplGraphicEncoding::AsciiRle => compress_zpl(mono, bytes_per_row, height),
        ZplGraphicEncoding::Z64 => encode_z64(mono)?,
    };
    stream.push_str(&format!(
        "^FO{x},{y}^GFA,{total},{total},{bytes_per_row},{graphic}^FS\n"
    ));
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ZplGraphicEncoding {
    None,
    AsciiRle,
    Z64,
}

fn zpl_graphic_encoding(config: &Map<String, Value>) -> ZplGraphicEncoding {
    if let Some(value) = config
        .get("zplCompression")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
    {
        return match value.as_str() {
            "ascii-rle" => ZplGraphicEncoding::AsciiRle,
            "z64" => ZplGraphicEncoding::Z64,
            _ => ZplGraphicEncoding::None,
        };
    }

    // Preserve the old boolean contract for already-deployed station configs.
    if let Some(value) = config.get("z64").and_then(Value::as_bool) {
        return if value {
            ZplGraphicEncoding::Z64
        } else {
            ZplGraphicEncoding::AsciiRle
        };
    }

    let detected_full = config.get("detectedProfileId").and_then(Value::as_str) == Some("zpl-full");
    let advanced = config.get("compatibilityMode").and_then(Value::as_str) == Some("advanced");
    if detected_full || advanced {
        ZplGraphicEncoding::Z64
    } else {
        // Raw ASCII hex is the broadest common denominator among real Zebra
        // printers and third-party ZPL emulations.
        ZplGraphicEncoding::None
    }
}

fn encode_zpl_hex(mono: &[u8]) -> String {
    let mut output = Vec::with_capacity(mono.len().saturating_mul(2));
    for byte in mono {
        output.extend_from_slice(&ZPL_HEX_PAIRS[*byte as usize]);
    }
    String::from_utf8(output).expect("ZPL hex output is ASCII")
}

fn encode_z64(mono: &[u8]) -> Result<String, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(mono)
        .map_err(|error| format!("compress Z64 graphic: {error}"))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("finish Z64 graphic: {error}"))?;
    let encoded = BASE64_STANDARD.encode(compressed);
    let crc = crc16_ccitt(encoded.as_bytes());
    Ok(format!(":Z64:{encoded}:{crc:04X}"))
}

fn crc16_ccitt(bytes: &[u8]) -> u16 {
    let mut crc = 0_u16;
    for byte in bytes {
        crc ^= u16::from(*byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

const fn zpl_hex_pairs() -> [[u8; 2]; 256] {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut pairs = [[0_u8; 2]; 256];
    let mut value = 0;
    while value < pairs.len() {
        pairs[value] = [HEX[value >> 4], HEX[value & 0x0f]];
        value += 1;
    }
    pairs
}

const ZPL_HEX_PAIRS: [[u8; 2]; 256] = zpl_hex_pairs();

fn compress_zpl(mono: &[u8], stride: usize, height: usize) -> String {
    let mut output = Vec::with_capacity(mono.len().saturating_mul(2));
    let mut hex = Vec::with_capacity(stride.saturating_mul(2));
    for row in 0..height {
        let bytes = &mono[row * stride..(row + 1) * stride];
        let repeats_previous = row > 0 && bytes == &mono[(row - 1) * stride..row * stride];
        if repeats_previous {
            output.push(b':');
        } else if bytes.iter().all(|byte| *byte == 0) {
            output.push(b',');
        } else if bytes.iter().all(|byte| *byte == 0xff) {
            output.push(b'!');
        } else {
            hex.clear();
            for byte in bytes {
                hex.extend_from_slice(&ZPL_HEX_PAIRS[usize::from(*byte)]);
            }
            compress_row(&hex, &mut output);
        }
    }
    // All tokens emitted above are fixed ASCII bytes.
    String::from_utf8(output).expect("ZPL compressor emitted non-ASCII data")
}

fn compress_row(row: &[u8], output: &mut Vec<u8>) {
    let mut index = 0;
    while index < row.len() {
        let mut count = 1;
        while index + count < row.len() && row[index + count] == row[index] {
            count += 1;
        }
        if count >= 2 {
            append_repeat_count(output, count);
        }
        output.push(row[index]);
        index += count;
    }
}

fn append_repeat_count(output: &mut Vec<u8>, mut count: usize) {
    while count >= 20 {
        let high = (count / 20).min(20);
        output.push(b'f' + high as u8);
        count -= high * 20;
    }
    if count > 0 {
        output.push(b'F' + count as u8);
    }
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
    // EPL2 GW uses 0 for a printed dot and 1 for an unprinted dot, opposite
    // to the renderer's canonical 1 = black representation.
    bytes.extend(bitmap.mono.iter().map(|byte| !*byte));
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
    let bmp = encode_bmp1(
        bitmap,
        finite(config.get("dpi")).unwrap_or(203.0).round() as u32,
    )?;
    let mut output = format!("\x02xD{name}\r\x02IDb{name}\r").into_bytes();
    output.extend_from_slice(&bmp);
    output.extend_from_slice(format!("\r\x02L\rD11\r1Y1100000000000{name}\rQ0001\rE\r").as_bytes());
    Ok(output)
}

fn encode_bmp1(bitmap: &RasterizedLabel, dpi: u32) -> Result<Vec<u8>, String> {
    let row_bytes = bitmap.width_dots.div_ceil(32) * 4;
    let pixel_bytes = row_bytes
        .checked_mul(bitmap.height_dots)
        .ok_or("DPL BMP size overflow")?;
    let pixel_offset = 14 + 40 + 2 * 4;
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
    put_u16(&mut bmp, 28, 1);
    put_u32(&mut bmp, 34, pixel_bytes as u32);
    let ppm = ((dpi as f64) / 0.0254).round().max(1.0) as u32;
    put_u32(&mut bmp, 38, ppm);
    put_u32(&mut bmp, 42, ppm);
    put_u32(&mut bmp, 46, 2);
    put_u32(&mut bmp, 50, 2);
    // Palette index 0 is black and index 1 is white. The canonical raster uses
    // 1 for black, hence the byte inversion while copying rows.
    bmp[58..61].fill(255);
    for sy in 0..bitmap.height_dots {
        let target = pixel_offset + (bitmap.height_dots - 1 - sy) * row_bytes;
        bmp[target..target + row_bytes].fill(0xff);
        let source = &bitmap.mono[sy * bitmap.bytes_per_row..(sy + 1) * bitmap.bytes_per_row];
        for (offset, byte) in source.iter().enumerate() {
            bmp[target + offset] = !byte;
        }
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
    fn raster_encoders_apply_protocol_specific_pixel_polarity() {
        let bitmap = RasterizedLabel {
            width_dots: 16,
            height_dots: 2,
            bytes_per_row: 2,
            width_mm: 2.0,
            height_mm: 2.0,
            mono: vec![0x80, 0x00, 0xff, 0x55],
            native_zpl_commands: Vec::new(),
            zpl_raster_regions: None,
            render_micros: 0,
        };
        let config = Map::new();

        let tspl = encode_tspl(&bitmap, &config).unwrap();
        let tspl_marker = b"BITMAP 0,0,2,2,0,";
        let tspl_data_start = tspl
            .windows(tspl_marker.len())
            .position(|window| window == tspl_marker)
            .unwrap()
            + tspl_marker.len();
        assert_eq!(
            &tspl[tspl_data_start..tspl_data_start + bitmap.mono.len()],
            bitmap.mono.as_slice()
        );

        let epl = encode_epl(&bitmap, &config).unwrap();
        let epl_marker = b"GW0,0,2,2,";
        let epl_data_start = epl
            .windows(epl_marker.len())
            .position(|window| window == epl_marker)
            .unwrap()
            + epl_marker.len();
        assert_eq!(
            &epl[epl_data_start..epl_data_start + bitmap.mono.len()],
            &[0x7f, 0xff, 0x00, 0xaa]
        );

        let dpl = encode_dpl(&bitmap, &config).unwrap();
        let bmp_offset = dpl.windows(2).position(|window| window == b"BM").unwrap();
        let u16_at =
            |offset: usize| u16::from_le_bytes(dpl[offset..offset + 2].try_into().unwrap());
        let u32_at =
            |offset: usize| u32::from_le_bytes(dpl[offset..offset + 4].try_into().unwrap());
        assert_eq!(u32_at(bmp_offset + 10), 62);
        assert_eq!(u16_at(bmp_offset + 28), 1);
        assert_eq!(u32_at(bmp_offset + 46), 2);
        assert_eq!(u32_at(bmp_offset + 2), 62 + 4 * bitmap.height_dots as u32);
        assert_eq!(
            &dpl[bmp_offset + 62..bmp_offset + 66],
            &[0x00, 0xaa, 0xff, 0xff]
        );
    }

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

    #[test]
    fn hybrid_zpl_crops_separated_text_regions_and_keeps_square_boxes_native() {
        let payload = GenerationPayload {
            config: json!({"connection":"tcp","protocol":"image","dpi":300}),
            doc: json!({"canvas":{"width":600,"height":400,"widthCm":5.08,"heightCm":3.3867,"dpi":300},"elements":[
                {"id":"frame","type":"rect","x":4,"y":4,"w":592,"h":392,"fill":"transparent","borderWidth":2},
                {"id":"top","type":"text","x":30,"y":25,"w":240,"h":45,"text":"Партия {{batch}}","fontFamily":"Inter","fontSize":22},
                {"id":"bottom","type":"text","x":330,"y":325,"w":240,"h":45,"text":"Вес {{weight}} кг","fontFamily":"Inter","fontSize":22}
            ]}),
            data: json!({"batch":"А-26","weight":"12.500"}),
        };
        let bitmap = render(&payload).unwrap();
        assert_eq!(bitmap.native_zpl_commands.len(), 1);
        assert!(bitmap.native_zpl_commands[0].contains("^GB"));
        let regions = bitmap.zpl_raster_regions.as_ref().unwrap();
        assert!(regions.len() >= 2);
        assert!(
            regions
                .iter()
                .map(|region| region.mono.len())
                .sum::<usize>()
                < bitmap.mono.len() / 3
        );
        let mut reconstructed = vec![0_u8; bitmap.mono.len()];
        for region in regions {
            let left = region.x_dots / 8;
            for row in 0..region.height_dots {
                let source =
                    &region.mono[row * region.bytes_per_row..(row + 1) * region.bytes_per_row];
                let destination_start = (region.y_dots + row) * bitmap.bytes_per_row + left;
                reconstructed[destination_start..destination_start + region.bytes_per_row]
                    .copy_from_slice(source);
            }
        }
        assert_eq!(reconstructed, bitmap.mono);
        let stream = String::from_utf8(encode("image", &bitmap, &payload.config).unwrap()).unwrap();
        assert!(stream.contains("^GB"));
        assert_eq!(stream.matches("^GFA").count(), regions.len());
        assert!(!stream.contains("^FO0,0^GFA"));
    }

    #[test]
    fn zpl_ascii_compression_preserves_row_tokens_without_string_formatting() {
        fn legacy(mono: &[u8], stride: usize, height: usize) -> String {
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

        let mono = [0x00, 0x00, 0xff, 0xff, 0xaa, 0xaa, 0xaa, 0xaa];
        assert_eq!(compress_zpl(&mono, 2, 4), ",!JA:");
        let mut state = 0x1234_5678_u32;
        for stride in [1, 2, 7, 31, 128] {
            for height in [1, 2, 9, 33] {
                let mut sample = vec![0_u8; stride * height];
                for byte in &mut sample {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    *byte = (state >> 24) as u8;
                }
                if height > 1 {
                    let (first, rest) = sample.split_at_mut(stride);
                    rest[..stride].copy_from_slice(first);
                }
                assert_eq!(
                    compress_zpl(&sample, stride, height),
                    legacy(&sample, stride, height)
                );
            }
        }
    }

    #[test]
    fn z64_round_trips_and_uses_crc16_ccitt_over_base64() {
        use flate2::read::ZlibDecoder;
        use std::io::Read;

        assert_eq!(crc16_ccitt(b"123456789"), 0x31c3);
        let mono = (0..4096)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let graphic = encode_z64(&mono).unwrap();
        let encoded_and_crc = graphic.strip_prefix(":Z64:").unwrap();
        let (encoded, crc) = encoded_and_crc.rsplit_once(':').unwrap();
        assert_eq!(crc, format!("{:04X}", crc16_ccitt(encoded.as_bytes())));
        let compressed = BASE64_STANDARD.decode(encoded).unwrap();
        let mut decoded = Vec::new();
        ZlibDecoder::new(compressed.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, mono);
    }

    #[test]
    fn zpl_graphic_encoding_modes_are_exact_and_legacy_compatible() {
        let bitmap = RasterizedLabel {
            width_dots: 32,
            height_dots: 2,
            bytes_per_row: 4,
            width_mm: 4.0,
            height_mm: 1.0,
            mono: vec![0; 8],
            native_zpl_commands: Vec::new(),
            zpl_raster_regions: None,
            render_micros: 0,
        };

        let raw = json!({"zplCompression": "none"});
        let stream =
            String::from_utf8(encode_zpl(&bitmap, raw.as_object().unwrap()).unwrap()).unwrap();
        assert!(stream.contains("^GFA,8,8,4,0000000000000000"));

        let rle = json!({"zplCompression": "ascii-rle"});
        let stream =
            String::from_utf8(encode_zpl(&bitmap, rle.as_object().unwrap()).unwrap()).unwrap();
        assert!(stream.contains("^GFA,8,8,4,,:"));

        for config in [json!({"zplCompression": "z64"}), json!({"z64": true})] {
            let stream =
                String::from_utf8(encode_zpl(&bitmap, config.as_object().unwrap()).unwrap())
                    .unwrap();
            assert!(stream.contains(":Z64:"));
        }

        let legacy_rle = json!({"z64": false});
        let stream =
            String::from_utf8(encode_zpl(&bitmap, legacy_rle.as_object().unwrap()).unwrap())
                .unwrap();
        assert!(stream.contains("^GFA,8,8,4,,:"));
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
    fn p1_hybrid_raster_does_not_reintroduce_barcode_invocations() {
        for (kind, value) in [
            ("code128", "LOT>8A"),
            ("code128", "LOT^A~B"),
            ("datamatrix", "LOT_1A"),
            ("datamatrix", "LOT~1A"),
        ] {
            let mut payload = barcode_payload(203, kind, value);
            payload.config["connection"] = json!("tcp");
            let bitmap = render(&payload).unwrap();
            assert!(bitmap.native_zpl_commands.is_empty(), "{kind}: {value}");
            assert!(bitmap.mono.iter().any(|byte| *byte != 0));
            let stream =
                String::from_utf8(encode("image", &bitmap, &payload.config).unwrap()).unwrap();
            assert!(!stream.contains("^FD"));
        }
        let mut payload = barcode_payload(203, "code128", "LOT_1A");
        payload.config["connection"] = json!("tcp");
        let bitmap = render(&payload).unwrap();
        assert_eq!(bitmap.native_zpl_commands.len(), 1);
        assert!(bitmap.native_zpl_commands[0].contains("LOT_1A"));
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

    fn table_element(extra: Value) -> Map<String, Value> {
        let mut element = json!({
            "id": "tbl",
            "type": "table",
            "x": 10,
            "y": 10,
            "w": 380,
            "h": 380,
            "fontSize": 10,
            "columns": [
                {"key": "name", "title": "Наименование", "widthRatio": 60},
                {"key": "weight", "title": "Вес", "widthRatio": 40}
            ],
            "showHeaders": true,
            "showBorders": true
        });
        if let (Some(target), Some(extra)) = (element.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                target.insert(key.clone(), value.clone());
            }
        }
        element.as_object().unwrap().clone()
    }

    fn draw_test_table(data: Value, extra_element: Value) -> (TableSummary, Vec<u8>) {
        let element = table_element(extra_element);
        let data_map = data.as_object().cloned().unwrap_or_default();
        let geometry = local_geometry(400, 400, 254.0);
        let stride = geometry.width_dots.div_ceil(8);
        let mut mono = vec![0_u8; stride * geometry.height_dots];
        let summary = draw_table(&mut mono, stride, geometry, &element, &data_map).unwrap();
        (summary, mono)
    }

    fn set_bytes_in_row(mono: &[u8], stride: usize, y: usize) -> usize {
        (0..stride)
            .filter(|byte| mono[y * stride + byte] != 0)
            .count()
    }

    #[test]
    fn table_footer_text_formats_page_indicator() {
        assert_eq!(
            table_footer_text(30, 16),
            "Стр. 1 / 2   ·   показано 16 из 30 позиций"
        );
        assert_eq!(table_footer_text(3, 3), "Стр. 1 / 1   ·   всего 3 позиций");
        assert_eq!(
            table_footer_text(7, 0),
            "Стр. 1 / 7   ·   показано 0 из 7 позиций"
        );
    }

    #[test]
    fn table_body_limit_and_footer_report_truncation() {
        let items: Vec<Value> = (0..30)
            .map(|index| json!({"name": format!("A{index:02}"), "weight": "1.000"}))
            .collect();
        let (summary, mono) = draw_test_table(json!({ "items": items }), json!({}));
        // fontSize 10, padding 4: single-line rows and the header are 19 dots,
        // the footer band is 45 dots (row band * 3).
        assert_eq!(summary.total_rows, 30);
        assert_eq!(summary.drawn_rows, 16);
        let stride = 50;
        // Full-width separator at the footer top edge (y = 10 + 380 - 45 = 345).
        assert!(set_bytes_in_row(&mono, stride, 345) >= 40);
        // Rows never leak past the body limit: rows 334..344 only carry the
        // outer and column separator verticals.
        for y in 334..345 {
            assert!(
                set_bytes_in_row(&mono, stride, y) <= 8,
                "row {y} leaks into the footer band"
            );
        }
        // The truncated-pages footer text is rendered inside the band.
        assert!((346..390).any(|y| {
            let count = set_bytes_in_row(&mono, stride, y);
            count > 2 && count < 40
        }));
    }

    #[test]
    fn table_footer_counts_single_page_when_rows_fit() {
        let items: Vec<Value> = (0..5)
            .map(|index| json!({"name": format!("A{index}"), "weight": "1.000"}))
            .collect();
        let (summary, mono) = draw_test_table(json!({ "items": items }), json!({}));
        assert_eq!(summary.total_rows, 5);
        assert_eq!(summary.drawn_rows, 5);
        let stride = 50;
        assert!((346..390).any(|y| {
            let count = set_bytes_in_row(&mono, stride, y);
            count > 2 && count < 40
        }));
    }

    #[test]
    fn table_group_by_batch_draws_group_bands() {
        let items = json!({"items": [
            {"name": "Молоко", "weight": "1.000", "batch_number": "B-2"},
            {"name": "Сметана", "weight": "2.000", "batch_number": "B-1"},
            {"name": "Кефир", "weight": "3.000", "batch_number": "B-1"}
        ]});
        let (summary, _) = draw_test_table(items, json!({ "groupBy": "batch" }));
        assert_eq!(summary.total_rows, 3);
        assert_eq!(summary.drawn_rows, 3);
        let first = json!({
            "production_date_batch": "24.08.2026",
            "exp_date_full": "03.09.2026"
        });
        assert_eq!(
            table_group_label("batch", "B-1", first.as_object()),
            "Партия B-1 · Произв.: 24.08.2026 · Годен до: 03.09.2026"
        );
        assert_eq!(table_group_label("nomenclature", "Молоко", None), "Молоко");
    }

    #[test]
    fn table_sort_by_name_reorders_rows() {
        assert_eq!(ru_order("Апельсин", "Яблоко"), std::cmp::Ordering::Less);
        assert_eq!(ru_order("Яблоко", "Апельсин"), std::cmp::Ordering::Greater);
        assert_eq!(ru_order("ёлка", "желудь"), std::cmp::Ordering::Less);
        let items = [json!({"name": "Яблоко"}), json!({"name": "Апельсин"})];
        let mut refs: Vec<&Value> = items.iter().collect();
        sort_table_items(&mut refs, "name");
        assert_eq!(
            table_row_value(refs[0], "name").as_deref(),
            Some("Апельсин")
        );
    }

    #[test]
    fn table_without_items_renders_single_data_row() {
        let (summary, _) = draw_test_table(json!({"name": "Молоко"}), json!({}));
        assert_eq!(summary.total_rows, 1);
        assert_eq!(summary.drawn_rows, 1);
    }

    #[test]
    fn resolve_table_cell_pads_numbers_and_keeps_missing_literal() {
        let row = json!({"pack_number": "70", "box_number": 12345, "name": "Молоко"});
        let map = row.as_object().unwrap();
        assert_eq!(resolve_table_cell("pack_number", Some(map)), "000000000070");
        assert_eq!(resolve_table_cell("box_number", Some(map)), "000000012345");
        assert_eq!(resolve_table_cell("name", Some(map)), "Молоко");
        assert_eq!(resolve_table_cell("unknown", Some(map)), "{{ unknown }}");
        assert_eq!(resolve_table_cell("name", None), "{{ name }}");
    }

    #[test]
    fn wrap_text_hard_splits_overlong_words() {
        let font = font_for("Inter", false);
        let scale = PxScale::from(10.0);
        let lines = wrap_text(font, scale, "ШШШШШШШШШШ", 30.0);
        assert!(lines.len() >= 3, "expected hard split, got {lines:?}");
        assert_eq!(
            wrap_text(font, scale, "Раз два три", 100.0),
            vec!["Раз два три"]
        );
        assert!(wrap_text(font, scale, "", 100.0).is_empty());
    }

    pub(super) fn text_pixel_bbox(bitmap: &RasterizedLabel) -> Option<(i32, i32, i32, i32)> {
        let mut bbox: Option<(i32, i32, i32, i32)> = None;
        for y in 0..bitmap.height_dots {
            for x in 0..bitmap.width_dots {
                let byte = bitmap.mono[y * bitmap.bytes_per_row + (x >> 3)];
                if byte & (0x80 >> (x & 7)) == 0 {
                    continue;
                }
                let (min_x, min_y, max_x, max_y) =
                    bbox.unwrap_or((x as i32, y as i32, x as i32, y as i32));
                bbox = Some((
                    min_x.min(x as i32),
                    min_y.min(y as i32),
                    max_x.max(x as i32),
                    max_y.max(y as i32),
                ));
            }
        }
        bbox
    }

    fn text_rotation_payload(rotation: f64) -> GenerationPayload {
        // Canvas 406 px at 5.08 cm with 203 DPI renders 1:1 (406 dots).
        GenerationPayload {
            config: json!({"connection":"windows_driver","protocol":"image","dpi":203}),
            doc: json!({"canvas":{"width":406,"height":406,"widthCm":5.08,"heightCm":5.08,"dpi":254},"elements":[
                {"id":"t","type":"text","x":10,"y":183,"w":386,"h":40,"rotation":rotation,
                 "text":"ВЕРТИКАЛЬНЫЙ ТЕКСТ ПАЛЛЕТЫ","fontFamily":"Inter","fontSize":20,
                 "textAlign":"center","verticalAlign":"middle"}
            ]}),
            data: json!({}),
        }
    }

    #[test]
    fn text_rotation_places_quarter_turns_around_center() {
        let horizontal = render(&text_rotation_payload(0.0)).unwrap();
        let (min_x, min_y, max_x, max_y) = text_pixel_bbox(&horizontal).unwrap();
        assert!(max_x - min_x >= 250, "horizontal text must be wide");
        assert!(max_y - min_y <= 45);

        let rotated = render(&text_rotation_payload(90.0)).unwrap();
        let (min_x, min_y, max_x, max_y) = text_pixel_bbox(&rotated).unwrap();
        assert!(max_x - min_x <= 45, "90° text must be narrow");
        assert!(max_y - min_y >= 250, "90° text must be tall");
        // The rotated footprint shares its center with the element box center.
        assert!((min_x + max_x - 406).abs() <= 12);
        assert!((min_y + max_y - 406).abs() <= 12);

        let flipped = render(&text_rotation_payload(180.0)).unwrap();
        let (min_x, min_y, max_x, max_y) = text_pixel_bbox(&flipped).unwrap();
        assert!(max_x - min_x >= 250);
        assert!(min_x >= 5 && min_y >= 178 && max_x <= 401 && max_y <= 228);

        // Non-quarter angles keep the unrotated layout instead of failing.
        let arbitrary = render(&text_rotation_payload(45.0)).unwrap();
        let (min_x, _, max_x, max_y) = text_pixel_bbox(&arbitrary).unwrap();
        assert!(max_x - min_x >= 250);
        assert!(max_y - min_y <= 45);
    }
}

#[cfg(test)]
mod text_layout_tests;
