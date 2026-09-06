use serde_json::{Map, Value};

pub fn generate_barcode(fields: &[Value], data: &Map<String, Value>) -> String {
    let mut barcode = String::new();
    for field in fields {
        let Some(field) = field.as_object() else {
            continue;
        };
        let field_type = field
            .get("field_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match field_type {
            "constanta" | "constant" => barcode.push_str(string_field(field, "value")),
            "ai" => {
                barcode.push('(');
                barcode.push_str(string_field(field, "value"));
                barcode.push(')');
            }
            "weight" => {
                let weight = number(data.get("weight"))
                    .or_else(|| number(data.get("weight_netto_pack")))
                    .unwrap_or(0.0);
                barcode.push_str(&format_weight(
                    weight,
                    positive_usize(field.get("length")).unwrap_or(5),
                    positive_usize(field.get("decimalPlaces")).unwrap_or(3),
                ));
            }
            "weight_netto_pack"
            | "weight_brutto_pack"
            | "weight_netto_box"
            | "weight_brutto_box"
            | "weight_netto_pallet"
            | "weight_brutto_pallet"
            | "weight_brutto_all" => {
                let weight = number(data.get(field_type)).unwrap_or(0.0);
                barcode.push_str(&format_weight(
                    weight,
                    positive_usize(field.get("length")).unwrap_or(6),
                    positive_usize(field.get("decimalPlaces")).unwrap_or(3),
                ));
            }
            "production_date" | "exp_date" => {
                if let Some(date) = data.get(field_type).and_then(date_parts) {
                    let format = field
                        .get("dateFormat")
                        .and_then(Value::as_str)
                        .unwrap_or("yyMMdd");
                    barcode.push_str(&format_date(date, format));
                }
            }
            "article" => {
                let length = positive_usize(field.get("length")).unwrap_or(14);
                let article = value_string(data.get("article"));
                if length == 14 {
                    let padded = pad_start(&article, 13, '0');
                    let base: String = padded
                        .chars()
                        .rev()
                        .take(13)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    if let Some(check) = gtin14_check_digit(&base) {
                        barcode.push_str(&base);
                        barcode.push(check);
                    }
                } else {
                    barcode.push_str(&pad_start(&article, length, '0'));
                }
            }
            "batch_number" | "pack_number" | "box_number" => {
                let length = positive_usize(field.get("length"))
                    .or_else(|| positive_usize(field.get("minLength")))
                    .or_else(|| positive_usize(field.get("minLeght")))
                    .unwrap_or(0);
                barcode.push_str(&pad_start(&value_string(data.get(field_type)), length, '0'));
            }
            "pallet_number" => {
                let length = positive_usize(field.get("length")).unwrap_or(0);
                barcode.push_str(&pad_start(
                    &value_string(data.get("pallet_number")),
                    length,
                    '0',
                ));
            }
            "extra_data" => {
                let key = string_field(field, "value");
                if !key.is_empty() {
                    let value = value_string(data.get(key));
                    let length = positive_usize(field.get("length")).unwrap_or(0);
                    if length == 0 {
                        barcode.push_str(&value);
                    } else {
                        barcode.push_str(
                            &pad_start(&value, length, '0')
                                .chars()
                                .take(length)
                                .collect::<String>(),
                        );
                    }
                }
            }
            _ => {}
        }
    }
    barcode
}

fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) => value.parse().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn positive_usize(value: Option<&Value>) -> Option<usize> {
    number(value)
        .map(|value| value.trunc() as i64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
}

fn format_weight(weight: f64, length: usize, decimals: usize) -> String {
    let multiplier = 10_f64.powi(decimals.min(12) as i32);
    let scaled = (weight * multiplier).round() as i128;
    pad_start(&scaled.to_string(), length, '0')
}

fn pad_start(value: &str, length: usize, fill: char) -> String {
    let current = value.chars().count();
    if current >= length {
        return value.to_owned();
    }
    let mut result = String::with_capacity(value.len() + length - current);
    result.extend(std::iter::repeat_n(fill, length - current));
    result.push_str(value);
    result
}

fn date_parts(value: &Value) -> Option<(String, String, String)> {
    let text = value.as_str()?;
    let date = text.get(..10)?;
    let bytes = date.as_bytes();
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    Some((
        date[0..4].to_owned(),
        date[5..7].to_owned(),
        date[8..10].to_owned(),
    ))
}

fn format_date((year, month, day): (String, String, String), format: &str) -> String {
    format
        .replace("yyyy", &year)
        .replace("yy", &year[year.len().saturating_sub(2)..])
        .replace("dd", &day)
        .replace("MM", &month)
}

fn gtin14_check_digit(input: &str) -> Option<char> {
    let digits: Option<Vec<u32>> = input
        .chars()
        .map(|character| character.to_digit(10))
        .collect();
    let digits = digits?;
    if digits.len() != 13 {
        return None;
    }
    let sum: u32 = digits
        .iter()
        .enumerate()
        .map(|(index, digit)| digit * if index % 2 == 0 { 3 } else { 1 })
        .sum();
    char::from_digit((10 - sum % 10) % 10, 10)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_the_shared_generator_for_industrial_fields() {
        let fields = json!([
            {"field_type":"ai","value":"01"},
            {"field_type":"article","length":14},
            {"field_type":"ai","value":"3103"},
            {"field_type":"weight_netto_pack","length":6,"decimalPlaces":3},
            {"field_type":"production_date","dateFormat":"yyMMdd"},
            {"field_type":"box_number","length":5},
            {"field_type":"extra_data","value":"line","length":3}
        ]);
        let data = json!({
            "article":"460123456789",
            "weight_netto_pack":1.2345,
            "production_date":"2026-08-14T00:00:00.000Z",
            "box_number":"42",
            "line":"7"
        });
        assert_eq!(
            generate_barcode(fields.as_array().unwrap(), data.as_object().unwrap()),
            "(01)04601234567893(3103)00123526081400042007"
        );
    }

    #[test]
    fn extra_data_uses_the_named_product_field() {
        let fields = json!([
            {"field_type":"extra_data","value":"Код ШК","length":13}
        ]);
        let data = json!({"Код ШК":"4870254930134"});
        assert_eq!(
            generate_barcode(fields.as_array().unwrap(), data.as_object().unwrap()),
            "4870254930134"
        );
    }

    #[test]
    fn supports_legacy_names_and_collision_replacement() {
        let fields = json!([
            {"field_type":"constanta","value":"X"},
            {"field_type":"weight","length":5,"decimalPlaces":2},
            {"field_type":"batch_number","minLeght":4},
            {"field_type":"box_number","minLength":4}
        ]);
        let mut data = json!({"weight":2.5,"batch_number":"9","box_number":"1"});
        assert_eq!(
            generate_barcode(fields.as_array().unwrap(), data.as_object().unwrap()),
            "X0025000090001"
        );
        data["box_number"] = json!("1_1");
        assert!(
            generate_barcode(fields.as_array().unwrap(), data.as_object().unwrap())
                .ends_with("1_1")
        );
    }
}
