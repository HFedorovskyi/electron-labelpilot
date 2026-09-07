use super::*;
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

fn payload(config: Value, doc: Value, data: Value) -> GenerationPayload {
    GenerationPayload { config, doc, data }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCorpus {
    cases: Vec<GoldenCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCase {
    name: String,
    config: Value,
    doc: Value,
    data: Value,
    expected_base64: String,
}

#[test]
fn matches_shared_typescript_golden_streams_byte_for_byte() {
    let corpus: GoldenCorpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/printer-native-golden.json"
    ))
    .unwrap();
    assert!(corpus.cases.len() >= 2);
    for case in corpus.cases {
        let expected = base64::engine::general_purpose::STANDARD
            .decode(case.expected_base64)
            .unwrap();
        let generated = GeneratorState::default()
            .generate(payload(case.config, case.doc, case.data))
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        assert_eq!(generated.bytes, expected, "{}", case.name);
        assert_eq!(generated.metadata.bytes, expected.len(), "{}", case.name);
    }
}

#[test]
fn plans_native_and_bitmap_routes_without_silent_fallback() {
    let state = GeneratorState::default();
    let native = payload(
        serde_json::json!({
            "protocol":"zpl",
            "compatibilityMode":"compatible"
        }),
        serde_json::json!({
            "widthMm":58,
            "heightMm":40,
            "canvas":{"width":400,"height":300},
            "elements":[{
                "id":"text","type":"text","x":0,"y":0,"w":100,"h":20,
                "text":"LOT {{batch}}"
            }]
        }),
        serde_json::json!({"batch":"A1"}),
    );
    let plan = state.plan(&native).unwrap();
    assert!(plan.native_eligible);
    assert_eq!(plan.backend, "rust-native");
    assert_eq!(plan.profile_id, "generic-zpl-safe");

    let bitmap = payload(
        serde_json::json!({
            "protocol":"zpl",
            "compatibilityMode":"compatible"
        }),
        serde_json::json!({
            "widthMm":58,
            "heightMm":40,
            "canvas":{"width":400,"height":300},
            "elements":[
                {
                    "id":"unicode","type":"text","x":0,"y":0,"w":100,"h":20,
                    "text":"РџР°СЂС‚РёСЏ"
                },
                {
                    "id":"table","type":"table","x":0,"y":30,"w":100,"h":80
                }
            ]
        }),
        serde_json::json!({}),
    );
    let plan = state.plan(&bitmap).unwrap();
    assert!(!plan.native_eligible);
    assert_eq!(plan.effective_protocol, "image");
    assert_eq!(plan.backend, "renderer-bitmap");
    assert_eq!(plan.reasons, ["unicode:unicode-text", "table:table"]);
}

#[test]
fn one_pass_native_generation_matches_legacy_output_and_signals_raster() {
    let config = serde_json::json!({
        "protocol":"zpl",
        "compatibilityMode":"compatible"
    });
    let doc = serde_json::json!({
        "widthMm":58,
        "heightMm":40,
        "canvas":{"width":400,"height":300},
        "elements":[{
            "id":"text","type":"text","x":0,"y":0,"w":100,"h":20,
            "text":"LOT {{batch}}"
        }]
    });
    let data = serde_json::json!({"batch":"A1"});
    let request = payload(config.clone(), doc.clone(), data.clone());
    let one_pass = GeneratorState::default()
        .generate_if_native(&request)
        .unwrap()
        .expect("native-compatible label");
    let legacy = GeneratorState::default()
        .generate(payload(config.clone(), doc.clone(), data))
        .unwrap();
    assert_eq!(one_pass.bytes, legacy.bytes);
    assert_eq!(one_pass.metadata.profile_id, legacy.metadata.profile_id);

    let raster_doc = serde_json::json!({
        "widthMm":58,
        "heightMm":40,
        "canvas":{"width":400,"height":300},
        "elements":[{
            "id":"unicode","type":"text","x":0,"y":0,"w":100,"h":20,
            "text":"Партия"
        }]
    });
    assert!(GeneratorState::default()
        .generate_if_native(&payload(config, raster_doc, serde_json::json!({})))
        .unwrap()
        .is_none());
}

