use super::*;
use serde_json::json;
use std::fs;

/// Explicit visual probe: no database connection, transport, or device access.
#[test]
#[ignore = "exports a supplied label to local PNG/JSON for browser comparison"]
fn export_text_layout_probe() {
    let input = std::env::var_os("LABELPILOT_TEXT_INPUT").expect("LABELPILOT_TEXT_INPUT");
    let output = std::env::var_os("LABELPILOT_TEXT_OUTPUT").expect("LABELPILOT_TEXT_OUTPUT");
    let output = std::path::PathBuf::from(output);
    fs::create_dir_all(&output).unwrap();
    let payload: GenerationPayload = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    let bitmap = render(&payload).unwrap();
    let gray = image::GrayImage::from_fn(
        bitmap.width_dots as u32,
        bitmap.height_dots as u32,
        |x, y| {
            let black = bitmap.mono[y as usize * bitmap.bytes_per_row + (x as usize >> 3)]
                & (0x80 >> (x & 7))
                != 0;
            image::Luma([if black { 0 } else { 255 }])
        },
    );
    gray.save(output.join("label.png")).unwrap();
    fs::write(
        output.join("label.zpl"),
        encode("zpl", &bitmap, &payload.config).unwrap(),
    )
    .unwrap();
    let geometry = geometry(
        payload.config.as_object().unwrap(),
        payload.doc.as_object().unwrap(),
    )
    .unwrap();
    let mut rows = Vec::new();
    for raw in payload.doc["elements"].as_array().unwrap() {
        let element = raw.as_object().unwrap();
        if string(element.get("type")) != Some("text") {
            continue;
        }
        let layout = text_layout(element, payload.data.as_object().unwrap());
        let font = layout.font;
        let size = layout.font_size * geometry.scale_y;
        let source_scale = css_px_scale(font, layout.font_size);
        let scale = PxScale {
            x: source_scale.x * geometry.scale_x,
            y: source_scale.y * geometry.scale_y,
        };
        let lines = layout.lines;
        let mut one = GenerationPayload {
            config: payload.config.clone(),
            doc: payload.doc.clone(),
            data: payload.data.clone(),
        };
        one.doc["elements"] = json!([raw]);
        let element_bitmap = render(&one).unwrap();
        let bbox = super::tests::text_pixel_bbox(&element_bitmap);
        rows.push(json!({"id":raw["id"],"size":size,"scale":scale.y,
            "fontHeight":font.height_unscaled(),"unitsPerEm":font.units_per_em(),
            "lines":lines,"widths":lines.iter().map(|line|measure_text(font,scale,line)).collect::<Vec<_>>(),"bbox":bbox}));
    }
    let report = json!({"widthDots":bitmap.width_dots,"heightDots":bitmap.height_dots,"text":rows});
    fs::write(
        output.join("layout.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Text layout exported to {}", output.display());
}

fn fixture() -> GenerationPayload {
    serde_json::from_str(include_str!("fixtures/text-layout.json")).unwrap()
}

fn assert_browser_variant(variant_name: &str) {
    let references: Value =
        serde_json::from_str(include_str!("fixtures/text-layout-browser.json")).unwrap();
    let reference = references["variants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|variant| variant["variant"] == variant_name)
        .unwrap();
    let mut payload = fixture();
    payload.config = reference["config"].clone();
    let elements = payload.doc["elements"].as_array().unwrap().clone();
    for expected in reference["text"].as_array().unwrap() {
        let element = elements
            .iter()
            .find(|element| element["id"] == expected["id"])
            .unwrap();
        let map = element.as_object().unwrap();
        let layout = text_layout(map, payload.data.as_object().unwrap());
        let expected_lines: Vec<&str> = expected["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap())
            .collect();
        assert_eq!(
            layout.lines, expected_lines,
            "{} {} line breaks",
            variant_name, expected["id"]
        );
        let text = interpolate(
            element["text"].as_str().unwrap(),
            payload.data.as_object().unwrap(),
        );
        let width = measure_text(
            layout.font,
            css_px_scale(layout.font, layout.font_size),
            &text,
        );
        assert!(
            (f64::from(width) - expected["width"].as_f64().unwrap()).abs() < 0.04,
            "{} {} OpenType width: {width}, browser {}",
            variant_name,
            expected["id"],
            expected["width"]
        );
        payload.doc["elements"] = json!([element]);
        let bitmap = render(&payload).unwrap();
        assert_eq!(
            bitmap.width_dots as u64,
            reference["widthDots"].as_u64().unwrap()
        );
        assert_eq!(
            bitmap.height_dots as u64,
            reference["heightDots"].as_u64().unwrap()
        );
        let (x0, y0, x1, y1) = super::tests::text_pixel_bbox(&bitmap).unwrap();
        let actual = [x0, y0, x1 + 1, y1 + 1];
        for (index, expected_edge) in expected["bbox"].as_array().unwrap().iter().enumerate() {
            let delta = (i64::from(actual[index]) - expected_edge.as_i64().unwrap()).abs();
            // Browser hinting and CSS fractional-line rounding differ from a
            // printer's monochrome outline rasterizer by at most two dots.
            assert!(
                delta <= references["pixelTolerance"].as_i64().unwrap(),
                "{} {} bounds {actual:?}, browser {}",
                variant_name,
                expected["id"],
                expected["bbox"]
            );
        }
    }
}

#[test]
fn css_text_matches_browser_at_203_dpi() {
    assert_browser_variant("203");
}
#[test]
fn css_text_matches_browser_at_300_dpi() {
    assert_browser_variant("300");
}
#[test]
fn css_text_matches_browser_at_600_dpi() {
    assert_browser_variant("600");
}
#[test]
fn css_text_matches_browser_with_nonuniform_scale_and_rotations() {
    assert_browser_variant("anisotropic");
}

#[test]
fn css_text_size_is_pixels_per_em_for_each_embedded_family() {
    for family in ["Inter", "Ubuntu", "Montserrat", "Roboto"] {
        for bold in [false, true] {
            let font = font_for(family, bold);
            for size in [10.0_f32, 22.0, 26.0, 48.0] {
                let scale = css_px_scale(font, size);
                let pixels_per_unit = scale.y / font.height_unscaled();
                let expected = size / font.units_per_em().unwrap();
                assert!(
                    (pixels_per_unit - expected).abs() < 1e-7,
                    "{family} {bold} {size}"
                );
            }
        }
    }
    let scale = css_px_scale(font_for("Inter", false), 26.0);
    assert!((scale.y - 31.465_91).abs() < 0.0001);
}

#[test]
fn css_text_shaping_applies_gpos_kerning_and_ligatures() {
    let font = font_for("Inter", false);
    let scale = css_px_scale(font, 26.0);
    let unkerned = measure_text(font, scale, "A") + measure_text(font, scale, "V");
    assert!(measure_text(font, scale, "AV") < unkerned - 1.0);
    // Inter intentionally has no ffi ligature; the bundled Roboto does.
    let glyphs = font_for("Roboto", false).shape("ffi");
    assert!(
        glyphs.glyph_infos().len() < 3,
        "browser-compatible OpenType ligature"
    );
    let mark = font.shape("a\u{0301}");
    assert!(!mark.glyph_infos().is_empty());
    assert!(
        mark.glyph_positions()
            .iter()
            .map(|glyph| glyph.x_advance)
            .sum::<i32>()
            > 0
    );
}

#[test]
fn css_text_correct_em_size_restores_authored_wrapping() {
    let payload = fixture();
    let element = payload.doc["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|element| element["id"] == "wrap")
        .unwrap()
        .as_object()
        .unwrap();
    let layout = text_layout(element, payload.data.as_object().unwrap());
    assert_eq!(layout.lines.len(), 3);
    let old_scale = PxScale::from(layout.font_size);
    let old_lines = wrap_text(
        layout.font,
        old_scale,
        element["text"].as_str().unwrap(),
        layout.width,
    );
    assert_ne!(
        old_lines, layout.lines,
        "the former height/em bug must change this regression fixture"
    );
}

#[test]
fn css_text_preserves_authored_blank_lines_and_inner_spaces() {
    let element = json!({"type":"text","w":800,"h":100,"fontSize":22,"text":"one  two\n\nthree\n"});
    let layout = text_layout(element.as_object().unwrap(), &Map::new());
    assert_eq!(layout.lines, ["one  two", "", "three", ""]);
    let empty = json!({"type":"text","w":100,"h":100,"text":""});
    assert!(text_layout(empty.as_object().unwrap(), &Map::new())
        .lines
        .is_empty());
}

#[test]
fn css_text_overflow_is_clipped_by_label_not_element_even_when_rotated() {
    for rotation in [0, 90, 180, 270] {
        let payload = GenerationPayload {
            config: json!({"protocol":"image","connection":"windows_driver","dpi":300}),
            doc: json!({"canvas":{"width":400,"height":400,"widthCm":3.3866666667,"heightCm":3.3866666667},
                "elements":[{"type":"text","x":10,"y":199,"w":380,"h":1,"fontSize":26,
                    "text":"ТЕКСТ gy","textAlign":"center","rotation":rotation}]}),
            data: json!({}),
        };
        let bitmap = render(&payload).unwrap();
        let (x0, y0, x1, y1) = super::tests::text_pixel_bbox(&bitmap).unwrap();
        if matches!(rotation, 0 | 180) {
            assert!(
                y0 < 199 && y1 > 200,
                "visible vertical overflow at {rotation}: {y0}..{y1}"
            );
        } else {
            assert!(
                x0 < 199 && x1 > 200,
                "visible horizontal overflow at {rotation}: {x0}..{x1}"
            );
        }
        assert!(x0 >= 0 && y0 >= 0 && x1 < 400 && y1 < 400);
    }
}

#[test]
fn css_text_rotation_keeps_pixels_that_start_outside_the_label() {
    let payload = GenerationPayload {
        config: json!({"protocol":"image","connection":"windows_driver","dpi":300}),
        doc: json!({"canvas":{"width":400,"height":400,"widthCm":3.3866666667,"heightCm":3.3866666667},
            "elements":[{"type":"text","x":-200,"y":180,"w":800,"h":40,"fontSize":26,
                "text":"MMMMMMMMMMMMMMMMMMMMMMMMMMMM","textAlign":"center","rotation":90}]}),
        data: json!({}),
    };
    let bitmap = render(&payload).unwrap();
    let (x0, y0, x1, y1) = super::tests::text_pixel_bbox(&bitmap).unwrap();
    assert!(x0 > 170 && x1 < 230);
    assert!(
        y0 < 5 && y1 > 395,
        "rotation must precede label clipping: {y0}..{y1}"
    );
}
