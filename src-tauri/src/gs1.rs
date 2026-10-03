//! GS1 compliance checks applied at print time.
//!
//! Element strings use the parenthesised form templates are written in, for
//! example `(01)04012345000016(3103)001250(10)LOT7`. The AI table follows the
//! GS1 General Specifications for the identifiers food producers use; an
//! unknown AI is rejected instead of printing a code a retailer cannot parse.

/// Minimum X-dimension for EAN/UPC symbols scanned at retail POS (80 % of the
/// 0.330 mm nominal, GS1 General Specifications symbol specification table 1).
/// It is checked at design time; a whole-dot module on a 300 dpi head reaches
/// it only at 4 dots, so refusing to print below it would reject ordinary
/// 2x1 inch labels.
pub(crate) const RETAIL_MIN_X_MM: f64 = 0.264;

/// Print-time floor for EAN/UPC: about 95 % of the GS1 minimum and the
/// coarsest module whole dots give on common heads (203 dpi: 2, 300 dpi: 3,
/// 600 dpi: 6). Narrower symbols are refused instead of printed unreadable.
pub(crate) const RETAIL_PRINT_FLOOR_X_MM: f64 = 0.25;

/// Bar modules of EAN/UPC symbols (without quiet zones).
pub(crate) fn retail_symbol_modules(kind: &str) -> Option<usize> {
    match kind {
        "ean13" | "upca" => Some(95),
        "ean8" => Some(67),
        "upce" => Some(51),
        _ => None,
    }
}

/// Smallest whole number of printer dots per module that reaches the
/// print-time floor, for EAN/UPC symbols only.
pub(crate) fn retail_min_module_dots(kind: &str, dots_per_mm: f64) -> Option<usize> {
    retail_symbol_modules(kind)?;
    if !dots_per_mm.is_finite() || dots_per_mm <= 0.0 {
        return None;
    }
    Some(((RETAIL_PRINT_FLOOR_X_MM * dots_per_mm) - 1e-6).ceil().max(1.0) as usize)
}

/// Operator-facing explanation for an EAN/UPC element too narrow for the
/// GS1 minimum module at this printer resolution.
pub(crate) fn narrow_retail_symbol_error(
    kind: &str,
    element_mm: f64,
    required_mm: f64,
    min_dots: usize,
) -> String {
    format!(
        "{} слишком узкий для печати: элемент {element_mm:.1} мм, нужно не меньше \
         {required_mm:.1} мм (модуль {min_dots} точ. ≥ {RETAIL_PRINT_FLOOR_X_MM} мм; минимум GS1 — \
         {RETAIL_MIN_X_MM} мм). Расширьте штрихкод в шаблоне.",
        kind.to_ascii_uppercase()
    )
}

pub(crate) fn is_gs1_symbology(kind: &str) -> bool {
    matches!(
        kind,
        "gs1-128" | "gs1datamatrix" | "gs1qrcode" | "databarexpandedstacked"
    )
}

#[derive(Clone, Copy)]
enum Content {
    /// Fixed number of digits.
    Digits(usize),
    /// Fixed number of digits whose last digit is a GS1 mod-10 check digit.
    CheckedDigits(usize),
    /// YYMMDD; DD may be 00 when only year and month are known.
    Date,
    /// Variable number of digits.
    DigitsUpTo(usize, usize),
    /// Variable GS1 character set 82 text.
    TextUpTo(usize),
    /// Three-digit ISO country/currency code followed by variable content.
    IsoThenDigitsUpTo(usize),
    IsoThenTextUpTo(usize),
}

fn content_for(ai: &str) -> Option<Content> {
    use Content::*;
    let content = match ai {
        "00" => CheckedDigits(18),
        "01" | "02" => CheckedDigits(14),
        "10" | "21" | "22" | "254" | "420" => TextUpTo(20),
        "11" | "12" | "13" | "15" | "16" | "17" | "7006" => Date,
        "20" => Digits(2),
        "240" | "241" | "250" | "251" | "400" | "401" | "403" | "7002" | "90" => TextUpTo(30),
        "30" | "37" => DigitsUpTo(1, 8),
        "402" => CheckedDigits(17),
        "410" | "411" | "412" | "413" | "414" | "415" | "416" | "417" => CheckedDigits(13),
        "421" => IsoThenTextUpTo(9),
        "422" | "424" | "426" => Digits(3),
        "423" | "425" => IsoThenDigitsUpTo(12),
        "7001" => Digits(13),
        "7003" => Digits(10),
        "7005" => TextUpTo(12),
        "7007" => DigitsUpTo(6, 12),
        "7008" => TextUpTo(3),
        "7009" => TextUpTo(10),
        "7010" => TextUpTo(2),
        "8005" => Digits(6),
        "8008" => DigitsUpTo(8, 12),
        "8020" => TextUpTo(25),
        "91" | "92" | "93" | "94" | "95" | "96" | "97" | "98" | "99" => TextUpTo(90),
        _ => return measure_or_processor(ai),
    };
    Some(content)
}