#[test]
fn interpolation_and_legacy_barcode_names_match_typescript() {
    let binding = serde_json::json!({"Batch":"A7"});
    let data = binding.as_object().unwrap().clone();
    assert_eq!(
        types::interpolate("{{ batch }} / {{missing}}", &data),
        "A7 / {{missing}}"
    );
    assert_eq!(
        types::normalize_barcode(Some(&Value::String("EAN13_KZ".into()))),
        "ean13"
    );
    assert_eq!(
        types::normalize_barcode(Some(&Value::String("23".into()))),
        "code128"
    );
    assert_eq!(
        types::normalize_barcode(Some(&Value::String("GS1DM".into()))),
        "gs1datamatrix"
    );
}

#[test]
fn geometry_matches_203_300_and_600_dpi() {
    for (dpi, width, height) in [(203, 464, 320), (300, 685, 472), (600, 1370, 945)] {
        let request = payload(
            serde_json::json!({"protocol":"zpl","dpi":dpi}),
            serde_json::json!({
                "widthMm":58,
                "heightMm":40,
                "canvas":{"width":400,"height":300},
                "elements":[]
            }),
            serde_json::json!({}),
        );
        let input = types::ParsedInput::parse(&request).unwrap();
        let geometry = input.geometry().unwrap();
        assert_eq!((geometry.width_dots, geometry.height_dots), (width, height));
    }
}

#[test]
fn rejects_unbounded_documents_and_invalid_dpi() {
    let elements = (0..=MAX_LABEL_ELEMENTS)
        .map(|index| {
            serde_json::json!({
                "id":index.to_string(),
                "type":"rect",
                "x":0,"y":0,"w":1,"h":1
            })
        })
        .collect::<Vec<_>>();
    let oversized = payload(
        serde_json::json!({"protocol":"zpl","dpi":203}),
        serde_json::json!({
            "canvas":{"width":1,"height":1},
            "elements":elements
        }),
        serde_json::json!({}),
    );
    assert!(GeneratorState::default()
        .plan(&oversized)
        .unwrap_err()
        .contains("1024"));

    let invalid = payload(
        serde_json::json!({"protocol":"zpl","dpi":96}),
        serde_json::json!({
            "canvas":{"width":1,"height":1},
            "elements":[]
        }),
        serde_json::json!({}),
    );
    assert!(GeneratorState::default()
        .plan(&invalid)
        .unwrap_err()
        .contains("203, 300 or 600"));
}

#[test]
fn tspl_routes_complex_content_to_existing_bitmap_backend() {
    let state = GeneratorState::default();
    let request = payload(
        serde_json::json!({
            "protocol":"tspl",
            "compatibilityMode":"advanced"
        }),
        serde_json::json!({
            "widthMm":58,
            "heightMm":40,
            "canvas":{"width":400,"height":300},
            "elements":[
                {
                    "id":"plain","type":"text","x":0,"y":0,"w":100,"h":20,
                    "text":"ASCII"
                },
                {
                    "id":"bold","type":"text","x":0,"y":25,"w":100,"h":20,
                    "text":"BOLD","fontWeight":"bold"
                },
                {
                    "id":"gs1","type":"barcode","x":0,"y":50,"w":100,"h":40,
                    "barcodeType":"gs1-128","value":"(01)123"
                }
            ]
        }),
        serde_json::json!({}),
    );
    let plan = state.plan(&request).unwrap();
    assert!(!plan.native_eligible);
    assert_eq!(plan.reasons, ["bold:complex-text", "gs1:barcode-gs1-128"]);
}

