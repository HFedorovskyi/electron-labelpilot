use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

pub const MAX_LABEL_ELEMENTS: usize = 1024;
pub const MAX_GENERATOR_INPUT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_GENERATED_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPayload {
    pub config: Value,
    pub doc: Value,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPlan {
    pub requested_protocol: String,
    pub effective_protocol: String,
    pub backend: String,
    pub native_eligible: bool,
    pub profile_id: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GenerationConfig {
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub dpi: Option<u16>,
    #[serde(default)]
    pub width_mm: Option<f64>,
    #[serde(default)]
    pub height_mm: Option<f64>,
    #[serde(default)]
    pub darkness: Option<f64>,
    #[serde(default)]
    pub print_speed: Option<f64>,
    #[serde(default)]
    pub gap_mm: Option<f64>,
    #[serde(default)]
    compatibility_mode: Option<String>,
    #[serde(default)]
    detected_profile_id: Option<String>,
    #[serde(default)]
    detected_endpoint_key: Option<String>,
    #[serde(default)]
    connection: String,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    serial_port: Option<String>,
    #[serde(default)]
    baud_rate: Option<u32>,
    #[serde(default)]
    driver_name: Option<String>,
}

fn default_protocol() -> String {
    "zpl".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LabelDoc {
    pub canvas: LabelCanvas,
    #[serde(default)]
    pub width_mm: Option<f64>,
    #[serde(default)]
    pub height_mm: Option<f64>,
    pub elements: Vec<LabelElement>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LabelCanvas {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub width_cm: Option<f64>,
    #[serde(default)]
    pub height_cm: Option<f64>,
    #[serde(default)]
    pub dpi: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LabelElement {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub font_weight: Value,
    #[serde(default)]
    pub font_style: Option<String>,
    #[serde(default)]
    pub text_align: Option<String>,
    #[serde(default)]
    pub vertical_align: Option<String>,
    #[serde(default)]
    pub text_decoration: Option<String>,
    #[serde(default)]
    pub fill: Option<String>,
    #[serde(default)]
    pub border_width: Option<f64>,
    #[serde(default)]
    pub border_radius: Option<f64>,
    #[serde(default)]
    pub barcode_type: Option<Value>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub show_text: bool,
    #[serde(default)]
    pub image_data: Option<String>,
    #[serde(default)]
    pub module_width: Option<f64>,
}

#[derive(Clone, Copy)]
pub(super) struct Profile {
    pub id: &'static str,
    language: &'static str,
    native_text: bool,
    pub native_utf8_text: bool,
    native_barcodes: &'static [&'static str],
    pub rounded_boxes: bool,
    pub terminator: &'static str,
}

const ZPL_1D: &[&str] = &[
    "code128",
    "gs1-128",
    "ean13",
    "ean8",
    "upca",
    "upce",
    "code39",
    "interleaved2of5",
];
const ZPL_FULL: &[&str] = &[
    "code128",
    "gs1-128",
    "ean13",
    "ean8",
    "upca",
    "upce",
    "code39",
    "interleaved2of5",
    "qrcode",
    "gs1qrcode",
    "datamatrix",
    "gs1datamatrix",
];
const TSPL_1D: &[&str] = &[
    "code128",
    "ean13",
    "ean8",
    "upca",
    "upce",
    "code39",
    "interleaved2of5",
];
const TSPL_FULL: &[&str] = &[
    "code128",
    "ean13",
    "ean8",
    "upca",
    "upce",
    "code39",
    "interleaved2of5",
    "qrcode",
    "datamatrix",
];

const GENERIC_ZPL: Profile = Profile {
    id: "generic-zpl-safe",
    language: "zpl",
    native_text: true,
    native_utf8_text: false,
    native_barcodes: ZPL_1D,
    rounded_boxes: false,
    terminator: "\n",
};
const ZPL_ADVANCED: Profile = Profile {
    id: "zpl-full",
    language: "zpl",
    native_text: true,
    native_utf8_text: true,
    native_barcodes: ZPL_FULL,
    rounded_boxes: true,
    terminator: "\n",
};
const GENERIC_TSPL: Profile = Profile {
    id: "generic-tspl-safe",
    language: "tspl",
    native_text: true,
    native_utf8_text: false,
    native_barcodes: TSPL_1D,
    rounded_boxes: false,
    terminator: "\r\n",
};
const TSPL_ADVANCED: Profile = Profile {
    id: "tspl2-full",
    language: "tspl",
    native_text: true,
    native_utf8_text: false,
    native_barcodes: TSPL_FULL,
    rounded_boxes: true,
    terminator: "\r\n",
};

const GENERIC_EPL_RASTER: Profile = Profile {
    id: "generic-epl-raster",
    language: "epl",
    native_text: false,
    native_utf8_text: false,
    native_barcodes: &[],
    rounded_boxes: false,
    terminator: "\n",
};
const GENERIC_CPCL_RASTER: Profile = Profile {
    id: "generic-cpcl-raster",
    language: "cpcl",
    native_text: false,
    native_utf8_text: false,
    native_barcodes: &[],
    rounded_boxes: false,
    terminator: "\r\n",
};
const GENERIC_DPL_RASTER: Profile = Profile {
    id: "generic-dpl-raster",
    language: "dpl",
    native_text: false,
    native_utf8_text: false,
    native_barcodes: &[],
    rounded_boxes: false,
    terminator: "\r",
};
const GENERIC_SBPL_RASTER: Profile = Profile {
    id: "generic-sbpl-raster",
    language: "sbpl",
    native_text: false,
    native_utf8_text: false,
    native_barcodes: &[],
    rounded_boxes: false,
    terminator: "",
};

pub(super) struct ParsedInput {
    pub config: GenerationConfig,
    pub doc: LabelDoc,
    pub data: Map<String, Value>,
    pub profile: Profile,
}

#[derive(Clone, Copy)]
pub(super) struct Geometry {
    pub width_mm: f64,
    pub height_mm: f64,
    pub width_dots: i64,
    pub height_dots: i64,
    pub scale_x: f64,
    pub scale_y: f64,
}

impl ParsedInput {
    pub fn parse(payload: &GenerationPayload) -> Result<Self, String> {
        let input_bytes = serde_json::to_vec(&(&payload.config, &payload.doc, &payload.data))
            .map_err(|error| format!("failed to measure generator input: {error}"))?
            .len();
        if input_bytes > MAX_GENERATOR_INPUT_BYTES {
            return Err(format!(
                "generator input exceeds {} bytes",
                MAX_GENERATOR_INPUT_BYTES
            ));
        }
        let mut config: GenerationConfig = serde_json::from_value(payload.config.clone())
            .map_err(|error| format!("invalid printer generator config: {error}"))?;
        config.protocol = config.protocol.trim().to_ascii_lowercase();
        let doc: LabelDoc = serde_json::from_value(payload.doc.clone())
            .map_err(|error| format!("invalid label document: {error}"))?;
        let data = payload
            .data
            .as_object()
            .cloned()
            .ok_or_else(|| "label data must be an object".to_owned())?;
        validate_config(&config)?;
        validate_doc(&doc)?;
        let profile = resolve_profile(&config);
        Ok(Self {
            config,
            doc,
            data,
            profile,
        })
    }

    pub fn plan(&self) -> GenerationPlan {
        let mut reasons = Vec::new();
        match self.config.protocol.as_str() {
            "zpl" => self.zpl_fallback_reasons(&mut reasons),
            "tspl" => self.tspl_fallback_reasons(&mut reasons),
            "image" => reasons.push("protocol:image".to_owned()),
            "browser" => reasons.push("protocol:browser".to_owned()),
            protocol @ ("epl" | "cpcl" | "dpl" | "sbpl") => {
                reasons.push(format!("protocol:raster-adapter:{protocol}"))
            }
            other => reasons.push(format!("protocol:unsupported:{other}")),
        }
        let native_eligible = reasons.is_empty();
        let effective_protocol = if native_eligible {
            self.config.protocol.clone()
        } else if self.config.protocol == "zpl" {
            "image".to_owned()
        } else {
            self.config.protocol.clone()
        };
        GenerationPlan {
            requested_protocol: self.config.protocol.clone(),
            effective_protocol,
            backend: if native_eligible {
                "rust-native".to_owned()
            } else if matches!(
                self.config.protocol.as_str(),
                "epl" | "cpcl" | "dpl" | "sbpl"
            ) {
                "tauri-raster-adapter".to_owned()
            } else {
                "renderer-bitmap".to_owned()
            },
            native_eligible,
            profile_id: self.profile.id.to_owned(),
            reasons,
        }
    }

    fn zpl_fallback_reasons(&self, reasons: &mut Vec<String>) {
        for element in &self.doc.elements {
            match element.kind.as_str() {
                "table" => reasons.push(format!("{}:table", element.id)),
                "text" => {
                    if !self.profile.native_text {
                        reasons.push(format!("{}:native-text", element.id));
                    } else {
                        let value = interpolate(element.text.as_deref().unwrap_or(""), &self.data);
                        if !self.profile.native_utf8_text && !is_printable_ascii(&value) {
                            reasons.push(format!("{}:unicode-text", element.id));
                        }
                    }
                }
                "barcode" => {
                    if element
                        .image_data
                        .as_deref()
                        .is_some_and(|value| !value.is_empty())
                    {
                        reasons.push(format!("{}:barcode-image", element.id));
                    }
                    let barcode = normalize_barcode(element.barcode_type.as_ref());
                    if !self.profile.native_barcodes.contains(&barcode.as_str()) {
                        reasons.push(format!("{}:barcode-{barcode}", element.id));
                    }
                }
                "rect" => {}
                other => reasons.push(format!("{}:element-{other}", element.id)),
            }
        }
    }

    fn tspl_fallback_reasons(&self, reasons: &mut Vec<String>) {
        for element in &self.doc.elements {
            match element.kind.as_str() {
                "table" => reasons.push(format!("{}:table", element.id)),
                "text" => {
                    let value = interpolate(element.text.as_deref().unwrap_or(""), &self.data);
                    if tspl_text_requires_bitmap(element, &value) {
                        reasons.push(format!("{}:complex-text", element.id));
                    }
                }
                "barcode" => {
                    let value = interpolate(
                        element
                            .value
                            .as_deref()
                            .or(element.text.as_deref())
                            .unwrap_or(""),
                        &self.data,
                    );
                    let barcode = normalize_barcode(element.barcode_type.as_ref());
                    if !self.profile.native_barcodes.contains(&barcode.as_str())
                        || !native_barcode_value_safe(&value)
                        || needs_gs1_parse(&barcode, &value)
                    {
                        reasons.push(format!("{}:barcode-{barcode}", element.id));
                    }
                }
                "rect" => {}
                other => reasons.push(format!("{}:element-{other}", element.id)),
            }
        }
    }

    pub fn geometry(&self) -> Result<Geometry, String> {
        let dpi = f64::from(self.config.dpi.unwrap_or(203));
        let width_mm = positive(self.doc.width_mm)
            .or_else(|| positive(self.config.width_mm))
            .or_else(|| positive(self.doc.canvas.width_cm).map(|value| value * 10.0))
            .unwrap_or(self.doc.canvas.width * 25.4 / self.doc.canvas.dpi.unwrap_or(96.0));
        let height_mm = positive(self.doc.height_mm)
            .or_else(|| positive(self.config.height_mm))
            .or_else(|| positive(self.doc.canvas.height_cm).map(|value| value * 10.0))
            .unwrap_or(self.doc.canvas.height * 25.4 / self.doc.canvas.dpi.unwrap_or(96.0));
        if !width_mm.is_finite()
            || !height_mm.is_finite()
            || width_mm <= 0.0
            || height_mm <= 0.0
            || width_mm > 10_000.0
            || height_mm > 10_000.0
        {
            return Err("resolved label size must be finite and within 0..10000 mm".to_owned());
        }
        let width_dots = js_round(width_mm * dpi / 25.4).max(1);
        let height_dots = js_round(height_mm * dpi / 25.4).max(1);
        Ok(Geometry {
            width_mm,
            height_mm,
            width_dots,
            height_dots,
            scale_x: width_dots as f64 / self.doc.canvas.width,
            scale_y: height_dots as f64 / self.doc.canvas.height,
        })
    }
}

fn validate_config(config: &GenerationConfig) -> Result<(), String> {
    if !matches!(
        config.protocol.as_str(),
        "zpl" | "tspl" | "epl" | "cpcl" | "dpl" | "sbpl" | "image" | "browser"
    ) {
        return Err(format!("unsupported printer protocol: {}", config.protocol));
    }
    if config
        .dpi
        .is_some_and(|dpi| !matches!(dpi, 203 | 300 | 600))
    {
        return Err("printer dpi must be 203, 300 or 600".to_owned());
    }
    for (name, value) in [
        ("widthMm", config.width_mm),
        ("heightMm", config.height_mm),
        ("darkness", config.darkness),
        ("printSpeed", config.print_speed),
        ("gapMm", config.gap_mm),
    ] {
        if value.is_some_and(|value| !value.is_finite()) {
            return Err(format!("printer {name} must be finite"));
        }
    }
    Ok(())
}

fn validate_doc(doc: &LabelDoc) -> Result<(), String> {
    if doc.elements.len() > MAX_LABEL_ELEMENTS {
        return Err(format!(
            "label has more than {} elements",
            MAX_LABEL_ELEMENTS
        ));
    }
    if !doc.canvas.width.is_finite()
        || !doc.canvas.height.is_finite()
        || doc.canvas.width <= 0.0
        || doc.canvas.height <= 0.0
        || doc.canvas.width > 100_000.0
        || doc.canvas.height > 100_000.0
    {
        return Err("canvas width/height must be finite and within 0..100000".to_owned());
    }
    for element in &doc.elements {
        if element.id.len() > 256 || element.kind.len() > 32 {
            return Err("label element id/type exceeds bounds".to_owned());
        }
        for value in [element.x, element.y, element.w, element.h] {
            if !value.is_finite() || value.abs() > 100_000.0 {
                return Err(format!("element {} geometry is out of bounds", element.id));
            }
        }
        for text in [element.text.as_deref(), element.value.as_deref()]
            .into_iter()
            .flatten()
        {
            if text.len() > 1024 * 1024 {
                return Err(format!("element {} text exceeds 1 MiB", element.id));
            }
        }
    }
    Ok(())
}

fn resolve_profile(config: &GenerationConfig) -> Profile {
    let language = match config.protocol.as_str() {
        protocol @ ("tspl" | "epl" | "cpcl" | "dpl" | "sbpl") => protocol,
        _ => "zpl",
    };
    let compatible = match language {
        "tspl" => GENERIC_TSPL,
        "epl" => GENERIC_EPL_RASTER,
        "cpcl" => GENERIC_CPCL_RASTER,
        "dpl" => GENERIC_DPL_RASTER,
        "sbpl" => GENERIC_SBPL_RASTER,
        _ => GENERIC_ZPL,
    };
    let advanced = match language {
        "tspl" => TSPL_ADVANCED,
        "epl" => GENERIC_EPL_RASTER,
        "cpcl" => GENERIC_CPCL_RASTER,
        "dpl" => GENERIC_DPL_RASTER,
        "sbpl" => GENERIC_SBPL_RASTER,
        _ => ZPL_ADVANCED,
    };
    match config.compatibility_mode.as_deref().unwrap_or("auto") {
        "compatible" => compatible,
        "advanced" => advanced,
        _ => {
            let endpoint = physical_endpoint_key(config);
            let endpoint_matches =
                config.detected_endpoint_key.as_deref() == Some(endpoint.as_str());
            if endpoint_matches {
                let detected = match config.detected_profile_id.as_deref() {
                    Some("generic-zpl-safe") => Some(GENERIC_ZPL),
                    Some("zpl-full") => Some(ZPL_ADVANCED),
                    Some("generic-tspl-safe") => Some(GENERIC_TSPL),
                    Some("tspl2-full") => Some(TSPL_ADVANCED),
                    Some("generic-epl-raster") => Some(GENERIC_EPL_RASTER),
                    Some("generic-cpcl-raster") => Some(GENERIC_CPCL_RASTER),
                    Some("generic-dpl-raster") => Some(GENERIC_DPL_RASTER),
                    Some("generic-sbpl-raster") => Some(GENERIC_SBPL_RASTER),
                    _ => None,
                };
                if let Some(profile) = detected.filter(|profile| profile.language == language) {
                    return profile;
                }
            }
            compatible
        }
    }
}

fn physical_endpoint_key(config: &GenerationConfig) -> String {
    match config.connection.as_str() {
        "tcp" => format!(
            "tcp:{}:{}",
            config.ip.as_deref().unwrap_or(""),
            config.port.unwrap_or(9100)
        ),
        "serial" => format!(
            "serial:{}:{}",
            config
                .serial_port
                .as_deref()
                .unwrap_or("")
                .to_ascii_uppercase(),
            config.baud_rate.unwrap_or(9600)
        ),
        _ => format!("spooler:{}", config.driver_name.as_deref().unwrap_or("")),
    }
}

pub(super) fn interpolate(template: &str, data: &Map<String, Value>) -> String {
    static PLACEHOLDER: OnceLock<Regex> = OnceLock::new();
    let regex = PLACEHOLDER.get_or_init(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap());
    let lower: HashMap<String, &Value> = data
        .iter()
        .map(|(key, value)| (key.to_ascii_lowercase(), value))
        .collect();
    regex
        .replace_all(template, |captures: &regex::Captures<'_>| {
            let key = captures
                .get(1)
                .map(|value| value.as_str().trim())
                .unwrap_or("");
            let value = data
                .get(key)
                .or_else(|| lower.get(&key.to_ascii_lowercase()).copied());
            value.map(js_value_string).unwrap_or_else(|| {
                captures
                    .get(0)
                    .map(|value| value.as_str().to_owned())
                    .unwrap_or_default()
            })
        })
        .into_owned()
}

fn js_value_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(js_value_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

pub(super) fn normalize_barcode(raw: Option<&Value>) -> String {
    let value = match raw {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => js_value_string(value),
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "21" | "ean13" | "ean-13" | "ean13_kz" | "ean13kz" => "ean13",
        "22" | "ean8" | "ean-8" => "ean8",
        "23" | "code128" | "code-128" => "code128",
        "gs1-128" | "gs1128" | "ean128" => "gs1-128",
        "upca" | "upc-a" | "upc" => "upca",
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
        other => return other.to_owned(),
    }
    .to_owned()
}

pub(super) fn tspl_text_requires_bitmap(element: &LabelElement, value: &str) -> bool {
    let numeric_weight = match &element.font_weight {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => value.parse::<f64>().ok(),
        _ => None,
    };
    let weight_text = match &element.font_weight {
        Value::String(value) => value.to_ascii_lowercase(),
        Value::Number(value) => value.to_string(),
        _ => String::new(),
    };
    !is_printable_ascii(value)
        || value.contains('"')
        || value.contains('\n')
        || element.font_family.as_deref().is_some_and(|family| {
            !family.is_empty() && !matches!(family.to_ascii_lowercase().as_str(), "0" | "arial")
        })
        || element
            .font_style
            .as_deref()
            .is_some_and(|style| !style.is_empty() && style != "normal")
        || weight_text.contains("bold")
        || numeric_weight.is_some_and(|weight| weight >= 600.0)
        || element
            .text_decoration
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || element.text_align.as_deref() == Some("justify")
        || matches!(element.vertical_align.as_deref(), Some("middle" | "bottom"))
}

fn is_printable_ascii(value: &str) -> bool {
    value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

pub(super) fn native_barcode_value_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| (0x20..=0x7e).contains(&byte) && byte != b'"')
}

pub(super) fn needs_gs1_parse(barcode: &str, value: &str) -> bool {
    static AI: OnceLock<Regex> = OnceLock::new();
    barcode.starts_with("gs1")
        || barcode.starts_with("databar")
        || AI
            .get_or_init(|| Regex::new(r"\(\d{2,4}\)").unwrap())
            .is_match(value)
}

pub(super) fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn positive(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value != 0.0)
}