/// Measures (`310n`…`369n`), amounts (`390n`…`393n`) and processor approval
/// numbers (`7030`…`7039`), whose last digit is a parameter.
fn measure_or_processor(ai: &str) -> Option<Content> {
    if ai.len() != 4 || !ai.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let family: u16 = ai[..3].parse().ok()?;
    let parameter = ai.as_bytes()[3] - b'0';
    match family {
        310..=316 | 320..=337 | 340..=357 | 360..=369 if parameter <= 5 => {
            Some(Content::Digits(6))
        }
        390 | 392 => Some(Content::DigitsUpTo(1, 15)),
        391 | 393 => Some(Content::IsoThenDigitsUpTo(15)),
        703 => Some(Content::IsoThenTextUpTo(27)),
        _ => None,
    }
}

/// GS1 AI character set 82.
fn is_cset82(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!\"%&'()*+,-./:;<=>?_".contains(&byte)
}

fn gs1_check_digit_valid(digits: &str) -> bool {
    let bytes = digits.as_bytes();
    let Some((&check, body)) = bytes.split_last() else {
        return false;
    };
    let sum: u32 = body
        .iter()
        .rev()
        .enumerate()
        .map(|(index, byte)| u32::from(byte - b'0') * if index % 2 == 0 { 3 } else { 1 })
        .sum();
    (10 - sum % 10) % 10 == u32::from(check - b'0')
}

fn valid_date(value: &str) -> bool {
    let month: u32 = value[2..4].parse().unwrap_or(0);
    let day: u32 = value[4..6].parse().unwrap_or(99);
    (1..=12).contains(&month) && day <= 31
}

fn validate_value(ai: &str, value: &str, content: Content) -> Result<(), String> {
    let digits = |value: &str| value.bytes().all(|byte| byte.is_ascii_digit());
    let text = |value: &str| value.bytes().all(is_cset82);
    // Byte slicing is safe: both prefixes are checked to be ASCII digits first.
    let iso_then = |rest_ok: &dyn Fn(&str) -> bool| match (value.get(..3), value.get(3..)) {
        (Some(iso), Some(rest)) => digits(iso) && rest_ok(rest),
        _ => false,
    };
    let ok = match content {
        Content::Digits(length) => value.len() == length && digits(value),
        Content::CheckedDigits(length) => {
            if value.len() != length || !digits(value) {
                false
            } else if !gs1_check_digit_valid(value) {
                return Err(format!("AI ({ai}): неверная контрольная цифра в {value}"));
            } else {
                true
            }
        }
        Content::Date => {
            if value.len() != 6 || !digits(value) {
                false
            } else if !valid_date(value) {
                return Err(format!("AI ({ai}): недопустимая дата {value} (нужно ГГММДД)"));
            } else {
                true
            }
        }
        Content::DigitsUpTo(minimum, maximum) => {
            (minimum..=maximum).contains(&value.len()) && digits(value)
        }
        Content::TextUpTo(maximum) => !value.is_empty() && value.len() <= maximum && text(value),
        Content::IsoThenDigitsUpTo(maximum) => {
            iso_then(&|rest| rest.len() <= maximum && digits(rest))
        }
        Content::IsoThenTextUpTo(maximum) => {
            iso_then(&|rest| rest.len() <= maximum && text(rest))
        }
    };
    if ok {
        Ok(())
    } else {
        Err(format!("AI ({ai}): недопустимое значение «{value}»"))
    }
}

/// Validates a parenthesised GS1 element string.
pub(crate) fn validate_element_string(value: &str) -> Result<(), String> {
    if !value.starts_with('(') {
        return Err("GS1-код должен начинаться с AI в скобках, например (01)".to_owned());
    }
    let mut rest = value;
    let mut seen = Vec::new();
    while !rest.is_empty() {
        let after_open = rest
            .strip_prefix('(')
            .ok_or_else(|| format!("ожидается AI в скобках в «{rest}»"))?;
        let close = after_open
            .find(')')
            .ok_or_else(|| "AI без закрывающей скобки".to_owned())?;
        let ai = &after_open[..close];
        if !(2..=4).contains(&ai.len()) || !ai.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("недопустимый AI ({ai})"));
        }
        let tail = &after_open[close + 1..];
        let end = next_ai_start(tail).unwrap_or(tail.len());
        let data = &tail[..end];
        let content =
            content_for(ai).ok_or_else(|| format!("AI ({ai}) не поддерживается"))?;
        validate_value(ai, data, content)?;
        if seen.contains(&ai) {
            return Err(format!("AI ({ai}) повторяется"));
        }
        seen.push(ai);
        rest = &tail[end..];
    }
    if seen.is_empty() {
        return Err("GS1-код не содержит ни одного AI".to_owned());
    }
    Ok(())
}