#[test]
fn summary_exposes_weak_device_bounds() {
    let state = GeneratorState::default();
    let summary = state.summary();
    assert_eq!(summary.generated_jobs, 0);
    assert_eq!(summary.fallback_jobs, 0);
    assert_eq!(summary.fallback_bytes_generated, 0);
    assert_eq!(summary.max_elements, 1024);
    assert_eq!(summary.max_input_bytes, 8 * 1024 * 1024);
    assert_eq!(summary.max_generated_bytes, 16 * 1024 * 1024);
    assert_eq!(
        summary.supported_protocols,
        ["zpl", "tspl", "epl", "cpcl", "dpl", "sbpl"]
    );

    state.record_renderer_fallback(123);
    let summary = state.summary();
    assert_eq!(summary.fallback_jobs, 1);
    assert_eq!(summary.fallback_bytes_generated, 123);
}

#[test]
fn extension_languages_plan_bounded_tauri_raster_adapters() {
    let state = GeneratorState::default();
    for (protocol, profile) in [
        ("epl", "generic-epl-raster"),
        ("cpcl", "generic-cpcl-raster"),
        ("dpl", "generic-dpl-raster"),
        ("sbpl", "generic-sbpl-raster"),
    ] {
        let request = payload(
            serde_json::json!({"protocol":protocol,"dpi":203}),
            serde_json::json!({
                "widthMm":58,
                "heightMm":40,
                "canvas":{"width":400,"height":300},
                "elements":[]
            }),
            serde_json::json!({}),
        );
        let plan = state.plan(&request).unwrap();
        assert!(!plan.native_eligible);
        assert_eq!(plan.backend, "tauri-raster-adapter");
        assert_eq!(plan.effective_protocol, protocol);
        assert_eq!(plan.profile_id, profile);
        assert_eq!(
            plan.reasons,
            [format!("protocol:raster-adapter:{protocol}")]
        );
    }
}

#[test]
fn advanced_zpl_routes_gs1_ai_values_to_fnc1_raster() {
    let request = payload(
        serde_json::json!({
            "connection":"tcp",
            "protocol":"zpl",
            "dpi":300,
            "compatibilityMode":"advanced"
        }),
        serde_json::json!({
            "widthMm":60,
            "heightMm":40,
            "canvas":{"width":600,"height":400,"dpi":254},
            "elements":[
                {"id":"gs1-128","type":"barcode","x":10,"y":10,"w":580,"h":100,"barcodeType":"gs1-128","value":"{{ gs1 }}"},
                {"id":"gs1-dm","type":"barcode","x":10,"y":130,"w":200,"h":200,"barcodeType":"gs1datamatrix","value":"{{ gs1 }}"}
            ]
        }),
        serde_json::json!({"gs1":"(01)04870254930134(10)BATCH26"}),
    );
    let plan = GeneratorState::default().plan(&request).unwrap();
    assert!(!plan.native_eligible);
    assert_eq!(plan.effective_protocol, "image");
    assert_eq!(
        plan.reasons,
        ["gs1-128:barcode-gs1-128", "gs1-dm:barcode-gs1datamatrix"]
    );
}

