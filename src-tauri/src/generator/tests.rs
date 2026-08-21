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