/// Start of the next `(NN…)` group; a parenthesis inside CSET 82 text that is
/// not followed by 2–4 digits and `)` stays part of the value.
fn next_ai_start(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    (0..bytes.len()).find(|&start| {
        bytes[start] == b'('
            && (2..=4).any(|length| {
                let close = start + length + 1;
                close < bytes.len()
                    && bytes[close] == b')'
                    && bytes[start + 1..close].iter().all(u8::is_ascii_digit)
            })
    })
}

/// GTIN carried by a scanned code, without leading zeros, so GTIN-8/12/13/14
/// spellings of one item compare equal. Accepts EAN/UPC digits, a raw GS1
/// string starting with AI 01 (as keyboard-wedge scanners send GS1-128 and
/// GS1 DataMatrix) and the parenthesised form; an AIM symbology identifier
/// such as `]C1` or `]d2` is ignored.
pub(crate) fn scanned_gtin(code: &str) -> Option<String> {
    let code = code.trim();
    let code = match code.as_bytes() {
        [b']', _, _, ..] => code.get(3..)?,
        _ => code,
    };
    let digits = |value: &str| value.bytes().all(|byte| byte.is_ascii_digit());
    let gtin = if let Some(rest) = code.strip_prefix("(01)") {
        rest.get(..14).filter(|value| digits(value))?
    } else if code.len() >= 16 && code.starts_with("01") && code.get(2..16).is_some_and(digits) {
        &code[2..16]
    } else if matches!(code.len(), 8 | 12 | 13 | 14) && digits(code) {
        code
    } else {
        return None;
    };
    let trimmed = gtin.trim_start_matches('0');
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanned_codes_resolve_to_comparable_gtins() {
        assert_eq!(scanned_gtin("4870254930240").as_deref(), Some("4870254930240"));
        assert_eq!(scanned_gtin("04870254930240").as_deref(), Some("4870254930240"));
        assert_eq!(
            scanned_gtin("0104870254930240\u{1d}10LOT7").as_deref(),
            Some("4870254930240")
        );
        assert_eq!(
            scanned_gtin("]d20104870254930240172610001").as_deref(),
            Some("4870254930240")
        );
        assert_eq!(scanned_gtin("(01)04870254930240(10)A1").as_deref(), Some("4870254930240"));
        assert_eq!(scanned_gtin("ART-42"), None);
        assert_eq!(scanned_gtin("12345"), None);
        assert_eq!(scanned_gtin("00000000"), None);
    }

    #[test]
    fn accepts_typical_food_label_strings() {
        for value in [
            "(01)04012345000016(3103)001250(10)LOT-7(15)261231",
            "(00)340123450000000000",
            "(01)94012345000019(3102)012345(11)260930(17)261000",
            "(01)04012345000016(422)276(7030)276DE-NW-123-EG",
            "(02)04012345000016(37)24",
            "(01)04012345000016(3922)1250",
        ] {
            assert_eq!(validate_element_string(value), Ok(()), "{value}");
        }
    }

    #[test]
    fn rejects_what_a_retailer_scanner_would_reject() {
        for (value, expected) in [
            ("(01)04012345000017", "контрольная цифра"),
            ("(00)340123450000000006", "контрольная цифра"),
            ("(01)4012345000016", "недопустимое значение"),
            ("(3103)1250", "недопустимое значение"),
            ("(3109)001250", "не поддерживается"),
            ("(15)261331", "недопустимая дата"),
            ("(10)LOT 7", "недопустимое значение"),
            ("(10)ABCDEFGHIJKLMNOPQRSTU", "недопустимое значение"),
            ("(01)04012345000016(01)04012345000016", "повторяется"),
            ("(9999)X", "не поддерживается"),
            ("0104012345000016", "AI в скобках"),
            ("(01", "закрывающей"),
            ("(421)27ä", "недопустимое значение"),
        ] {
            let error = validate_element_string(value).unwrap_err();
            assert!(error.contains(expected), "{value}: {error}");
        }
    }

    #[test]
    fn retail_minimum_module_depends_on_resolution() {
        let dots_per_mm = |dpi: f64| dpi / 25.4;
        assert_eq!(retail_min_module_dots("ean13", dots_per_mm(203.0)), Some(2));
        assert_eq!(retail_min_module_dots("ean13", dots_per_mm(300.0)), Some(3));
        assert_eq!(retail_min_module_dots("ean13", dots_per_mm(600.0)), Some(6));
        assert_eq!(retail_min_module_dots("upce", dots_per_mm(203.0)), Some(2));
        assert_eq!(retail_min_module_dots("code128", dots_per_mm(203.0)), None);
    }
}