#[test]
#[ignore = "manual print hot-path benchmark"]
fn benchmark_one_pass_generation_vs_plan_then_generate() {
    use std::hint::black_box;
    use std::time::Instant;

    let config = serde_json::json!({
        "connection":"tcp", "protocol":"zpl", "dpi":203,
        "compatibilityMode":"advanced"
    });
    let doc = serde_json::json!({
        "widthMm":58, "heightMm":40,
        "canvas":{"width":464,"height":320,"dpi":203},
        "elements":[
            {"id":"name","type":"text","x":8,"y":8,"w":448,"h":52,"text":"PRODUCT {{name}}","fontSize":22},
            {"id":"article","type":"text","x":8,"y":68,"w":448,"h":38,"text":"ARTICLE {{article}}","fontSize":16},
            {"id":"lot","type":"text","x":8,"y":112,"w":448,"h":38,"text":"LOT {{batch}}","fontSize":16},
            {"id":"barcode","type":"barcode","x":70,"y":165,"w":324,"h":120,"barcodeType":"code128","value":"{{barcode}}","showText":true}
        ]
    });
    let data = serde_json::json!({
        "name":"BEEF", "article":"2301", "batch":"B-2026", "barcode":"4870254930240"
    });
    let iterations = 10_000_u64;

    let legacy_state = GeneratorState::default();
    let legacy_started = Instant::now();
    let mut legacy_bytes = 0_usize;
    for _ in 0..iterations {
        let request = payload(config.clone(), doc.clone(), data.clone());
        black_box(legacy_state.plan(&request).unwrap());
        legacy_bytes += black_box(legacy_state.generate(request).unwrap().bytes.len());
    }
    let legacy_micros = legacy_started.elapsed().as_micros();

    let one_pass_state = GeneratorState::default();
    let one_pass_started = Instant::now();
    let mut one_pass_bytes = 0_usize;
    for _ in 0..iterations {
        let request = payload(config.clone(), doc.clone(), data.clone());
        one_pass_bytes += black_box(
            one_pass_state
                .generate_if_native(&request)
                .unwrap()
                .unwrap()
                .bytes
                .len(),
        );
    }
    let one_pass_micros = one_pass_started.elapsed().as_micros();
    assert_eq!(legacy_bytes, one_pass_bytes);
    println!(
        "PRINT_GENERATOR_BENCH iterations={iterations} legacy_us={legacy_micros} one_pass_us={one_pass_micros} speedup_x={:.2}",
        legacy_micros as f64 / one_pass_micros.max(1) as f64
    );
}

fn p1_field_request(kind: &str, value: &str, barcode: &str, width: u32) -> GenerationPayload {
    payload(
        serde_json::json!({"protocol":"zpl","compatibilityMode":"advanced","dpi":203}),
        serde_json::json!({"widthMm":58,"heightMm":40,"canvas":{"width":400,"height":300},
            "elements":[{"id":"field","type":kind,"x":0,"y":0,"w":width,"h":40,
                "text":"{{field}}","value":"{{field}}","barcodeType":barcode}]}),
        serde_json::json!({"field":value}),
    )
}

#[test]
fn p1_zpl_field_escapes_command_and_hex_prefixes_after_interpolation() {
    for kind in ["text", "barcode"] {
        let request = p1_field_request(kind, "LOT^A~B_5E", "qrcode", 200);
        let bytes = GeneratorState::default().generate(request).unwrap().bytes;
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("^FH_^FD"), "{text}");
        assert!(text.contains("LOT_5EA_7EB_5F5E"), "{text}");
        assert!(!text.contains("LOT^A~B"));
    }
}

#[test]
fn p1_zpl_ambiguous_barcode_controls_require_raster() {
    for (barcode, value) in [
        ("code128", "LOT>8A"),
        ("code128", "LOT^A~B"),
        ("code128", "LOT\u{1d}A"),
        ("datamatrix", "LOT_1A"),
        ("datamatrix", "LOT~1A"),
        ("gs1-128", "(01)04870254930134(10)LOT"),
    ] {
        let request = p1_field_request("barcode", value, barcode, 200);
        assert!(
            !GeneratorState::default()
                .plan(&request)
                .unwrap()
                .native_eligible,
            "{barcode} must preserve literal data via raster: {value:?}"
        );
        assert!(GeneratorState::default()
            .generate_if_native(&request)
            .unwrap()
            .is_none());
    }
}

#[test]
fn p1_zpl_literal_field_block_controls_require_raster() {
    for value in ["LOT\\&A", "LOT\\xA", "LOT\tA", "LOT\0A"] {
        let request = p1_field_request("text", value, "", 200);
        assert!(
            !GeneratorState::default()
                .plan(&request)
                .unwrap()
                .native_eligible,
            "{value:?}"
        );
    }
}

#[test]
fn p1_zpl_unicode_and_line_breaks_preserve_field_content() {
    let request = p1_field_request("text", "Партия^А_7E\r\nСтрока~Б", "", 200);
    let stream =
        String::from_utf8(GeneratorState::default().generate(request).unwrap().bytes).unwrap();
    assert!(stream.contains("^CI28\n"));
    assert!(stream.contains("Партия_5EА_5F7E\\&Строка_7EБ"), "{stream}");
    assert!(!stream.contains('\r'));
}

