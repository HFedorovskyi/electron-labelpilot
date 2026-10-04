//! DEMO mark on labels printed by a station that holds no vendor-signed
//! license token (a trial, or an unlicensed copy fed with hand-made data).
//!
//! It is a deterrent, never a stop: printing, weighing and records work exactly
//! as on a licensed station, so a production line is never halted by licensing.
//! A licensed station receives its token with every server sync (and from the
//! server's ping reply), so legitimate labels never carry the mark.
use crate::crypto;
use crate::persisted::PersistedState;
use serde_json::{json, Value};

pub const DEMO_MARK_ID: &str = "labelpilot-demo-mark";
const DEFAULT_CANVAS_WIDTH: f64 = 580.0;
const DEFAULT_CANVAS_HEIGHT: f64 = 400.0;

/// The label document as it must be printed on this station.
pub fn for_station(persisted: &PersistedState, doc: Value) -> Value {
    if crypto::station_license(persisted).is_some() {
        doc
    } else {
        with_demo_mark(doc)
    }
}

/// Adds a bold "DEMO" text in the top-right corner of the label (once).
pub fn with_demo_mark(mut doc: Value) -> Value {
    let canvas = doc.get("canvas");
    let dimension = |key: &str, fallback: f64| {
        canvas
            .and_then(|canvas| canvas.get(key))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(fallback)
    };
    let width = dimension("width", DEFAULT_CANVAS_WIDTH);
    let height = dimension("height", DEFAULT_CANVAS_HEIGHT);
    let Some(elements) = doc.get_mut("elements").and_then(Value::as_array_mut) else {
        return doc;
    };
    if elements
        .iter()
        .any(|element| element.get("id").and_then(Value::as_str) == Some(DEMO_MARK_ID))
    {
        return doc;
    }
    let mark_height = (height * 0.16).clamp(16.0, height);
    let mark_width = (width * 0.38).clamp(48.0, width);
    let margin = (width * 0.02).round();
    elements.push(json!({
        "id": DEMO_MARK_ID,
        "type": "text",
        "x": (width - mark_width - margin).max(0.0).round(),
        "y": (height * 0.02).round(),
        "w": mark_width.round(),
        "h": mark_height.round(),
        "text": "DEMO",
        "fontFamily": "Inter",
        "fontSize": (mark_height * 0.75).round(),
        "fontWeight": 800,
        "textAlign": "right"
    }));
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_one_corner_mark_scaled_to_the_canvas() {
        let doc = json!({
            "canvas": {"width": 600, "height": 400},
            "elements": [{"id": "name", "type": "text", "text": "Product"}]
        });
        let marked = with_demo_mark(with_demo_mark(doc));
        let elements = marked["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 2);
        let mark = &elements[1];
        assert_eq!(mark["id"], DEMO_MARK_ID);
        assert_eq!(mark["text"], "DEMO");
        assert_eq!(mark["h"], 64.0);
        assert_eq!(mark["w"], 228.0);
        assert_eq!(mark["x"], 360.0);
        assert!(mark["x"].as_f64().unwrap() + mark["w"].as_f64().unwrap() <= 600.0);
    }

    #[test]
    fn documents_without_elements_are_left_alone() {
        let doc = json!({"canvas": {"width": 600, "height": 400}});
        assert_eq!(with_demo_mark(doc.clone()), doc);
    }

    #[test]
    fn a_station_without_a_vendor_token_prints_the_mark() {
        let directory = std::env::temp_dir().join(format!(
            "labelpilot-demo-mark-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let persisted = PersistedState::for_data_dir(directory.clone());
        let doc = json!({"canvas": {"width": 400, "height": 300}, "elements": []});
        assert_eq!(
            for_station(&persisted, doc.clone())["elements"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // A token that does not carry a vendor signature is no license.
        persisted.save_license_token("forged.token").unwrap();
        assert_eq!(
            for_station(&persisted, doc)["elements"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(directory);
    }
}
