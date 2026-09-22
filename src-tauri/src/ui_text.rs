//! Presentation-only translations for native UI captions and runtime messages.
//! Keep source messages in the models/logs: changing language must not mutate data.
use regex::Regex;
use std::{collections::HashMap, sync::OnceLock};

type Translations = [String; 3];
struct Template {
    pattern: Regex,
    source: String,
    values: Translations,
    slots: Vec<usize>,
}
struct Catalog {
    exact: HashMap<String, Translations>,
    folded: HashMap<String, Translations>,
    templates: Vec<Template>,
}

fn slots() -> &'static Regex {
    static SLOTS: OnceLock<Regex> = OnceLock::new();
    SLOTS.get_or_init(|| Regex::new(r"\{(\d+)\}").unwrap())
}
fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let exact: HashMap<String, Translations> =
            serde_json::from_str(include_str!("../locales/slint.json"))
                .expect("valid native locales");
        let mut folded = HashMap::new();
        let mut templates = Vec::new();
        let mut sorted: Vec<_> = exact.iter().collect();
        sorted.sort_by_key(|(source, _)| *source);
        for (source, values) in sorted {
            folded
                .entry(source.to_lowercase())
                .or_insert_with(|| values.clone());
            if !slots().is_match(source) {
                continue;
            }
            let mut pattern = String::from("(?s)^");
            let mut end = 0;
            let mut indices = Vec::new();
            for capture in slots().captures_iter(source) {
                let slot = capture.get(0).unwrap();
                pattern.push_str(&regex::escape(&source[end..slot.start()]));
                pattern.push_str("(.+?)");
                indices.push(capture[1].parse().unwrap());
                end = slot.end();
            }
            pattern.push_str(&regex::escape(&source[end..]));
            pattern.push('$');
            templates.push(Template {
                pattern: Regex::new(&pattern).expect("escaped locale template"),
                source: source.clone(),
                values: values.clone(),
                slots: indices,
            });
        }
        // Specific messages win over broad forms such as "{0} из {1}".
        templates.sort_by(|a, b| {
            let literal_len = |t: &Template| slots().replace_all(&t.source, "").len();
            literal_len(b)
                .cmp(&literal_len(a))
                .then(a.source.cmp(&b.source))
        });
        Catalog {
            exact,
            folded,
            templates,
        }
    })
}