#[test]
fn p1_zpl_printable_ascii_and_utf8_fields_round_trip() {
    fn decode_field(stream: &str) -> Vec<u8> {
        let field = stream
            .split_once("^FD")
            .unwrap()
            .1
            .split_once("^FS")
            .unwrap()
            .0;
        let mut decoded = Vec::new();
        let mut input = field.as_bytes().iter().copied();
        while let Some(byte) = input.next() {
            if byte == b'_' && stream.contains("^FH_^FD") {
                let high = char::from(input.next().unwrap()).to_digit(16).unwrap();
                let low = char::from(input.next().unwrap()).to_digit(16).unwrap();
                decoded.push((high * 16 + low) as u8);
            } else {
                decoded.push(byte);
            }
        }
        decoded
    }
    let printable = (0x20_u8..=0x7e).map(char::from).collect::<String>();
    for value in [printable.as_str(), "_5E^FS~JA_7E", "Партия_5F^~ € 漢字"] {
        for kind in ["text", "barcode"] {
            let request = p1_field_request(kind, value, "qrcode", 0);
            let stream =
                String::from_utf8(GeneratorState::default().generate(request).unwrap().bytes)
                    .unwrap();
            let expected = if kind == "barcode" {
                format!("QA,{value}")
            } else {
                value.to_owned()
            };
            assert_eq!(decode_field(&stream), expected.as_bytes());
            assert_eq!(stream.matches("^FD").count(), 1);
            assert_eq!(stream.matches("^FS").count(), 1);
            assert_eq!(stream.matches("^XA").count(), 1);
            assert_eq!(stream.matches("^XZ").count(), 1);
        }
    }
}

#[test]
fn p1_zpl_text_layout_boundaries_and_barcode_text_fallback() {
    for (value, width, native) in [
        ("FIRST\nSECOND".to_owned(), 0, false),
        ("FIRST\rSECOND".to_owned(), 200, true),
        ("LITERAL\\&TEXT".to_owned(), 0, true),
        ("A".repeat(3072), 200, true),
        ("A".repeat(3073), 200, false),
    ] {
        let request = p1_field_request("text", &value, "", width);
        assert_eq!(
            GeneratorState::default()
                .plan(&request)
                .unwrap()
                .native_eligible,
            native
        );
    }
    let mut request = p1_field_request("barcode", "LOT_5E", "code128", 200);
    request.doc["elements"][0]
        .as_object_mut()
        .unwrap()
        .remove("value");
    let stream =
        String::from_utf8(GeneratorState::default().generate(request).unwrap().bytes).unwrap();
    assert!(stream.contains("^FH_^FDLOT_5F5E^FS"), "{stream}");
    let mut generic = p1_field_request("text", "Партия", "", 200);
    generic.config["compatibilityMode"] = serde_json::json!("generic");
    assert!(
        !GeneratorState::default()
            .plan(&generic)
            .unwrap()
            .native_eligible
    );
}

#[test]
fn p1_zpl_barcode_literal_policy_preserves_supported_streams() {
    for (kind, value) in [
        ("code128", "LOT_1"),
        ("code39", "LOT-1"),
        ("datamatrix", "LOT^1"),
        ("qrcode", "LOT^~_>1"),
        ("ean13", "4870254930134"),
        ("ean8", "96385074"),
        ("upca", "036000291452"),
        ("upce", "04252614"),
        ("interleaved2of5", "12345678901234"),
    ] {
        let request = p1_field_request("barcode", value, kind, 200);
        assert!(
            GeneratorState::default()
                .generate_if_native(&request)
                .unwrap()
                .is_some(),
            "{kind}"
        );
    }
    for (kind, value) in [
        ("code39", "lowercase"),
        ("ean13", "1234A"),
        ("code128", ""),
        ("qrcode", "A\tB"),
    ] {
        let request = p1_field_request("barcode", value, kind, 200);
        assert!(
            !GeneratorState::default()
                .plan(&request)
                .unwrap()
                .native_eligible,
            "{kind}"
        );
    }
}
