use serde_json::{json, Value};
use std::{
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UiRuntime {
    Tauri,
    Slint,
}

impl UiRuntime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tauri => "tauri",
            Self::Slint => "slint",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "tauri" | "webview" | "webview2" => Ok(Self::Tauri),
            "slint" | "native" | "native-ui" => Ok(Self::Slint),
            value => Err(format!(
                "unsupported UI runtime '{value}'; expected 'tauri' or 'slint'"
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectionSource {
    Default,
    Environment,
    CommandLine,
}

impl SelectionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Environment => "environment",
            Self::CommandLine => "command-line",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSelection {
    pub runtime: UiRuntime,
    pub source: SelectionSource,
    pub fallback_enabled: bool,
}

impl RuntimeSelection {
    pub fn tauri_default() -> Self {
        Self {
            runtime: UiRuntime::Tauri,
            source: SelectionSource::Default,
            fallback_enabled: true,
        }
    }

    pub fn probe_json(&self) -> Value {
        json!({
            "selectedRuntime": self.runtime.as_str(),
            "selectionSource": self.source.as_str(),
            "fallbackEnabled": self.fallback_enabled,
            "slintCompiled": cfg!(feature = "slint-ui"),
            "slintSidecarAvailable": slint_sidecar_path().is_some(),
            "tauriCompiled": cfg!(feature = "desktop"),
        })
    }
}

fn parse_boolean(name: &str, value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "{name} must be one of: 1, 0, true, false, yes, no, on, off"
        )),
    }
}

pub fn select_current() -> Result<RuntimeSelection, String> {
    select_from(
        env::args_os().skip(1),
        env::var("LABELPILOT_UI_RUNTIME").ok().as_deref(),
        env::var("LABELPILOT_UI_FALLBACK").ok().as_deref(),
    )
}

pub fn select_from<I, S>(
    arguments: I,
    environment_runtime: Option<&str>,
    environment_fallback: Option<&str>,
) -> Result<RuntimeSelection, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut runtime = match environment_runtime {
        Some(value) => (UiRuntime::parse(value)?, SelectionSource::Environment),
        None => (UiRuntime::Tauri, SelectionSource::Default),
    };
    let mut fallback_enabled = match environment_fallback {
        Some(value) => parse_boolean("LABELPILOT_UI_FALLBACK", value)?,
        None => true,
    };
    let arguments: Vec<String> = arguments
        .into_iter()
        .map(|value| value.into().to_string_lossy().into_owned())
        .collect();
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if let Some(value) = argument.strip_prefix("--ui-runtime=") {
            runtime = (UiRuntime::parse(value)?, SelectionSource::CommandLine);
        } else if argument == "--ui-runtime" {
            index += 1;
            let value = arguments
                .get(index)
                .ok_or_else(|| "--ui-runtime requires 'tauri' or 'slint'".to_owned())?;
            runtime = (UiRuntime::parse(value)?, SelectionSource::CommandLine);
        } else if argument == "--slint-ui" {
            runtime = (UiRuntime::Slint, SelectionSource::CommandLine);
        } else if argument == "--tauri-ui" {
            runtime = (UiRuntime::Tauri, SelectionSource::CommandLine);
        } else if argument == "--no-ui-fallback" {
            fallback_enabled = false;
        } else if argument == "--ui-fallback" {
            fallback_enabled = true;
        }
        index += 1;
    }
    Ok(RuntimeSelection {
        runtime: runtime.0,
        source: runtime.1,
        fallback_enabled,
    })
}

pub fn slint_sidecar_path() -> Option<PathBuf> {
    if let Some(override_path) = env::var_os("LABELPILOT_SLINT_EXECUTABLE")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
    {
        return override_path.is_file().then_some(override_path);
    }

    let current_executable = env::current_exe().ok()?;
    if current_executable
        .file_stem()
        .is_some_and(|name| name.eq_ignore_ascii_case("labelpilot-slint"))
    {
        return Some(current_executable);
    }
    let candidate = current_executable
        .parent()?
        .join(format!("labelpilot-slint{}", env::consts::EXE_SUFFIX));
    candidate.is_file().then_some(candidate)
}
pub fn runtime_probe_path() -> Option<PathBuf> {
    for argument in env::args_os().skip(1) {
        let argument = argument.to_string_lossy();
        if let Some(path) = argument.strip_prefix("--runtime-probe=") {
            if !path.trim().is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    env::var_os("LABELPILOT_RUNTIME_PROBE_PATH")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

pub fn write_probe(path: &Path, selection: &RuntimeSelection) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create runtime probe directory: {error}"))?;
    }
    let document = serde_json::to_vec_pretty(&selection.probe_json())
        .map_err(|error| format!("serialize runtime probe: {error}"))?;
    fs::write(path, document).map_err(|error| format!("write runtime probe: {error}"))
}

pub fn append_runtime_log(message: &str) {
    let Some(root) = env::var_os("APPDATA").map(PathBuf::from) else {
        return;
    };
    let directory = root.join("electron-labelpilot").join("logs");
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("runtime-selector.log"))
    {
        let normalized = message.replace(['\r', '\n'], " ");
        let _ = writeln!(file, "{timestamp} {normalized}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_tauri_with_fallback() {
        let selected = select_from(Vec::<String>::new(), None, None).unwrap();
        assert_eq!(selected, RuntimeSelection::tauri_default());
    }

    #[test]
    fn environment_selects_slint() {
        let selected = select_from(Vec::<String>::new(), Some("native"), Some("0")).unwrap();
        assert_eq!(selected.runtime, UiRuntime::Slint);
        assert_eq!(selected.source, SelectionSource::Environment);
        assert!(!selected.fallback_enabled);
    }

    #[test]
    fn command_line_overrides_environment() {
        let selected = select_from(
            ["--ui-runtime", "tauri", "--ui-fallback"],
            Some("slint"),
            Some("false"),
        )
        .unwrap();
        assert_eq!(selected.runtime, UiRuntime::Tauri);
        assert_eq!(selected.source, SelectionSource::CommandLine);
        assert!(selected.fallback_enabled);
    }

    #[test]
    fn aliases_and_no_fallback_are_supported() {
        let selected = select_from(["--slint-ui", "--no-ui-fallback"], None, None).unwrap();
        assert_eq!(selected.runtime, UiRuntime::Slint);
        assert!(!selected.fallback_enabled);
    }

    #[test]
    fn invalid_runtime_is_reported() {
        let error = select_from(["--ui-runtime=unknown"], None, None).unwrap_err();
        assert!(error.contains("unsupported UI runtime"));
    }
}
