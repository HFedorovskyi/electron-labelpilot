use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PAGE_RASTER_DPI_CAP: u16 = 300;
pub const SUPPORTED_PRINT_TARGETS: [&str; 2] = ["label-roll", "page-sheet"];
pub const AVAILABLE_BACKENDS: [&str; 9] = [
    "zpl-hybrid",
    "tspl-hybrid",
    "zpl-bitmap",
    "epl-raster",
    "cpcl-raster",
    "dpl-raster",
    "sbpl-raster",
    "windows-gdi-label",
    "windows-gdi-page",
];
pub const EXTENSION_LANGUAGE_SLOTS: [&str; 4] = ["epl", "cpcl", "dpl", "sbpl"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendPlanPayload {
    pub config: Value,
    pub doc: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniversalPrinterPlan {
    pub print_target: String,
    pub backend: String,
    pub transport: String,
    pub requested_protocol: String,
    pub effective_protocol: String,
    pub profile_id: String,
    pub ready: bool,
    pub raster_dpi: u16,
    pub page_width_mm: Option<f64>,
    pub page_height_mm: Option<f64>,
    pub fit_mode: String,
    pub reasons: Vec<String>,
    pub available_backends: Vec<String>,
    pub extension_language_slots: Vec<String>,
}

fn string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn positive_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number > 0.0)
}

fn infer_target(config: &Value, canvas: &Value) -> Result<String, String> {
    let explicit = string(
        config
            .get("printTarget")
            .or_else(|| config.get("mediaMode")),
    );
    if !explicit.is_empty() {
        return match explicit.as_str() {
            "label" | "roll" | "label-roll" => Ok("label-roll".to_owned()),
            "page" | "sheet" | "page-sheet" => Ok("page-sheet".to_owned()),
            other => Err(format!("unsupported print target: {other}")),
        };
    }
    Ok(if string(canvas.get("labelType")) == "pallet" {
        "page-sheet"
    } else {
        "label-roll"
    }
    .to_owned())
}

fn page_dimensions(doc: &Value, canvas: &Value) -> (Option<f64>, Option<f64>) {
    let width = positive_number(doc.get("widthMm"))
        .or_else(|| positive_number(canvas.get("widthCm")).map(|value| value * 10.0));
    let height = positive_number(doc.get("heightMm"))
        .or_else(|| positive_number(canvas.get("heightCm")).map(|value| value * 10.0));
    (width, height)
}

fn requested_dpi(config: &Value, canvas: &Value, target: &str) -> Result<u16, String> {
    let fallback = if target == "page-sheet" { 300 } else { 203 };
    let raw = config
        .get("dpi")
        .and_then(Value::as_u64)
        .or_else(|| canvas.get("dpi").and_then(Value::as_u64))
        .unwrap_or(fallback);
    let dpi = u16::try_from(raw).map_err(|_| format!("unsupported printer DPI: {raw}"))?;
    if ![203, 300, 600].contains(&dpi) {
        return Err(format!("unsupported printer DPI: {dpi}"));
    }
    Ok(dpi)
}

fn profile_id(config: &Value, protocol: &str, connection: &str) -> String {
    let detected = config
        .get("detectedProfileId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(value) = detected {
        return value.to_owned();
    }
    if connection == "windows_driver" {
        return "windows-driver".to_owned();
    }
    match protocol {
        "tspl" => "generic-tspl-safe".to_owned(),
        "epl" => "generic-epl-raster".to_owned(),
        "cpcl" => "generic-cpcl-raster".to_owned(),
        "dpl" => "generic-dpl-raster".to_owned(),
        "sbpl" => "generic-sbpl-raster".to_owned(),
        _ => "generic-zpl-safe".to_owned(),
    }
}

