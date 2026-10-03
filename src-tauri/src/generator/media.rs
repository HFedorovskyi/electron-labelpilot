//! Label output (media handling, media sensor, print method) commands.
//!
//! `None` and `"printer"` keep the printer's stored setup: no command is sent,
//! so stations without these settings emit exactly the bytes they emitted
//! before the settings existed.

pub(crate) const MEDIA_HANDLING_VALUES: [&str; 5] =
    ["printer", "tear", "peel", "cutter", "applicator"];
pub(crate) const MEDIA_SENSOR_VALUES: [&str; 4] = ["printer", "gap", "mark", "continuous"];
pub(crate) const PRINT_METHOD_VALUES: [&str; 3] = ["printer", "thermal", "transfer"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MediaSettings<'a> {
    pub handling: Option<&'a str>,
    pub sensor: Option<&'a str>,
    pub method: Option<&'a str>,
}

impl<'a> MediaSettings<'a> {
    pub(crate) fn from_config(config: &'a serde_json::Map<String, serde_json::Value>) -> Self {
        let value = |key: &str| config.get(key).and_then(serde_json::Value::as_str);
        Self {
            handling: value("mediaHandling"),
            sensor: value("mediaSensor"),
            method: value("printMethod"),
        }
    }

    /// ZPL format commands placed right after `^XA`.
    pub(crate) fn zpl_commands(self) -> String {
        let mut commands = String::new();
        commands.push_str(match self.handling {
            Some("tear") => "^MMT\n",
            Some("peel") => "^MMP\n",
            Some("cutter") => "^MMC\n",
            Some("applicator") => "^MMA\n",
            _ => "",
        });
        commands.push_str(match self.sensor {
            Some("gap") => "^MNY\n",
            Some("mark") => "^MNM\n",
            Some("continuous") => "^MNN\n",
            _ => "",
        });
        commands.push_str(match self.method {
            Some("thermal") => "^MTD\n",
            Some("transfer") => "^MTT\n",
            _ => "",
        });
        commands
    }

    /// TSPL sensor keyword for the media size line: black-mark media uses
    /// `BLINE`, gap and continuous media use `GAP`.
    pub(crate) fn tspl_sensor_keyword(self) -> &'static str {
        if self.sensor == Some("mark") {
            "BLINE"
        } else {
            "GAP"
        }
    }

    /// Continuous media has no gap; every other setup keeps the configured gap.
    pub(crate) fn tspl_gap_mm(self, configured: f64) -> f64 {
        if self.sensor == Some("continuous") {
            0.0
        } else {
            configured
        }
    }

    /// TSPL setup lines placed before `CLS`. TSPL has no applicator mode.
    pub(crate) fn tspl_commands(self) -> Vec<&'static str> {
        let mut commands = Vec::new();
        match self.handling {
            Some("tear") => commands.extend(["SET CUTTER OFF", "SET PEEL OFF", "SET TEAR ON"]),
            Some("peel") => commands.extend(["SET CUTTER OFF", "SET PEEL ON"]),
            Some("cutter") => commands.extend(["SET PEEL OFF", "SET CUTTER 1"]),
            _ => {}
        }
        match self.method {
            Some("thermal") => commands.push("SET RIBBON OFF"),
            Some("transfer") => commands.push("SET RIBBON ON"),
            _ => {}
        }
        commands
    }
}

/// Validates stored values when settings are saved and before generation, so
/// an unsupported combination never reaches a printer half-applied.
pub(crate) fn validate_media_settings(
    protocol: &str,
    settings: MediaSettings<'_>,
) -> Result<(), String> {
    for (name, value, allowed) in [
        ("mediaHandling", settings.handling, &MEDIA_HANDLING_VALUES[..]),
        ("mediaSensor", settings.sensor, &MEDIA_SENSOR_VALUES[..]),
        ("printMethod", settings.method, &PRINT_METHOD_VALUES[..]),
    ] {
        if let Some(value) = value {
            if !allowed.contains(&value) {
                return Err(format!("printer {name} must be one of {}", allowed.join(", ")));
            }
        }
    }
    let configured = |value: Option<&str>| value.is_some_and(|value| value != "printer");
    let any_configured =
        configured(settings.handling) || configured(settings.sensor) || configured(settings.method);
    if any_configured && !matches!(protocol, "zpl" | "image" | "tspl") {
        return Err("label output settings are supported for ZPL and TSPL printers".to_owned());
    }
    if settings.handling == Some("applicator") && protocol == "tspl" {
        return Err("applicator mode is supported for ZPL printers only".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(
        handling: Option<&'static str>,
        sensor: Option<&'static str>,
        method: Option<&'static str>,
    ) -> MediaSettings<'static> {
        MediaSettings {
            handling,
            sensor,
            method,
        }
    }

    #[test]
    fn printer_defaults_emit_no_commands() {
        let none = MediaSettings::default();
        assert_eq!(none.zpl_commands(), "");
        assert!(none.tspl_commands().is_empty());
        assert_eq!(none.tspl_sensor_keyword(), "GAP");
        assert_eq!(none.tspl_gap_mm(2.0), 2.0);
        let printer = settings(Some("printer"), Some("printer"), Some("printer"));
        assert_eq!(printer.zpl_commands(), "");
        assert!(printer.tspl_commands().is_empty());
    }

    #[test]
    fn zpl_commands_cover_every_mode() {
        assert_eq!(
            settings(Some("peel"), Some("mark"), Some("transfer")).zpl_commands(),
            "^MMP\n^MNM\n^MTT\n"
        );
        assert_eq!(
            settings(Some("applicator"), Some("continuous"), Some("thermal")).zpl_commands(),
            "^MMA\n^MNN\n^MTD\n"
        );
        assert_eq!(settings(Some("tear"), Some("gap"), None).zpl_commands(), "^MMT\n^MNY\n");
        assert_eq!(settings(Some("cutter"), None, None).zpl_commands(), "^MMC\n");
    }

    #[test]
    fn tspl_commands_cover_every_mode() {
        let peel = settings(Some("peel"), Some("mark"), Some("thermal"));
        assert_eq!(peel.tspl_commands(), ["SET CUTTER OFF", "SET PEEL ON", "SET RIBBON OFF"]);
        assert_eq!(peel.tspl_sensor_keyword(), "BLINE");
        let cutter = settings(Some("cutter"), Some("continuous"), Some("transfer"));
        assert_eq!(cutter.tspl_commands(), ["SET PEEL OFF", "SET CUTTER 1", "SET RIBBON ON"]);
        assert_eq!(cutter.tspl_gap_mm(3.0), 0.0);
        assert_eq!(
            settings(Some("tear"), None, None).tspl_commands(),
            ["SET CUTTER OFF", "SET PEEL OFF", "SET TEAR ON"]
        );
    }

    #[test]
    fn validation_rejects_unknown_values_and_unsupported_protocols() {
        assert!(validate_media_settings("zpl", settings(Some("applicator"), None, None)).is_ok());
        assert!(validate_media_settings("tspl", settings(Some("applicator"), None, None)).is_err());
        assert!(validate_media_settings("zpl", settings(Some("rewind"), None, None)).is_err());
        assert!(validate_media_settings("dpl", settings(None, Some("mark"), None)).is_err());
        assert!(validate_media_settings("dpl", settings(Some("printer"), None, None)).is_ok());
        assert!(validate_media_settings("epl", MediaSettings::default()).is_ok());
    }
}