/// Call only on application-owned display fields, never product/customer/device names.
pub fn translate(language: &str, source: &str) -> String {
    let locale = match language {
        "en" => 0,
        "de" => 1,
        "uk" => 2,
        _ => return source.into(),
    };
    render(locale, source, 0)
}
fn render(locale: usize, source: &str, depth: usize) -> String {
    if depth > 5 || source.len() > 16_384 {
        return source.into();
    }
    let trimmed = source.trim();
    if trimmed != source {
        let start = source.len() - source.trim_start().len();
        let end = source.trim_end().len();
        if trimmed.is_empty() {
            return source.into();
        }
        return format!(
            "{}{}{}",
            &source[..start],
            render(locale, trimmed, depth + 1),
            &source[end..]
        );
    }
    let catalog = catalog();
    if let Some(value) = catalog.exact.get(source) {
        return value[locale].clone();
    }
    if let Some(value) = catalog.folded.get(&source.to_lowercase()) {
        return if source == source.to_uppercase() {
            value[locale].to_uppercase()
        } else {
            value[locale].clone()
        };
    }
    for template in &catalog.templates {
        let Some(captures) = template.pattern.captures(source) else {
            continue;
        };
        let mut arguments = HashMap::new();
        for (n, index) in template.slots.iter().enumerate() {
            let raw = &captures[n + 1];
            // Only nested status/error slots are messages. Product articles and profile
            // names captured by other templates must remain byte-for-byte unchanged.
            let nested = (template.source == "{0} · проверено {1}" && *index == 0)
                || (template.source.ends_with(": {0}") && *index == 0)
                || (template.source == "Операция {0}: {1}" && *index == 1)
                || (template.source == "Смена оператора: {0}" && *index == 0)
                || (template.source == "{0} · {1} · {2} мс" && *index == 0)
                || (*index == 0
                    && matches!(
                        template.source.as_str(),
                        "{0}: требуется целое число"
                            | "{0}: требуется число"
                            | "{0} должен быть больше 0.010 кг"
                            | "{0} содержит недопустимые символы"
                            | "{0} завершилось с ошибкой"
                    ));
            arguments.insert(
                *index,
                if nested {
                    render(locale, raw, depth + 1)
                } else {
                    raw.into()
                },
            );
        }
        return slots()
            .replace_all(&template.values[locale], |c: &regex::Captures<'_>| {
                arguments
                    .get(&c[1].parse::<usize>().unwrap())
                    .cloned()
                    .unwrap_or_else(|| c[0].into())
            })
            .into_owned();
    }
    if let Some(localized) = os_error(locale, source) {
        return localized;
    }
    // Runtime summaries join independent captions with a middle dot; numbers, dates
    // and unknown technical details are retained, not machine-translated or hidden.
    if source.contains(" · ") {
        return source
            .split(" · ")
            .map(|s| render(locale, s, depth + 1))
            .collect::<Vec<_>>()
            .join(" · ");
    }
    source.into()
}
fn os_error(locale: usize, source: &str) -> Option<String> {
    static OS_ERROR: OnceLock<Regex> = OnceLock::new();
    let re =
        OS_ERROR.get_or_init(|| Regex::new(r"(?s)^(.*: )[^:\n]*\(os error (\d+)\)(.*)$").unwrap());
    let c = re.captures(source)?;
    let message = match &c[2] {
        "10061" => "Соединение отклонено",
        "10060" => "Время ожидания соединения истекло",
        "10054" => "Соединение сброшено",
        "5" => "Доступ запрещён",
        "2" => "Файл не найден",
        _ => return None,
    };
    Some(format!(
        "{}{} (os error {}){}",
        &c[1],
        catalog().exact[message][locale],
        &c[2],
        &c[3]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screenshot_regressions() {
        for (source, de) in [
            ("ПЕЧАТЬ ЭТИКЕТКИ", "ETIKETT DRUCKEN"),
            (
                "Товар готов · установите упаковку на весы",
                "Artikel bereit · Verpackung auf die Waage stellen",
            ),
            (
                "424 заданий · обновлено 08:12:14",
                "424 Aufträge · aktualisiert 08:12:14",
            ),
            (
                "Системные устройства обновлены · 08:11:37",
                "Systemgeräte aktualisiert · 08:11:37",
            ),
            (
                "Связь установлена · проверено 08:11:13",
                "Verbindung hergestellt · geprüft 08:11:13",
            ),
            ("1 · без лимита", "1 · unbegrenzt"),
            ("1 мин назад", "vor 1 Min."),
            ("23 ч назад", "vor 23 Std."),
            ("НЕЯСНО", "UNKLAR"),
            ("Октябрь 2026", "Oktober 2026"),
            (
                "TCP-порт: требуется целое число",
                "TCP-Port: Ganzzahl erforderlich",
            ),
            (
                "Установлена актуальная версия",
                "Die aktuelle Version ist installiert",
            ),
        ] {
            assert_eq!(translate("de", source), de, "{source}");
        }
    }
    #[test]
    fn preserves_data_and_formats() {
        for value in [
            "МӘРМӘР СИЫР / СТЕЙК НЬЮ-ЙОРК",
            "Принтер цеха № 2",
            "82d76bcd-1234",
            "192.168.178.20",
            "unknown diagnostic",
        ] {
            for lang in ["ru", "en", "de", "uk"] {
                assert_eq!(translate(lang, value), value);
            }
        }
        assert_eq!(
            translate("de", "Принтер · фикс. 3.204 кг · допуск 5–10 г"),
            "Принтер · fest 3.204 kg · Toleranz 5–10 g"
        );
        assert_eq!(
            translate("de", "Профиль Принтер определён и сохранён"),
            "Profil Принтер erkannt und gespeichert"
        );
        assert_eq!(translate("ru", "1 мин назад"), "1 мин назад");
        assert_eq!(translate("de", " кг "), " kg ");
    }
    #[test]
    fn errors_keep_endpoint_code_and_unknown_details() {
        let raw = "Операция repeat: TCP printer connect 127.0.0.1:9100: Подключение не установлено, т.к. конечный компьютер отверг запрос на подключение. (os error 10061)";
        assert_eq!(translate("de", raw), "Vorgang repeat: TCP printer connect 127.0.0.1:9100: Verbindung abgelehnt (os error 10061)");
        assert_eq!(translate("ru", raw), raw);
        assert_eq!(
            translate("de", "TCP: неизвестная ошибка (os error 99999)"),
            "TCP: неизвестная ошибка (os error 99999)"
        );
        assert_eq!(
            translate("de", "Операция repeat: device ID ABC rejected"),
            "Vorgang repeat: device ID ABC rejected"
        );
    }
    #[test]
    fn catalog_has_complete_locales_and_matching_slots() {
        for (source, translations) in &catalog().exact {
            let mut expected: Vec<_> = slots().find_iter(source).map(|s| s.as_str()).collect();
            expected.sort();
            for (lang, value) in ["en", "de", "uk"].iter().zip(translations) {
                assert!(!value.trim().is_empty(), "{source}: {lang}");
                let mut actual: Vec<_> = slots().find_iter(value).map(|s| s.as_str()).collect();
                actual.sort();
                assert_eq!(actual, expected, "{source}: {lang}");
                if *lang != "uk" {
                    assert!(
                        !value
                            .chars()
                            .any(|c| ('\u{0400}'..='\u{04ff}').contains(&c)),
                        "{source}: {lang} contains Cyrillic: {value}"
                    );
                }
            }
        }
    }
}