pub fn plan_backend(payload: &BackendPlanPayload) -> Result<UniversalPrinterPlan, String> {
    let config = payload
        .config
        .as_object()
        .ok_or_else(|| "printer config must be an object".to_owned())?;
    let doc = payload
        .doc
        .as_object()
        .ok_or_else(|| "label document must be an object".to_owned())?;
    let canvas = doc
        .get("canvas")
        .and_then(Value::as_object)
        .ok_or_else(|| "label document canvas must be an object".to_owned())?;
    let config_value = Value::Object(config.clone());
    let canvas_value = Value::Object(canvas.clone());
    let doc_value = Value::Object(doc.clone());
    let target = infer_target(&config_value, &canvas_value)?;
    let connection = string(config.get("connection"));
    let requested_protocol = {
        let value = string(config.get("protocol"));
        if value.is_empty() {
            "zpl".to_owned()
        } else {
            value
        }
    };
    let dpi = requested_dpi(&config_value, &canvas_value, &target)?;
    let raster_dpi = if target == "page-sheet" {
        dpi.min(PAGE_RASTER_DPI_CAP)
    } else {
        dpi
    };
    let transport = match connection.as_str() {
        "tcp" => "tcp-raw",
        "serial" => "serial-raw",
        "windows_driver" => "windows-spooler",
        _ => "unsupported",
    }
    .to_owned();
    let (page_width_mm, page_height_mm) = page_dimensions(&doc_value, &canvas_value);
    let fit_mode = string(config.get("pageFit"));
    let fit_mode = if fit_mode == "actual-size" {
        "actual-size"
    } else {
        "fit-printable"
    }
    .to_owned();
    let mut reasons = Vec::new();
    let (backend, effective_protocol, ready) = if target == "page-sheet" {
        if page_width_mm.is_none() || page_height_mm.is_none() {
            reasons.push("page-sheet:physical-size-missing".to_owned());
        }
        if connection != "windows_driver" {
            reasons.push("page-sheet:windows-driver-required".to_owned());
        }
        (
            "windows-gdi-page".to_owned(),
            "browser".to_owned(),
            connection == "windows_driver" && page_width_mm.is_some() && page_height_mm.is_some(),
        )
    } else {
        match (connection.as_str(), requested_protocol.as_str()) {
            ("windows_driver", _) => ("windows-gdi-label".to_owned(), "browser".to_owned(), true),
            ("tcp" | "serial", "zpl") => ("zpl-hybrid".to_owned(), "zpl".to_owned(), true),
            ("tcp" | "serial", "image") => ("zpl-bitmap".to_owned(), "image".to_owned(), true),
            ("tcp" | "serial", "tspl") => ("tspl-hybrid".to_owned(), "tspl".to_owned(), true),
            ("tcp" | "serial", "epl") => ("epl-raster".to_owned(), "epl".to_owned(), true),
            ("tcp" | "serial", "cpcl") => ("cpcl-raster".to_owned(), "cpcl".to_owned(), true),
            ("tcp" | "serial", "dpl") => ("dpl-raster".to_owned(), "dpl".to_owned(), true),
            ("tcp" | "serial", "sbpl") => ("sbpl-raster".to_owned(), "sbpl".to_owned(), true),
            _ => {
                reasons.push(format!(
                    "route:unsupported:{connection}:{requested_protocol}"
                ));
                ("unsupported".to_owned(), requested_protocol.clone(), false)
            }
        }
    };
    Ok(UniversalPrinterPlan {
        print_target: target,
        backend,
        transport,
        requested_protocol: requested_protocol.clone(),
        effective_protocol,
        profile_id: profile_id(&config_value, &requested_protocol, &connection),
        ready: ready && reasons.is_empty(),
        raster_dpi,
        page_width_mm,
        page_height_mm,
        fit_mode,
        reasons,
        available_backends: AVAILABLE_BACKENDS
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        extension_language_slots: EXTENSION_LANGUAGE_SLOTS
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pallet_template_routes_to_bounded_windows_page_backend() {
        let plan = plan_backend(&BackendPlanPayload {
            config: json!({"connection":"windows_driver","protocol":"browser","dpi":600}),
            doc: json!({"canvas":{"width":1678,"height":2374,"widthCm":21.0,"heightCm":29.7,"dpi":203,"labelType":"pallet"},"elements":[]}),
        }).unwrap();
        assert_eq!(plan.print_target, "page-sheet");
        assert_eq!(plan.backend, "windows-gdi-page");
        assert_eq!(plan.transport, "windows-spooler");
        assert_eq!(plan.effective_protocol, "browser");
        assert_eq!(plan.raster_dpi, 300);
        assert_eq!(plan.page_width_mm, Some(210.0));
        assert_eq!(plan.page_height_mm, Some(297.0));
        assert!(plan.ready);
    }

    #[test]
    fn page_target_requires_windows_driver_but_roll_keeps_raw_protocols() {
        let page = plan_backend(&BackendPlanPayload {
            config: json!({"connection":"tcp","protocol":"zpl","ip":"127.0.0.1"}),
            doc: json!({"canvas":{"width":100,"height":100,"widthCm":21,"heightCm":29.7,"labelType":"pallet"}}),
        }).unwrap();
        assert!(!page.ready);
        assert!(page
            .reasons
            .contains(&"page-sheet:windows-driver-required".to_owned()));

        let roll = plan_backend(&BackendPlanPayload {
            config: json!({"connection":"tcp","protocol":"zpl","dpi":203}),
            doc: json!({"canvas":{"width":800,"height":400,"widthCm":10,"heightCm":5,"labelType":"pack"}}),
        }).unwrap();
        assert!(roll.ready);
        assert_eq!(roll.print_target, "label-roll");
        assert_eq!(roll.backend, "zpl-hybrid");
        assert_eq!(roll.raster_dpi, 203);
    }

    #[test]
    fn explicit_target_wins_and_extension_slots_are_reported() {
        let plan = plan_backend(&BackendPlanPayload {
            config: json!({"connection":"windows_driver","protocol":"browser","printTarget":"label-roll","dpi":300}),
            doc: json!({"canvas":{"width":100,"height":100,"widthCm":21,"heightCm":29.7,"labelType":"pallet"}}),
        }).unwrap();
        assert_eq!(plan.print_target, "label-roll");
        assert_eq!(plan.backend, "windows-gdi-label");
        assert_eq!(
            plan.extension_language_slots,
            ["epl", "cpcl", "dpl", "sbpl"]
        );
    }
    #[test]
    fn extension_languages_route_to_active_raster_backends() {
        for (protocol, backend, profile) in [
            ("epl", "epl-raster", "generic-epl-raster"),
            ("cpcl", "cpcl-raster", "generic-cpcl-raster"),
            ("dpl", "dpl-raster", "generic-dpl-raster"),
            ("sbpl", "sbpl-raster", "generic-sbpl-raster"),
        ] {
            let plan = plan_backend(&BackendPlanPayload {
                config: json!({"connection":"tcp","protocol":protocol,"dpi":203}),
                doc: json!({"canvas":{"width":400,"height":300,"widthCm":5.8,"heightCm":4.0,"labelType":"pack"},"elements":[]}),
            })
            .unwrap();
            assert!(plan.ready, "{protocol}: {:?}", plan.reasons);
            assert_eq!(plan.backend, backend);
            assert_eq!(plan.effective_protocol, protocol);
            assert_eq!(plan.profile_id, profile);
        }
    }
}
