use crate::{
    native_ui::{
        Event as CoreEvent, NativeCatalogSnapshot, NativeFixedBatchOutcome,
        NativeFixedWeightSnapshot, NativeJobPrintOutcome, NativeLicenseStatus,
        NativePrintJobsSnapshot, NativePrinterCapability, NativePrinterDiagnostic,
        NativePrinterQueueSnapshot, NativePrinterRoleSettings, NativePrinterRoleSettingsInput,
        NativePrinterSettingsSnapshot, NativeProductionPrintJob, NativeScaleSettingsInput,
        NativeScaleSettingsSnapshot, NativeServerLicenseSnapshot, NativeUiOperator,
        NativeUiProduct, NativeUiRevision, NativeUiRuntime, NativeWeighingSnapshot,
    },
    native_update::{NativeUpdateManager, NativeUpdateSnapshot},
    persisted::PersistedState,
    runtime_selector::append_runtime_log,
};
use serde_json::{json, Value};
use slint::{ModelRc, VecModel};
use std::{
    cell::{Cell, RefCell},
    env,
    path::PathBuf,
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, TryRecvError},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

slint::include_modules!();

const CATALOG_PAGE_SIZE: usize = 50;

enum UiMessage {
    Core(CoreEvent),
    Hydrated(Result<NativeWeighingSnapshot, String>),
    ProductSearchLoaded {
        generation: u64,
        outcome: Result<Vec<NativeUiProduct>, String>,
    },
    ProductionFinished {
        action: String,
        outcome: Result<crate::native_print::NativePrintOutcome, String>,
        snapshot: Box<Result<NativeWeighingSnapshot, String>>,
    },
    DeleteFinished {
        outcome: Result<i64, String>,
        snapshot: Box<Result<NativeWeighingSnapshot, String>>,
    },
    SessionFinished {
        action: String,
        outcome: Result<Value, String>,
        snapshot: Box<Result<NativeWeighingSnapshot, String>>,
    },
    WarmupFinished(Result<Value, String>),
    QueueLoaded(Result<NativePrinterQueueSnapshot, String>),
    QueueActionFinished {
        action: String,
        outcome: Result<(), String>,
        snapshot: Result<NativePrinterQueueSnapshot, String>,
    },
    DiagnosticsLoaded(Result<Vec<NativePrinterDiagnostic>, String>),
    PrinterHealthChecked(Result<NativePrinterDiagnostic, String>),
    PrinterSettingsLoaded(Result<NativePrinterSettingsSnapshot, String>),
    PrinterSettingsSaved(Result<NativePrinterSettingsSnapshot, String>),
    PrinterSettingsDetected {
        outcome: Result<NativePrinterCapability, String>,
        snapshot: Option<Result<NativePrinterSettingsSnapshot, String>>,
    },
    PrinterSettingsTested(Result<Value, String>),
    ScaleSettingsLoaded(Result<NativeScaleSettingsSnapshot, String>),
    ScaleSettingsSaved(Result<NativeScaleSettingsSnapshot, String>),
    ScaleSettingsTested(Result<crate::scale::ScaleProbeResult, String>),
    FixedWeightLoaded(Result<NativeFixedWeightSnapshot, String>),
    FixedWeightPrinted {
        automatic: bool,
        outcome: Result<crate::native_print::NativePrintOutcome, String>,
        snapshot: Result<NativeFixedWeightSnapshot, String>,
    },
    FixedBatchFinished {
        outcome: Result<NativeFixedBatchOutcome, String>,
        snapshot: Result<NativeFixedWeightSnapshot, String>,
    },
    CatalogLoaded(Result<NativeCatalogSnapshot, String>),
    ServerLicenseLoaded(Result<NativeServerLicenseSnapshot, String>),
    ServerAddressSaved(Result<NativeServerLicenseSnapshot, String>),
    UpdateProgress {
        downloaded: u64,
        total: u64,
    },
    UpdateFinished {
        action: String,
        result: Result<NativeUpdateSnapshot, String>,
    },
    ProductionJobsLoaded(Box<Result<NativePrintJobsSnapshot, String>>),
    ProductionJobPrinted {
        outcome: Result<NativeJobPrintOutcome, String>,
        snapshot: Box<Result<NativePrintJobsSnapshot, String>>,
    },
    ProductionJobActionFinished {
        action: String,
        outcome: Result<Value, String>,
        snapshot: Box<Result<NativePrintJobsSnapshot, String>>,
    },
    RuntimeRefreshed {
        revision: Option<NativeUiRevision>,
        data_changed: bool,
        printer_changed: bool,
        snapshot: Option<Result<NativeWeighingSnapshot, String>>,
        printer_config: Option<Result<Value, String>>,
        warmup: Option<Result<Value, String>>,
    },
}

#[derive(Debug, Default)]
struct RefreshCoordinator {
    inflight: bool,
    pending_data: bool,
    pending_printer: bool,
}

impl RefreshCoordinator {
    fn request(&mut self, data: bool, printer: bool) -> Option<(bool, bool)> {
        if !data && !printer {
            return None;
        }
        if self.inflight {
            self.pending_data |= data;
            self.pending_printer |= printer;
            return None;
        }
        self.inflight = true;
        Some((data, printer))
    }

    fn complete(&mut self) -> Option<(bool, bool)> {
        self.inflight = false;
        if !self.pending_data && !self.pending_printer {
            return None;
        }
        let pending = (self.pending_data, self.pending_printer);
        self.pending_data = false;
        self.pending_printer = false;
        Some(pending)
    }
}

#[derive(Debug, Default)]
struct RefreshGate {
    inflight: bool,
    pending: bool,
}

impl RefreshGate {
    fn request(&mut self) -> bool {
        if self.inflight {
            self.pending = true;
            return false;
        }
        self.inflight = true;
        true
    }

    fn complete(&mut self) -> bool {
        self.inflight = false;
        std::mem::take(&mut self.pending)
    }
}

fn direct_refresh_flags(event: &CoreEvent) -> Option<(bool, bool)> {
    match event {
        CoreEvent::Event { name, .. }
            if matches!(name.as_str(), "data-updated" | "print-jobs-updated") =>
        {
            Some((true, false))
        }
        CoreEvent::Event { name, .. } if name == "printer-config-updated" => Some((false, true)),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AutoPrintDecision {
    None,
    Rearmed,
    Fire,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AutoPrintTarget {
    ProductionPack(i64),
    FixedWeightPack(i64),
}

#[allow(clippy::too_many_arguments)]
fn select_auto_print_target(
    active_page: i32,
    production_product_id: Option<i64>,
    production_has_template: bool,
    fixed_product_id: Option<i64>,
    fixed_has_template: bool,
    fixed_control_in_range: bool,
    fixed_verify_mode: bool,
    fixed_busy: bool,
    printer_ready: bool,
) -> Option<AutoPrintTarget> {
    match active_page {
        0 => production_product_id
            .filter(|_| production_has_template)
            .map(AutoPrintTarget::ProductionPack),
        5 if fixed_has_template
            && fixed_control_in_range
            && fixed_verify_mode
            && !fixed_busy
            && printer_ready =>
        {
            fixed_product_id.map(AutoPrintTarget::FixedWeightPack)
        }
        _ => None,
    }
}

#[derive(Debug, Default)]
struct AutoPrintGate {
    enabled: bool,
    ready: bool,
    fired: bool,
    printing: bool,
    /// Set when an auto attempt failed; blocks further fires until the
    /// operator actually clears the scale, so a dead printer cannot loop
    /// failed packs and error alerts while the product sits on the scale.
    failed: bool,
    below_since: Option<Instant>,
    rearm_hold: Duration,
}

/// A single zero frame between stable readings (serial/TCP glitch or reconnect)
/// must not rearm the gate; the scale has to read empty for this long.
const REARM_HOLD: Duration = Duration::from_millis(1_500);

impl AutoPrintGate {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            rearm_hold: REARM_HOLD,
            ..Self::default()
        }
    }

    fn mark_ready(&mut self) {
        self.ready = true;
    }

    fn mark_failed(&mut self) {
        self.failed = self.enabled;
    }

    fn set_enabled(&mut self, enabled: bool, current_weight_kg: f64) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        self.fired = enabled && current_weight_kg > 0.010;
        if enabled {
            // A gate enabled after startup has no readiness timer. It is safe
            // to arm now: an item already on the scale is latched as fired.
            self.ready = true;
        } else {
            self.printing = false;
            self.failed = false;
            self.below_since = None;
        }
    }

    fn begin_manual_print(&mut self, weight_kg: f64) -> bool {
        if self.printing {
            return false;
        }
        self.printing = true;
        if self.enabled && weight_kg > 0.010 {
            self.fired = true;
        }
        true
    }

    fn finish_print(&mut self) {
        self.printing = false;
    }

    fn observe(&mut self, weight_kg: f64, stable: bool, printable: bool) -> AutoPrintDecision {
        if weight_kg < 0.010 {
            let now = Instant::now();
            let below_since = *self.below_since.get_or_insert(now);
            let was_blocked = self.fired || self.failed;
            if now.duration_since(below_since) < self.rearm_hold {
                return AutoPrintDecision::None;
            }
            self.fired = false;
            self.failed = false;
            return if was_blocked {
                AutoPrintDecision::Rearmed
            } else {
                AutoPrintDecision::None
            };
        }
        self.below_since = None;
        if weight_kg <= 0.010
            || !self.enabled
            || !self.ready
            || !stable
            || !printable
            || self.fired
            || self.failed
            || self.printing
        {
            return AutoPrintDecision::None;
        }
        self.fired = true;
        self.printing = true;
        AutoPrintDecision::Fire
    }
}
fn show_toast(ui: &WeighingPrototype, message: &str) {
    ui.set_toast_text(message.into());
    ui.set_toast_visible(true);
    let weak = ui.as_weak();
    slint::Timer::single_shot(Duration::from_millis(1_800), move || {
        if let Some(ui) = weak.upgrade() {
            ui.set_toast_visible(false);
        }
    });
}

fn show_alert(ui: &WeighingPrototype, message: &str) {
    ui.set_alert_text(message.into());
    ui.set_alert_visible(true);
}

fn has_argument(argument: &str) -> bool {
    env::args_os().any(|value| value == argument)
}

fn native_runtime_enabled() -> bool {
    !has_argument("--slint-ui-only")
        && env::var_os("LABELPILOT_SLINT_UI_ONLY").is_none()
        && env::var_os("LABELPILOT_SLINT_SELF_TEST").is_none()
}

fn live_weight_enabled() -> bool {
    has_argument("--live-weight") || env::var_os("LABELPILOT_SLINT_LIVE_WEIGHT").is_some()
}

fn normalized_ui_language(language: Option<&str>) -> &'static str {
    match language {
        Some("en") => "en",
        Some("de") => "de",
        Some("uk") => "uk",
        _ => "ru",
    }
}

const TOUCH_SEARCH_MAX_CHARS: usize = 96;
const FIXED_COPIES_MAX: i64 = 5_000;
const PRODUCT_SEARCH_DEBOUNCE: Duration = Duration::from_millis(70);

fn edit_touch_text(current: &str, key: &str, uppercase: bool) -> String {
    let mut result = current
        .chars()
        .take(TOUCH_SEARCH_MAX_CHARS)
        .collect::<String>();
    match key {
        "__BACKSPACE__" => {
            result.pop();
            result
        }
        "__CLEAR__" => String::new(),
        _ => {
            let key = if uppercase {
                key.to_uppercase()
            } else {
                key.to_lowercase()
            };
            let remaining = TOUCH_SEARCH_MAX_CHARS.saturating_sub(result.chars().count());
            result.extend(key.chars().take(remaining));
            result
        }
    }
}

fn edit_fixed_copies(current: &str, key: &str) -> String {
    let mut digits = current
        .chars()
        .filter(char::is_ascii_digit)
        .take(4)
        .collect::<String>();
    match key {
        "__BACKSPACE__" => {
            digits.pop();
            digits
        }
        "__CLEAR__" => String::new(),
        digit if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() => {
            if digits.is_empty() && digit == "0" {
                return digits;
            }
            if digits.len() >= 4 {
                return digits;
            }
            let mut candidate = digits.clone();
            candidate.push_str(digit);
            match candidate.parse::<i64>() {
                Ok(value) if (1..=FIXED_COPIES_MAX).contains(&value) => candidate,
                _ => digits,
            }
        }
        _ => digits,
    }
}

fn step_fixed_copies(current: &str, delta: i32) -> String {
    let current = current
        .trim()
        .parse::<i64>()
        .unwrap_or(1)
        .clamp(1, FIXED_COPIES_MAX);
    current
        .saturating_add(i64::from(delta).clamp(-100, 100))
        .clamp(1, FIXED_COPIES_MAX)
        .to_string()
}
#[cfg(test)]
mod touch_keyboard_tests {
    use super::{
        edit_fixed_copies, edit_touch_text, step_fixed_copies, FIXED_COPIES_MAX,
        TOUCH_SEARCH_MAX_CHARS,
    };

    #[test]
    fn edits_unicode_text_without_splitting_characters() {
        assert_eq!(edit_touch_text("мрамор", "Ә", false), "мраморә");
        assert_eq!(edit_touch_text("мраморә", "__BACKSPACE__", false), "мрамор");
        assert_eq!(edit_touch_text("abc", "Q", false), "abcq");
        assert_eq!(edit_touch_text("abc", "q", true), "abcQ");
        assert_eq!(edit_touch_text("abc", "__CLEAR__", false), "");
    }

    #[test]
    fn bounds_touch_search_input() {
        let full = "я".repeat(TOUCH_SEARCH_MAX_CHARS);
        assert_eq!(edit_touch_text(&full, "Ю", true), full);
        assert_eq!(
            edit_touch_text(
                &"x".repeat(TOUCH_SEARCH_MAX_CHARS + 8),
                "__BACKSPACE__",
                false
            )
            .chars()
            .count(),
            TOUCH_SEARCH_MAX_CHARS - 1
        );
    }

    #[test]
    fn edits_touch_quantity_with_production_bounds() {
        assert_eq!(edit_fixed_copies("", "0"), "");
        assert_eq!(edit_fixed_copies("", "5"), "5");
        assert_eq!(edit_fixed_copies("5", "0"), "50");
        assert_eq!(edit_fixed_copies("500", "0"), "5000");
        assert_eq!(edit_fixed_copies("5000", "1"), "5000");
        assert_eq!(edit_fixed_copies("4999", "9"), "4999");
        assert_eq!(edit_fixed_copies("50", "__BACKSPACE__"), "5");
        assert_eq!(edit_fixed_copies("50", "__CLEAR__"), "");
        assert_eq!(step_fixed_copies("1", -1), "1");
        assert_eq!(step_fixed_copies("25", 1), "26");
        assert_eq!(step_fixed_copies("5000", 1), FIXED_COPIES_MAX.to_string());
    }
}
#[cfg(test)]
mod ui_language_tests {
    use super::normalized_ui_language;

    #[test]
    fn supports_all_four_client_locales_with_russian_fallback() {
        assert_eq!(normalized_ui_language(Some("ru")), "ru");
        assert_eq!(normalized_ui_language(Some("en")), "en");
        assert_eq!(normalized_ui_language(Some("de")), "de");
        assert_eq!(normalized_ui_language(Some("uk")), "uk");
        assert_eq!(normalized_ui_language(Some("fr")), "ru");
        assert_eq!(normalized_ui_language(None), "ru");
    }
}

fn scale_config() -> Value {
    match (
        env::var("LABELPILOT_SCALE_HOST").ok(),
        env::var("LABELPILOT_SCALE_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok()),
    ) {
        (Some(host), Some(port)) => json!({
            "type": "tcp",
            "protocolId": env::var("LABELPILOT_SCALE_PROTOCOL")
                .unwrap_or_else(|_| "generic".to_owned()),
            "host": host,
            "port": port,
            "pollingInterval": 120,
            "stabilityCount": 4
        }),
        _ => json!({
            "type": "simulator",
            "protocolId": "simulator",
            "pollingInterval": 120,
            "stabilityCount": 4
        }),
    }
}

fn printer_config() -> Value {
    json!({
        "id": "labelpilot-pack",
        "active": true,
        "name": "Slint ZPL virtual printer",
        "connection": "tcp",
        "protocol": "zpl",
        "ip": env::var("LABELPILOT_PRINTER_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned()),
        "port": env::var("LABELPILOT_PRINTER_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(9100),
        "persistentConnection": true
    })
}

fn printer_is_configured(config: &Value) -> bool {
    let Some(config) = config.as_object() else {
        return false;
    };
    if config.get("active").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    config
        .get("connection")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || config
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
}

fn auto_print_enabled(config: &Value) -> bool {
    config
        .get("autoPrintOnStable")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn effective_pack_printer(config: &Value) -> Value {
    if env::var_os("LABELPILOT_PRINTER_HOST").is_some() {
        printer_config()
    } else {
        config.get("packPrinter").cloned().unwrap_or(Value::Null)
    }
}

fn ui_weight(ui: &WeighingPrototype) -> f64 {
    ui.get_gross_weight()
        .replace(',', ".")
        .parse::<f64>()
        .unwrap_or(0.0)
}

fn apply_refreshed_printer_config(
    ui: &WeighingPrototype,
    gate: &Rc<RefCell<AutoPrintGate>>,
    config: &Value,
) {
    let enabled = auto_print_enabled(config);
    let weight = ui_weight(ui);
    gate.borrow_mut().set_enabled(enabled, weight);
    ui.set_auto_print_enabled(enabled);
    ui.set_auto_print_status(
        if !enabled {
            ""
        } else if weight > 0.010 {
            "СНИМИТЕ ТОВАР"
        } else {
            "АВТОПЕЧАТЬ: ГОТОВА"
        }
        .into(),
    );

    let configured = printer_is_configured(&effective_pack_printer(config));
    ui.set_printer_ready(false);
    ui.set_printer_status(
        if configured {
            "Принтер: подключение"
        } else {
            "Принтер: не настроен"
        }
        .into(),
    );
}

fn apply_warmup_status(ui: &WeighingPrototype, outcome: Result<Value, String>) {
    let status = outcome.ok().and_then(|value| {
        value
            .pointer("/results/pack")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    match status.as_deref() {
        Some("ready") => {
            ui.set_printer_ready(true);
            ui.set_printer_status("Принтер: готов".into());
        }
        Some("unreachable") => {
            ui.set_printer_ready(false);
            ui.set_printer_status("Принтер: недоступен".into());
        }
        _ => {
            ui.set_printer_ready(false);
            ui.set_printer_status("Принтер: не настроен".into());
        }
    }
}

fn pack_printer_ui_state(device: &NativePrinterDiagnostic) -> (bool, &'static str) {
    if device.status == "unconfigured" {
        return (false, "Принтер: не настроен");
    }
    if !device.reachable {
        return (false, "Принтер: недоступен");
    }
    match device.status.as_str() {
        "ready" | "reachable" => (true, "Принтер: готов"),
        "printing" => (true, "Принтер: печатает"),
        "paused" => (false, "Принтер: пауза"),
        "head-open" => (false, "Принтер: открыта крышка"),
        "paper-out" => (false, "Принтер: нет бумаги"),
        "paper-jam" => (false, "Принтер: замятие"),
        "offline" | "unreachable" => (false, "Принтер: недоступен"),
        "error" => (false, "Принтер: ошибка"),
        _ => (true, "Принтер: готов"),
    }
}

fn apply_pack_printer_diagnostic(ui: &WeighingPrototype, device: &NativePrinterDiagnostic) {
    let (ready, status) = pack_printer_ui_state(device);
    ui.set_printer_ready(ready);
    ui.set_printer_status(status.into());
}

fn printer_health_poll_due(tick: u8, configured: bool, ready: bool) -> bool {
    if !configured {
        tick % 6 == 0
    } else if ready {
        tick % 3 == 0
    } else {
        true
    }
}

fn schedule_runtime_refresh(
    coordinator: &Rc<RefCell<RefreshCoordinator>>,
    runtime: &NativeUiRuntime,
    selected_id: Option<i64>,
    message_tx: &mpsc::Sender<UiMessage>,
    data_changed: bool,
    printer_changed: bool,
    revision: Option<NativeUiRevision>,
) {
    let Some((data_changed, printer_changed)) = coordinator
        .borrow_mut()
        .request(data_changed, printer_changed)
    else {
        return;
    };
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let snapshot = data_changed.then(|| runtime.weighing_snapshot(selected_id, None));
        let printer_config = printer_changed.then(|| runtime.printer_config());
        let warmup = if printer_changed {
            runtime.disconnect_printers();
            Some(runtime.warmup_production_assets())
        } else {
            None
        };
        let revision = revision.or_else(|| runtime.revision().ok());
        let _ = message_tx.send(UiMessage::RuntimeRefreshed {
            revision,
            data_changed,
            printer_changed,
            snapshot,
            printer_config,
            warmup,
        });
    });
}

fn schedule_printer_health_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::PrinterHealthChecked(
            runtime.probe_pack_printer(),
        ));
    });
}

fn schedule_queue_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::QueueLoaded(runtime.printer_queue_snapshot(100)));
    });
}

fn schedule_diagnostics_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::DiagnosticsLoaded(
            runtime.probe_configured_printers(),
        ));
    });
}

fn schedule_printer_settings_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::PrinterSettingsLoaded(
            runtime.printer_settings_snapshot(),
        ));
    });
}

fn schedule_scale_settings_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::ScaleSettingsLoaded(
            runtime.scale_settings_snapshot(),
        ));
    });
}

fn schedule_fixed_weight_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
    selected_product_id: Option<i64>,
    search: Option<String>,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::FixedWeightLoaded(
            runtime.fixed_weight_snapshot(selected_product_id, search.as_deref()),
        ));
    });
}

fn schedule_production_jobs_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
    selected_job_id: Option<i64>,
    completed: bool,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::ProductionJobsLoaded(Box::new(
            runtime
                .production_print_jobs_snapshot(selected_job_id, completed.then_some("completed")),
        )));
    });
}

fn schedule_catalog_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
    selected_product_id: Option<i64>,
    search: Option<String>,
    limit: usize,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::CatalogLoaded(
            runtime.catalog_snapshot_with_limit(selected_product_id, search.as_deref(), limit),
        ));
    });
}

fn schedule_server_license_refresh(
    gate: &Rc<RefCell<RefreshGate>>,
    runtime: &NativeUiRuntime,
    message_tx: &mpsc::Sender<UiMessage>,
) {
    if !gate.borrow_mut().request() {
        return;
    }
    let runtime = runtime.clone();
    let message_tx = message_tx.clone();
    thread::spawn(move || {
        let _ = message_tx.send(UiMessage::ServerLicenseLoaded(
            runtime.server_license_snapshot(),
        ));
    });
}
fn clamp_u64(value: u64) -> i32 {
    value.min(i32::MAX as u64) as i32
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut result = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn relative_age(timestamp_ms: i64) -> String {
    if timestamp_ms <= 0 {
        return "нет данных".to_owned();
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let seconds = now_ms.saturating_sub(timestamp_ms).max(0) / 1_000;
    match seconds {
        0..=9 => "только что".to_owned(),
        10..=59 => format!("{seconds} сек назад"),
        60..=3_599 => format!("{} мин назад", seconds / 60),
        3_600..=86_399 => format!("{} ч назад", seconds / 3_600),
        _ => format!("{} дн назад", seconds / 86_400),
    }
}

fn queue_state_label(state: &str) -> &'static str {
    match state {
        "queued" => "ОЖИДАЕТ",
        "rendering" => "РЕНДЕРИНГ",
        "sending" => "ОТПРАВКА",
        "accepted" => "ПРИНЯТО",
        "uncertain" => "НЕЯСНО",
        "failed" => "ОШИБКА",
        "cancelled" => "ОТМЕНЕНО",
        _ => "НЕИЗВЕСТНО",
    }
}

fn queue_action_label(action: &str) -> &'static str {
    match action {
        "raw" => "Этикетка",
        "driver-bitmap" => "Растровая этикетка",
        "driver-page" => "Паллетный лист",
        _ => "Задание печати",
    }
}

fn payload_label(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn queue_rows(snapshot: &NativePrinterQueueSnapshot) -> Vec<PrintQueueRow> {
    snapshot
        .jobs
        .iter()
        .map(|job| {
            let state = job.state.as_str();
            PrintQueueRow {
                job_id: job.job_id.clone().into(),
                short_id: job.job_id.chars().take(8).collect::<String>().into(),
                state: job.state.clone().into(),
                state_label: queue_state_label(state).into(),
                printer_name: if job.printer_name.trim().is_empty() {
                    job.printer_id.clone().into()
                } else {
                    job.printer_name.clone().into()
                },
                route: format!(
                    "{} / {}",
                    job.protocol.to_uppercase(),
                    job.connection.to_uppercase()
                )
                .into(),
                action: queue_action_label(&job.action_kind).into(),
                payload: payload_label(job.payload_bytes).into(),
                attempts: clamp_u64(job.attempt_count),
                updated: relative_age(job.updated_at_ms).into(),
                error: job
                    .last_error
                    .as_deref()
                    .map(|value| bounded_text(value, 180))
                    .unwrap_or_default()
                    .into(),
                can_retry: matches!(state, "failed" | "uncertain" | "cancelled"),
                can_cancel: matches!(state, "queued" | "failed" | "uncertain"),
                uncertain: state == "uncertain",
                good: state == "accepted",
                warning: state == "uncertain",
            }
        })
        .collect()
}

fn apply_queue_snapshot(ui: &WeighingPrototype, snapshot: NativePrinterQueueSnapshot) {
    let summary = &snapshot.summary;
    ui.set_queue_waiting(clamp_u64(
        summary.queued + summary.rendering + summary.sending,
    ));
    ui.set_queue_accepted(clamp_u64(summary.accepted));
    ui.set_queue_problems(clamp_u64(summary.uncertain + summary.failed));
    ui.set_queue_total(clamp_u64(summary.total));
    ui.set_durable_jobs(ModelRc::new(VecModel::from(queue_rows(&snapshot))));
    ui.set_queue_status(
        format!(
            "{} заданий · обновлено {}",
            summary.total,
            chrono_like_time()
        )
        .into(),
    );
}

fn diagnostic_status_label(status: &str) -> &'static str {
    match status {
        "ready" => "ГОТОВ",
        "printing" => "ПЕЧАТЬ",
        "paused" => "ПАУЗА",
        "offline" => "ОФЛАЙН",
        "head-open" => "КРЫШКА ОТКРЫТА",
        "paper-out" => "НЕТ БУМАГИ",
        "paper-jam" => "ЗАМЯТИЕ",
        "unconfigured" => "НЕ НАСТРОЕН",
        "error" | "unreachable" => "НЕДОСТУПЕН",
        _ => "ОТВЕТ ПОЛУЧЕН",
    }
}

fn diagnostic_rows(devices: &[NativePrinterDiagnostic]) -> Vec<PrinterDiagnosticRow> {
    devices
        .iter()
        .map(|device| PrinterDiagnosticRow {
            role: device.role.clone().into(),
            role_label: device.role_label.clone().into(),
            printer_name: device.printer_name.clone().into(),
            endpoint: bounded_text(&device.endpoint, 120).into(),
            transport: format!(
                "{} / {}",
                device.protocol.to_uppercase(),
                device.connection.to_uppercase()
            )
            .into(),
            status: device.status.clone().into(),
            status_label: diagnostic_status_label(&device.status).into(),
            details: bounded_text(&device.details, 220).into(),
            reachable: device.reachable,
            configured: device.status != "unconfigured",
            queried: if device.queried_at_ms == 0 {
                "не проверялся".into()
            } else {
                relative_age(device.queried_at_ms.min(i64::MAX as u64) as i64).into()
            },
        })
        .collect()
}

fn apply_diagnostics(ui: &WeighingPrototype, devices: Vec<NativePrinterDiagnostic>) {
    let reachable = devices.iter().filter(|device| device.reachable).count();
    let configured = devices
        .iter()
        .filter(|device| device.status != "unconfigured")
        .count();
    ui.set_printer_diagnostics(ModelRc::new(VecModel::from(diagnostic_rows(&devices))));
    ui.set_diagnostics_status(
        format!(
            "Доступно {reachable} из {configured} настроенных · {}",
            chrono_like_time()
        )
        .into(),
    );
}

fn settings_role_rows(snapshot: &NativePrinterSettingsSnapshot) -> Vec<PrinterSettingsRoleRow> {
    snapshot
        .roles
        .iter()
        .map(|role| PrinterSettingsRoleRow {
            role: role.role.clone().into(),
            role_label: role.role_label.clone().into(),
            description: role.description.clone().into(),
            active: role.active,
            name: role.name.clone().into(),
            endpoint: bounded_text(&role.endpoint, 90).into(),
            connection: match role.connection.as_str() {
                "tcp" => "Ethernet".into(),
                "serial" => "Serial".into(),
                _ => "Driver".into(),
            },
            protocol: if role.protocol == "image" {
                "ZPL bitmap".into()
            } else {
                role.protocol.to_uppercase().into()
            },
            dpi: format!("{} DPI", role.dpi).into(),
            profile: role.effective_profile.clone().into(),
        })
        .collect()
}

fn settings_choice_rows(
    choices: &[crate::native_ui::NativePrinterChoice],
) -> Vec<PrinterChoiceRow> {
    choices
        .iter()
        .map(|choice| PrinterChoiceRow {
            value: choice.value.clone().into(),
            label: choice.label.clone().into(),
            details: choice.details.clone().into(),
        })
        .collect()
}

fn format_optional_setting(value: Option<f64>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if value.fract().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.2}").trim_end_matches('0').to_owned()
    }
}

fn apply_printer_role_editor(ui: &WeighingPrototype, role: &NativePrinterRoleSettings) {
    ui.set_settings_selected_role(role.role.clone().into());
    ui.set_settings_selected_role_label(role.role_label.clone().into());
    ui.set_settings_selected_description(role.description.clone().into());
    ui.set_settings_active(role.active);
    ui.set_settings_name(role.name.clone().into());
    ui.set_settings_connection(role.connection.clone().into());
    ui.set_settings_protocol(role.protocol.clone().into());
    ui.set_settings_compatibility(role.compatibility_mode.clone().into());
    ui.set_settings_effective_profile(role.effective_profile.clone().into());
    ui.set_settings_ip(role.ip.clone().into());
    ui.set_settings_port(role.port.to_string().into());
    ui.set_settings_serial_port(role.serial_port.clone().into());
    ui.set_settings_baud_rate(role.baud_rate.to_string().into());
    ui.set_settings_driver_name(role.driver_name.clone().into());
    ui.set_settings_dpi(role.dpi.to_string().into());
    ui.set_settings_ram_cache(role.ram_cache.clone().into());
    ui.set_settings_z64(role.z64);
    ui.set_settings_persistent_connection(role.persistent_connection);
    ui.set_settings_darkness(format_optional_setting(role.darkness).into());
    ui.set_settings_print_speed(format_optional_setting(role.print_speed).into());
    ui.set_settings_gap_mm(format_optional_setting(role.gap_mm).into());
    ui.set_settings_width_mm(format_optional_setting(role.width_mm).into());
    ui.set_settings_height_mm(format_optional_setting(role.height_mm).into());
    ui.set_settings_detection("".into());
    ui.set_settings_dirty(false);
}

fn apply_printer_settings_snapshot(
    ui: &WeighingPrototype,
    snapshot: NativePrinterSettingsSnapshot,
    store: &Rc<RefCell<Option<NativePrinterSettingsSnapshot>>>,
) {
    let selected = ui.get_settings_selected_role().to_string();
    let role = snapshot
        .roles
        .iter()
        .find(|role| role.role == selected)
        .or_else(|| snapshot.roles.first())
        .cloned();
    ui.set_printer_settings_roles(ModelRc::new(VecModel::from(settings_role_rows(&snapshot))));
    ui.set_settings_system_printers(ModelRc::new(VecModel::from(settings_choice_rows(
        &snapshot.system_printers,
    ))));
    ui.set_settings_serial_ports(ModelRc::new(VecModel::from(settings_choice_rows(
        &snapshot.serial_ports,
    ))));
    ui.set_settings_auto_print(snapshot.auto_print_on_stable);
    ui.set_settings_status(format!("{} · {}", snapshot.catalog_status, chrono_like_time()).into());
    if let Some(role) = role.as_ref() {
        apply_printer_role_editor(ui, role);
    }
    ui.set_settings_busy(false);
    *store.borrow_mut() = Some(snapshot);
}

fn parse_settings_i32(label: &str, value: &str) -> Result<i32, String> {
    value
        .trim()
        .parse::<i32>()
        .map_err(|_| format!("{label}: требуется целое число"))
}

fn parse_optional_settings_f64(label: &str, value: &str) -> Result<Option<f64>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    value
        .replace(',', ".")
        .parse::<f64>()
        .map(Some)
        .map_err(|_| format!("{label}: требуется число"))
}

fn printer_settings_input(
    ui: &WeighingPrototype,
) -> Result<NativePrinterRoleSettingsInput, String> {
    Ok(NativePrinterRoleSettingsInput {
        role: ui.get_settings_selected_role().to_string(),
        // A configured printer is always enabled. The operator controls only
        // automatic printing after weight stabilization.
        active: true,
        name: ui.get_settings_name().to_string(),
        connection: ui.get_settings_connection().to_string(),
        protocol: ui.get_settings_protocol().to_string(),
        compatibility_mode: ui.get_settings_compatibility().to_string(),
        ip: ui.get_settings_ip().to_string(),
        port: parse_settings_i32("TCP-порт", &ui.get_settings_port())?,
        serial_port: ui.get_settings_serial_port().to_string(),
        baud_rate: parse_settings_i32("Скорость Serial", &ui.get_settings_baud_rate())?,
        driver_name: ui.get_settings_driver_name().to_string(),
        dpi: parse_settings_i32("DPI", &ui.get_settings_dpi())?,
        ram_cache: ui.get_settings_ram_cache().to_string(),
        z64: ui.get_settings_z64(),
        persistent_connection: ui.get_settings_persistent_connection(),
        darkness: parse_optional_settings_f64("Темнота", &ui.get_settings_darkness())?,
        print_speed: parse_optional_settings_f64(
            "Скорость печати",
            &ui.get_settings_print_speed(),
        )?,
        gap_mm: parse_optional_settings_f64("Зазор", &ui.get_settings_gap_mm())?,
        width_mm: parse_optional_settings_f64("Ширина", &ui.get_settings_width_mm())?,
        height_mm: parse_optional_settings_f64("Высота", &ui.get_settings_height_mm())?,
    })
}

fn scale_protocol_rows(snapshot: &NativeScaleSettingsSnapshot) -> Vec<ScaleProtocolRow> {
    snapshot
        .protocols
        .iter()
        .map(|protocol| ScaleProtocolRow {
            id: protocol.id.clone().into(),
            name: protocol.name.clone().into(),
            description: protocol.description.clone().into(),
            polling_required: protocol.polling_required,
            default_baud_rate: protocol.default_baud_rate,
            serial_format: protocol.serial_format.clone().into(),
        })
        .collect()
}

fn apply_scale_settings_snapshot(ui: &WeighingPrototype, snapshot: NativeScaleSettingsSnapshot) {
    ui.set_scale_settings_protocols(ModelRc::new(VecModel::from(scale_protocol_rows(&snapshot))));
    ui.set_scale_settings_serial_ports(ModelRc::new(VecModel::from(settings_choice_rows(
        &snapshot.serial_ports,
    ))));
    ui.set_scale_settings_connection(snapshot.connection_type.into());
    ui.set_scale_settings_protocol(snapshot.protocol_id.into());
    ui.set_scale_settings_protocol_name(snapshot.protocol_name.into());
    ui.set_scale_settings_protocol_description(snapshot.protocol_description.into());
    ui.set_scale_settings_endpoint(snapshot.endpoint.into());
    ui.set_scale_settings_serial_path(snapshot.serial_path.into());
    ui.set_scale_settings_baud_rate(snapshot.baud_rate.to_string().into());
    ui.set_scale_settings_host(snapshot.host.into());
    ui.set_scale_settings_port(snapshot.port.to_string().into());
    ui.set_scale_settings_polling(snapshot.polling_interval.to_string().into());
    ui.set_scale_settings_stability_count(snapshot.stability_count.to_string().into());
    ui.set_scale_settings_runtime_status(snapshot.runtime_status.into());
    ui.set_scale_settings_status(
        format!("{} · {}", snapshot.catalog_status, chrono_like_time()).into(),
    );
    ui.set_scale_settings_probe("".into());
    ui.set_scale_settings_dirty(false);
    ui.set_scale_settings_busy(false);
}

fn scale_settings_input(ui: &WeighingPrototype) -> Result<NativeScaleSettingsInput, String> {
    Ok(NativeScaleSettingsInput {
        connection_type: ui.get_scale_settings_connection().to_string(),
        protocol_id: ui.get_scale_settings_protocol().to_string(),
        serial_path: ui.get_scale_settings_serial_path().to_string(),
        baud_rate: parse_settings_i32("Скорость Serial", &ui.get_scale_settings_baud_rate())?,
        host: ui.get_scale_settings_host().to_string(),
        port: parse_settings_i32("TCP-порт", &ui.get_scale_settings_port())?,
        polling_interval: parse_settings_i32("Интервал опроса", &ui.get_scale_settings_polling())?,
        stability_count: parse_settings_i32(
            "Отсчёты стабильности",
            &ui.get_scale_settings_stability_count(),
        )?,
    })
}

fn zpl_test_label(number: &str, gross_weight: &str) -> Vec<u8> {
    let barcode: String = number.chars().filter(char::is_ascii_digit).collect();
    let barcode = if barcode.is_empty() {
        "000000000001"
    } else {
        barcode.as_str()
    };
    format!(
        "^XA^CI28^PW600^LL360^LH0,0\n\
         ^FO28,24^A0N,34,34^FDLabelPilot native runtime^FS\n\
         ^FO28,78^A0N,25,25^FDPackage: {number}^FS\n\
         ^FO28,116^A0N,25,25^FDGross: {gross_weight} kg^FS\n\
         ^FO55,170^BY2,3,86^BCN,86,Y,N,N^FD{barcode}^FS\n\
         ^XZ"
    )
    .into_bytes()
}

fn clamp_i32(value: i64) -> i32 {
    i32::try_from(value).unwrap_or(if value < 0 { i32::MIN } else { i32::MAX })
}

fn format_date(date: time::Date) -> String {
    format!(
        "{:02}.{:02}.{:04}",
        date.day(),
        date.month() as u8,
        date.year()
    )
}

fn production_dates() -> (String, String) {
    let today = time::OffsetDateTime::now_utc().date();
    (
        format_date(today),
        format_date(today - time::Duration::days(1)),
    )
}

fn parse_display_date(value: &str) -> Option<time::Date> {
    let mut parts = value.trim().split('.');
    let day = parts.next()?.parse::<u8>().ok()?;
    let month = parts.next()?.parse::<u8>().ok()?;
    let year = parts.next()?.parse::<i32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()
}

fn first_day_of_month(date: time::Date) -> time::Date {
    time::Date::from_calendar_date(date.year(), date.month(), 1)
        .expect("the first day of an existing month is valid")
}

fn offset_calendar_month(date: time::Date, delta: i32) -> Option<time::Date> {
    let month_index = date.year().checked_mul(12)? + i32::from(date.month() as u8) - 1 + delta;
    let year = month_index.div_euclid(12);
    let month = u8::try_from(month_index.rem_euclid(12) + 1).ok()?;
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, 1).ok()
}

fn calendar_month_label(date: time::Date, language: &str) -> String {
    const RU: [&str; 12] = [
        "Январь",
        "Февраль",
        "Март",
        "Апрель",
        "Май",
        "Июнь",
        "Июль",
        "Август",
        "Сентябрь",
        "Октябрь",
        "Ноябрь",
        "Декабрь",
    ];
    const EN: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const DE: [&str; 12] = [
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
    ];
    const UK: [&str; 12] = [
        "Січень",
        "Лютий",
        "Березень",
        "Квітень",
        "Травень",
        "Червень",
        "Липень",
        "Серпень",
        "Вересень",
        "Жовтень",
        "Листопад",
        "Грудень",
    ];
    let names = match language {
        "en" => &EN,
        "de" => &DE,
        "uk" => &UK,
        _ => &RU,
    };
    format!(
        "{} {}",
        names[usize::from(date.month() as u8) - 1],
        date.year()
    )
}

fn calendar_day_rows(visible_month: time::Date, selected: time::Date) -> Vec<CalendarDayRow> {
    let visible_month = first_day_of_month(visible_month);
    let today = time::OffsetDateTime::now_utc().date();
    let grid_start = visible_month
        - time::Duration::days(i64::from(visible_month.weekday().number_days_from_monday()));
    (0..42)
        .map(|offset| {
            let date = grid_start + time::Duration::days(offset);
            CalendarDayRow {
                label: date.day().to_string().into(),
                date: format_date(date).into(),
                in_current_month: date.month() == visible_month.month()
                    && date.year() == visible_month.year(),
                selected: date == selected,
                today: date == today,
            }
        })
        .collect()
}

fn apply_calendar(ui: &WeighingPrototype, visible_month: time::Date) {
    let today = time::OffsetDateTime::now_utc().date();
    let selected = parse_display_date(ui.get_labeling_date().as_str()).unwrap_or(today);
    ui.set_calendar_month_label(
        calendar_month_label(visible_month, ui.get_ui_language().as_str()).into(),
    );
    ui.set_calendar_days(ModelRc::new(VecModel::from(calendar_day_rows(
        visible_month,
        selected,
    ))));
}

fn product_rows(products: &[NativeUiProduct]) -> Vec<ProductRow> {
    products
        .iter()
        .map(|product| {
            let article = if product.article.is_empty() {
                "без артикула".to_owned()
            } else {
                format!("арт. {}", product.article)
            };
            ProductRow {
                id: clamp_i32(product.id),
                name: product.name.clone().into(),
                article: product.article.clone().into(),
                details: format!("{article} · срок {} дн.", product.expiration_days).into(),
            }
        })
        .collect()
}

fn fixed_product_rows(products: &[NativeUiProduct]) -> Vec<ProductRow> {
    products
        .iter()
        .map(|product| ProductRow {
            id: clamp_i32(product.id),
            name: product.name.clone().into(),
            article: product.article.clone().into(),
            details: format!(
                "{} · фикс. {:.3} кг · допуск {:.0}–{} г",
                if product.article.is_empty() {
                    "без артикула".to_owned()
                } else {
                    format!("арт. {}", product.article)
                },
                product.fixed_weight_grams / 1_000.0,
                product.min_weight_grams.max(0.0),
                if product.max_weight_grams > 0.0 {
                    format!("{:.0}", product.max_weight_grams)
                } else {
                    "∞".to_owned()
                }
            )
            .into(),
        })
        .collect()
}

fn production_job_rows(jobs: &[NativeProductionPrintJob]) -> Vec<ProductionJobRow> {
    jobs.iter()
        .map(|job| {
            let progress = if job.quantity > 0.0 {
                (job.printed_quantity / job.quantity).clamp(0.0, 1.0) as f32
            } else {
                0.0
            };
            let format_quantity = |value: f64| {
                if job.quantity_unit == "kg" {
                    format!("{value:.3} кг")
                } else {
                    format!("{:.0} шт.", value.floor())
                }
            };
            ProductionJobRow {
                job_id: clamp_i32(job.job_id),
                product_id: clamp_i32(job.product_id),
                product_name: job.product_name.clone().into(),
                article: job.product_article.clone().into(),
                quantity: format_quantity(job.quantity).into(),
                printed: format_quantity(job.printed_quantity).into(),
                remaining: format_quantity((job.quantity - job.printed_quantity).max(0.0)).into(),
                progress,
                unit: job.quantity_unit.clone().into(),
                batch: job.batch_number.clone().into(),
                marking_date: job
                    .marking_date
                    .clone()
                    .unwrap_or_else(|| "текущая дата".to_owned())
                    .into(),
                status: job.status.clone().into(),
                status_label: match job.status.as_str() {
                    "completed" => "ЗАВЕРШЕНО",
                    "in_progress" => "В РАБОТЕ",
                    _ => "ОЖИДАЕТ",
                }
                .into(),
                completed: job.status == "completed",
            }
        })
        .collect()
}

fn set_production_counters(ui: &WeighingPrototype, counters: &crate::native_ui::NativeUiCounters) {
    ui.set_units_in_box(clamp_i32(counters.units_in_box));
    ui.set_boxes_on_pallet(clamp_i32(counters.boxes_in_pallet));
    ui.set_total_units(clamp_i32(counters.total_units));
    ui.set_pack_number(
        if counters.last_pack_number == "0" {
            "—".to_owned()
        } else {
            counters.last_pack_number.clone()
        }
        .into(),
    );
    ui.set_box_number(
        counters
            .current_box_number
            .clone()
            .unwrap_or_else(|| "—".to_owned())
            .into(),
    );
}
fn selected_fixed_product(
    products: &[NativeUiProduct],
    selected_product_id: Option<i64>,
) -> Option<NativeUiProduct> {
    selected_product_id
        .and_then(|id| products.iter().find(|product| product.id == id))
        .cloned()
}

fn weight_is_valid_for_product(
    product: Option<&NativeUiProduct>,
    weight_kg: f64,
    stable: bool,
    require_fixed: bool,
) -> bool {
    let Some(product) = product else {
        return false;
    };
    if !stable || !weight_kg.is_finite() || weight_kg <= 0.010 {
        return false;
    }
    if require_fixed && (!product.fixed_weight || product.fixed_weight_grams <= 0.0) {
        return false;
    }
    if !product.fixed_weight {
        return true;
    }
    let grams = weight_kg * 1_000.0;
    grams >= product.min_weight_grams.max(0.0)
        && (product.max_weight_grams <= 0.0 || grams <= product.max_weight_grams)
}

fn apply_selected_fixed_product(ui: &WeighingPrototype, product: Option<&NativeUiProduct>) {
    match product {
        Some(product) => {
            ui.set_fixed_selected_product_id(clamp_i32(product.id));
            ui.set_fixed_product_name(product.name.clone().into());
            ui.set_fixed_product_article(product.article.clone().into());
            ui.set_fixed_nominal_weight(
                format!("{:.3}", product.fixed_weight_grams / 1_000.0).into(),
            );
            ui.set_fixed_min_weight(format!("{:.0}", product.min_weight_grams.max(0.0)).into());
            ui.set_fixed_max_weight(
                if product.max_weight_grams > 0.0 {
                    format!("{:.0}", product.max_weight_grams)
                } else {
                    "∞".to_owned()
                }
                .into(),
            );
            ui.set_expiration_days(clamp_i32(product.expiration_days));
            ui.set_product_tare_kg((product.portion_tare_grams / 1_000.0) as f32);
            ui.set_box_limit(clamp_i32(product.close_box_counter.max(0)));
        }
        None => {
            ui.set_fixed_selected_product_id(0);
            ui.set_fixed_product_name("Нет товаров фиксированного веса".into());
            ui.set_fixed_product_article("".into());
            ui.set_fixed_nominal_weight("0.000".into());
            ui.set_fixed_min_weight("0".into());
            ui.set_fixed_max_weight("∞".into());
        }
    }
}

fn apply_fixed_weight_snapshot(
    ui: &WeighingPrototype,
    snapshot: NativeFixedWeightSnapshot,
    product_store: &Rc<RefCell<Vec<NativeUiProduct>>>,
    selected_product: &Rc<Cell<Option<i64>>>,
) {
    let selected = selected_fixed_product(&snapshot.products, snapshot.selected_product_id);
    selected_product.set(snapshot.selected_product_id);
    ui.set_fixed_products(ModelRc::new(VecModel::from(fixed_product_rows(
        &snapshot.products,
    ))));
    *product_store.borrow_mut() = snapshot.products;
    apply_selected_fixed_product(ui, selected.as_ref());
    set_production_counters(ui, &snapshot.counters);
    let weight = ui
        .get_gross_weight()
        .replace(',', ".")
        .parse::<f64>()
        .unwrap_or(0.0);
    ui.set_fixed_control_in_range(weight_is_valid_for_product(
        selected.as_ref(),
        weight,
        ui.get_stable(),
        true,
    ));
    ui.set_fixed_status(
        if selected.is_some() {
            "Товар готов · установите упаковку на весы"
        } else {
            "Товары фиксированного веса не найдены"
        }
        .into(),
    );
}

fn apply_production_jobs_snapshot(
    ui: &WeighingPrototype,
    snapshot: NativePrintJobsSnapshot,
    job_store: &Rc<RefCell<Vec<NativeProductionPrintJob>>>,
    selected_job: &Rc<Cell<Option<i64>>>,
    selected_product: &Rc<RefCell<Option<NativeUiProduct>>>,
) {
    let visible = snapshot
        .jobs
        .iter()
        .filter(|job| {
            if ui.get_production_jobs_completed() {
                job.status == "completed"
            } else {
                job.status != "completed"
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    let selected_id = snapshot
        .selected_job_id
        .filter(|id| visible.iter().any(|job| job.job_id == *id))
        .or_else(|| visible.first().map(|job| job.job_id));
    let selected = selected_id.and_then(|id| visible.iter().find(|job| job.job_id == id).cloned());
    selected_job.set(selected_id);
    ui.set_production_jobs(ModelRc::new(VecModel::from(production_job_rows(&visible))));
    *job_store.borrow_mut() = visible;

    if let Some(job) = selected.as_ref() {
        let format_quantity = |value: f64| {
            if job.quantity_unit == "kg" {
                format!("{value:.3} кг")
            } else {
                format!("{:.0} шт.", value.floor())
            }
        };
        ui.set_selected_production_job_id(clamp_i32(job.job_id));
        ui.set_selected_production_product_id(clamp_i32(job.product_id));
        ui.set_selected_production_job_product(job.product_name.clone().into());
        ui.set_selected_production_job_article(job.product_article.clone().into());
        ui.set_selected_production_job_quantity(format_quantity(job.quantity).into());
        ui.set_selected_production_job_printed(format_quantity(job.printed_quantity).into());
        ui.set_selected_production_job_remaining(
            format_quantity((job.quantity - job.printed_quantity).max(0.0)).into(),
        );
        ui.set_selected_production_job_progress(if job.quantity > 0.0 {
            (job.printed_quantity / job.quantity).clamp(0.0, 1.0) as f32
        } else {
            0.0
        });
        ui.set_selected_production_job_unit(job.quantity_unit.clone().into());
        ui.set_selected_production_job_batch(job.batch_number.clone().into());
        ui.set_selected_production_job_date(
            job.marking_date
                .clone()
                .unwrap_or_else(|| "текущая дата".to_owned())
                .into(),
        );
        ui.set_selected_production_job_status(job.status.clone().into());
    } else {
        ui.set_selected_production_job_id(0);
        ui.set_selected_production_product_id(0);
        ui.set_selected_production_job_product("Выберите задание".into());
        ui.set_selected_production_job_article("".into());
        ui.set_selected_production_job_quantity("0".into());
        ui.set_selected_production_job_printed("0".into());
        ui.set_selected_production_job_remaining("0".into());
        ui.set_selected_production_job_progress(0.0);
        ui.set_selected_production_job_status("pending".into());
    }

    let product_matches = snapshot
        .selected_product
        .as_ref()
        .is_some_and(|product| Some(product.id) == selected.as_ref().map(|job| job.product_id));
    let product = product_matches
        .then_some(snapshot.selected_product)
        .flatten();
    ui.set_selected_production_product_fixed(
        product.as_ref().is_some_and(|product| product.fixed_weight),
    );
    ui.set_selected_production_product_weight(
        product
            .as_ref()
            .map(|product| format!("{:.3}", product.fixed_weight_grams / 1_000.0))
            .unwrap_or_else(|| "0.000".to_owned())
            .into(),
    );
    *selected_product.borrow_mut() = product;
    set_production_counters(ui, &snapshot.counters);
    let weight = ui
        .get_gross_weight()
        .replace(',', ".")
        .parse::<f64>()
        .unwrap_or(0.0);
    ui.set_production_job_weight_valid(weight_is_valid_for_product(
        selected_product.borrow().as_ref(),
        weight,
        ui.get_stable(),
        false,
    ));
    ui.set_production_jobs_status(
        format!("Загружено заданий: {}", job_store.borrow().len()).into(),
    );
}

fn update_production_weight_validity(
    ui: &WeighingPrototype,
    fixed_product: Option<&NativeUiProduct>,
    job_product: Option<&NativeUiProduct>,
) {
    let weight = ui
        .get_gross_weight()
        .replace(',', ".")
        .parse::<f64>()
        .unwrap_or(0.0);
    ui.set_fixed_control_in_range(weight_is_valid_for_product(
        fixed_product,
        weight,
        ui.get_stable(),
        true,
    ));
    ui.set_production_job_weight_valid(weight_is_valid_for_product(
        job_product,
        weight,
        ui.get_stable(),
        false,
    ));
}

fn catalog_template_label(id: Option<i64>, name: &str) -> String {
    match (id, name.trim()) {
        (Some(id), "") => format!("#{id}"),
        (Some(id), name) => format!("{name} · #{id}"),
        (None, _) => "Не назначен".to_owned(),
    }
}

fn apply_catalog_product(ui: &WeighingPrototype, product: Option<&NativeUiProduct>) {
    let Some(product) = product else {
        ui.set_catalog_selected_product_id(0);
        ui.set_catalog_name("Выберите товар".into());
        ui.set_catalog_article("—".into());
        ui.set_catalog_expiration("—".into());
        ui.set_catalog_mode("Весовой".into());
        ui.set_catalog_fixed_weight("—".into());
        ui.set_catalog_portion_container("Не назначена".into());
        ui.set_catalog_portion_tare("0 г".into());
        ui.set_catalog_box_container("Не назначена".into());
        ui.set_catalog_box_tare("0 г".into());
        ui.set_catalog_box_limit("—".into());
        ui.set_catalog_pack_label("Не назначен".into());
        ui.set_catalog_box_label("Не назначен".into());
        ui.set_catalog_pallet_label("Не назначен".into());
        ui.set_catalog_extra("Нет дополнительных данных".into());
        return;
    };
    ui.set_catalog_selected_product_id(clamp_i32(product.id));
    ui.set_catalog_name(product.name.clone().into());
    ui.set_catalog_article(
        if product.article.is_empty() {
            "—".to_owned()
        } else {
            product.article.clone()
        }
        .into(),
    );
    ui.set_catalog_expiration(format!("{} дн.", product.expiration_days.max(0)).into());
    ui.set_catalog_mode(
        if product.fixed_weight {
            "Фиксированный"
        } else {
            "Весовой"
        }
        .into(),
    );
    ui.set_catalog_fixed_weight(
        if product.fixed_weight {
            format!("{:.3} кг", product.fixed_weight_grams / 1_000.0)
        } else {
            "—".to_owned()
        }
        .into(),
    );
    ui.set_catalog_portion_container(
        if product.portion_container_name.is_empty() {
            "Не назначена".to_owned()
        } else {
            product.portion_container_name.clone()
        }
        .into(),
    );
    ui.set_catalog_portion_tare(format!("{:.0} г", product.portion_tare_grams).into());
    ui.set_catalog_box_container(
        if product.box_container_name.is_empty() {
            "Не назначена".to_owned()
        } else {
            product.box_container_name.clone()
        }
        .into(),
    );
    ui.set_catalog_box_tare(format!("{:.0} г", product.box_tare_grams).into());
    ui.set_catalog_box_limit(
        if product.close_box_counter > 0 {
            format!("{} шт.", product.close_box_counter)
        } else {
            "—".to_owned()
        }
        .into(),
    );
    ui.set_catalog_pack_label(
        catalog_template_label(product.pack_label_id, &product.pack_label_name).into(),
    );
    ui.set_catalog_box_label(
        catalog_template_label(product.box_label_id, &product.box_label_name).into(),
    );
    ui.set_catalog_pallet_label(
        catalog_template_label(product.pallet_label_id, &product.pallet_label_name).into(),
    );
    ui.set_catalog_extra(
        if product.extra_data_summary.is_empty() {
            "Нет дополнительных данных".to_owned()
        } else {
            product.extra_data_summary.clone()
        }
        .into(),
    );
}

fn apply_catalog_snapshot(
    ui: &WeighingPrototype,
    snapshot: NativeCatalogSnapshot,
    store: &Rc<RefCell<Vec<NativeUiProduct>>>,
    selected: &Rc<Cell<Option<i64>>>,
) {
    let selected_id = snapshot.selected_product_id;
    let product = selected_id.and_then(|id| snapshot.products.iter().find(|item| item.id == id));
    ui.set_catalog_products(ModelRc::new(VecModel::from(product_rows(
        &snapshot.products,
    ))));
    ui.set_catalog_total(clamp_i32(snapshot.total_matching.max(0)));
    ui.set_catalog_truncated(snapshot.truncated);
    ui.set_catalog_status(
        format!(
            "Загружено {} из {}",
            snapshot.products.len(),
            snapshot.total_matching
        )
        .into(),
    );
    ui.set_catalog_error(false);
    apply_catalog_product(ui, product);
    selected.set(selected_id);
    *store.borrow_mut() = snapshot.products;
}

fn apply_license_status(ui: &WeighingPrototype, license: &NativeLicenseStatus) {
    let active = license.licensed
        && !license.expired
        && (!license.strict || (license.signature_valid && license.machine_ok));
    ui.set_license_active(active);
    ui.set_license_expired(license.expired);
    ui.set_license_mode(license.mode.to_uppercase().into());
    ui.set_license_edition(license.edition.clone().into());
    ui.set_license_customer(
        if license.customer.is_empty() {
            "—".to_owned()
        } else {
            license.customer.clone()
        }
        .into(),
    );
    ui.set_license_expires(
        if license.expires.is_empty() {
            "Бессрочно".to_owned()
        } else {
            license.expires.clone()
        }
        .into(),
    );
    ui.set_license_id(
        if license.license_id.is_empty() {
            "—".to_owned()
        } else {
            license.license_id.clone()
        }
        .into(),
    );
    let limit = license.max_stations.or(license.demo_max_stations);
    ui.set_license_stations(
        limit
            .map(|limit| format!("{} из {limit}", license.stations_used.max(0)))
            .unwrap_or_else(|| format!("{} · без лимита", license.stations_used.max(0)))
            .into(),
    );
    ui.set_license_features(
        if license.features.is_empty() {
            "Функции не указаны".to_owned()
        } else {
            license.features.join(" · ")
        }
        .into(),
    );
    ui.set_license_signature(
        if !license.strict {
            "Обычный режим".to_owned()
        } else if license.signature_valid && license.machine_ok {
            "Подпись и устройство подтверждены".to_owned()
        } else {
            "Проверка не пройдена".to_owned()
        }
        .into(),
    );
    ui.set_license_machine(
        if license.machine_id.is_empty() {
            "—".to_owned()
        } else {
            bounded_text(&license.machine_id, 36)
        }
        .into(),
    );
}

fn update_percent(downloaded: u64, total: u64) -> i32 {
    downloaded
        .saturating_mul(100)
        .checked_div(total)
        .unwrap_or(0)
        .min(100) as i32
}

fn format_update_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "—".to_owned();
    }
    if bytes >= 1_048_576 {
        format!("{:.1} МБ", bytes as f64 / 1_048_576.0)
    } else {
        format!("{:.0} КБ", bytes as f64 / 1_024.0)
    }
}

fn update_user_message(error: &str) -> String {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("request update manifest") {
        if normalized.contains("timed out") || normalized.contains("timeout") {
            return "Сервер обновлений не ответил вовремя. Проверьте подключение и повторите попытку."
                .to_owned();
        }
        if normalized.contains("404") || normalized.contains("not found") {
            return "На сервере пока нет опубликованного обновления.".to_owned();
        }
        return "Нет связи с сервером обновлений. Проверьте подключение к сети и повторите попытку."
            .to_owned();
    }
    if normalized.contains("download update package") {
        if normalized.contains("timed out") || normalized.contains("timeout") {
            return "Загрузка обновления прервана по тайм-ауту. Повторите попытку.".to_owned();
        }
        return "Не удалось загрузить пакет обновления. Проверьте подключение и повторите попытку."
            .to_owned();
    }
    redact_update_links(error)
}

fn redact_update_links(error: &str) -> String {
    let mut result = String::with_capacity(error.len());
    let mut remaining = error;
    loop {
        let lower = remaining.to_ascii_lowercase();
        let position = [lower.find("https://"), lower.find("http://")]
            .into_iter()
            .flatten()
            .min();
        let Some(position) = position else {
            result.push_str(remaining);
            break;
        };
        result.push_str(&remaining[..position]);
        result.push_str("[адрес сервера скрыт]");
        remaining = &remaining[position..];
        let end = remaining
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ')' | ']' | '}' | '>' | ',' | ';')
            })
            .unwrap_or(remaining.len());
        remaining = &remaining[end..];
    }
    result
}

fn apply_update_snapshot(ui: &WeighingPrototype, snapshot: &NativeUpdateSnapshot) {
    let available = !snapshot.available_version.is_empty()
        && matches!(
            snapshot.state.as_str(),
            "available" | "downloading" | "ready"
        );
    let ready = snapshot.state == "ready";
    ui.set_update_state(snapshot.state.clone().into());
    ui.set_update_status(snapshot.status.clone().into());
    ui.set_update_current_version(snapshot.current_version.clone().into());
    ui.set_update_available_version(
        if snapshot.available_version.is_empty() {
            "—".to_owned()
        } else {
            snapshot.available_version.clone()
        }
        .into(),
    );
    ui.set_update_notes(
        if snapshot.notes.trim().is_empty() {
            "Описание изменений не опубликовано".to_owned()
        } else {
            snapshot.notes.clone()
        }
        .into(),
    );
    ui.set_update_size(format_update_bytes(snapshot.total_bytes).into());
    ui.set_update_progress(if ready {
        100
    } else {
        update_percent(snapshot.downloaded_bytes, snapshot.total_bytes)
    });
    ui.set_update_available(available);
    ui.set_update_ready(ready);
    ui.set_update_rollback_available(snapshot.rollback_available);
    ui.set_update_error(
        if snapshot.last_error.is_empty() {
            String::new()
        } else {
            update_user_message(&snapshot.last_error)
        }
        .into(),
    );
    ui.set_update_busy(matches!(
        snapshot.state.as_str(),
        "checking" | "downloading" | "installing"
    ));
}
fn apply_server_license_snapshot(ui: &WeighingPrototype, snapshot: NativeServerLicenseSnapshot) {
    ui.set_license_station_name(
        snapshot
            .station
            .name
            .clone()
            .unwrap_or_else(|| "Станция не настроена".to_owned())
            .into(),
    );
    ui.set_license_station_uuid(
        snapshot
            .station
            .uuid
            .clone()
            .unwrap_or_else(|| "—".to_owned())
            .into(),
    );
    ui.set_license_station_number(
        snapshot
            .station
            .number
            .clone()
            .unwrap_or_else(|| "—".to_owned())
            .into(),
    );
    ui.set_license_last_sync(
        snapshot
            .station
            .last_sync_time
            .clone()
            .unwrap_or_else(|| "Нет синхронизации".to_owned())
            .into(),
    );
    ui.set_license_server_address(snapshot.server_address.into());
    ui.set_license_server_configured(snapshot.server_configured);
    ui.set_license_server_online(snapshot.server_online);
    ui.set_license_server_compatible(snapshot.server_compatible);
    ui.set_license_server_version(
        if snapshot.server_version.is_empty() {
            "—".to_owned()
        } else {
            snapshot.server_version
        }
        .into(),
    );
    ui.set_license_min_client_version(
        if snapshot.min_client_version.is_empty() {
            "—".to_owned()
        } else {
            snapshot.min_client_version
        }
        .into(),
    );
    ui.set_license_compatibility(snapshot.compatibility_reason.into());
    ui.set_license_online(snapshot.license_online);
    ui.set_server_online(snapshot.server_online);
    ui.set_server_status(
        if snapshot.server_online {
            "Сервер доступен"
        } else if snapshot.server_configured {
            "Сервер недоступен"
        } else {
            "Не настроен"
        }
        .into(),
    );
    if let Some(license) = snapshot.license.as_ref() {
        apply_license_status(ui, license);
    }
    ui.set_license_status(
        format!(
            "{} · проверено {}",
            if snapshot.server_online {
                "Связь установлена"
            } else if snapshot.server_configured {
                "Офлайн"
            } else {
                "Укажите сервер"
            },
            chrono_like_time()
        )
        .into(),
    );
}
fn operator_rows(
    operators: &[NativeUiOperator],
    last_operator_uuid: Option<&str>,
) -> Vec<OperatorRow> {
    operators
        .iter()
        .map(|operator| OperatorRow {
            uuid: operator.uuid.clone().into(),
            full_name: operator.full_name.clone().into(),
            short_code: operator.short_code.clone().into(),
            has_pin: operator.has_pin,
            is_last: last_operator_uuid == Some(operator.uuid.as_str()),
        })
        .collect()
}

fn apply_products(
    ui: &WeighingPrototype,
    products: Vec<NativeUiProduct>,
    product_store: &Rc<RefCell<Vec<NativeUiProduct>>>,
) {
    ui.set_products(ModelRc::new(VecModel::from(product_rows(&products))));
    *product_store.borrow_mut() = products;
}

fn apply_selected_product(ui: &WeighingPrototype, product: Option<&NativeUiProduct>) {
    match product {
        Some(product) => {
            ui.set_selected_product_id(clamp_i32(product.id));
            ui.set_product_name(product.name.clone().into());
            ui.set_product_article(product.article.clone().into());
            ui.set_expiration_days(clamp_i32(product.expiration_days));
            ui.set_product_tare_kg((product.portion_tare_grams / 1_000.0) as f32);
            ui.set_box_limit(clamp_i32(product.close_box_counter.max(0)));
        }
        None => {
            ui.set_selected_product_id(0);
            ui.set_product_name("Нет товаров — выполните синхронизацию".into());
            ui.set_product_article("".into());
            ui.set_expiration_days(0);
            ui.set_product_tare_kg(0.0);
            ui.set_box_limit(0);
        }
    }
}

fn apply_snapshot(
    ui: &WeighingPrototype,
    snapshot: NativeWeighingSnapshot,
    product_store: &Rc<RefCell<Vec<NativeUiProduct>>>,
    operator_store: &Rc<RefCell<Vec<NativeUiOperator>>>,
    selected_product: &Rc<Cell<Option<i64>>>,
    selected_product_details: &Rc<RefCell<Option<NativeUiProduct>>>,
) {
    let selected_id = snapshot.selected_product_id;
    let selected = selected_id.and_then(|id| {
        snapshot
            .products
            .iter()
            .find(|product| product.id == id)
            .cloned()
    });

    ui.set_station_number(
        snapshot
            .station
            .number
            .clone()
            .unwrap_or_else(|| "--".to_owned())
            .into(),
    );
    if !snapshot.station.provisioned {
        ui.set_server_online(false);
        ui.set_server_status("Не настроен".into());
    }
    let has_operator = snapshot.current_operator.is_some();
    ui.set_operator_name(
        snapshot
            .current_operator
            .as_ref()
            .map(|operator| operator.full_name.as_str())
            .unwrap_or("Без оператора")
            .into(),
    );
    ui.set_operators(ModelRc::new(VecModel::from(operator_rows(
        &snapshot.operators,
        snapshot.last_operator_uuid.as_deref(),
    ))));
    *operator_store.borrow_mut() = snapshot.operators;
    if has_operator {
        ui.set_operator_bypass_active(false);
        ui.set_operator_login_visible(false);
        ui.set_operator_pin_visible(false);
        ui.set_operator_login_error("".into());
    } else if snapshot.station.provisioned && !ui.get_operator_bypass_active() {
        ui.set_operator_login_visible(true);
    }
    let (today, yesterday) = production_dates();
    if parse_display_date(ui.get_labeling_date().as_str()).is_none() {
        ui.set_labeling_date(today.clone().into());
    }
    ui.set_today_date(today.into());
    ui.set_previous_date(yesterday.into());

    selected_product.set(selected_id);
    *selected_product_details.borrow_mut() = selected.clone();
    apply_selected_product(ui, selected.as_ref());
    apply_products(ui, snapshot.products, product_store);

    let counters = snapshot.counters;
    ui.set_units_in_box(clamp_i32(counters.units_in_box));
    ui.set_boxes_on_pallet(clamp_i32(counters.boxes_in_pallet));
    ui.set_total_units(clamp_i32(counters.total_units));
    ui.set_pack_number(if counters.last_pack_number == "0" {
        "—".into()
    } else {
        counters.last_pack_number.clone().into()
    });
    ui.set_box_number(
        counters
            .current_box_number
            .or_else(|| (counters.last_box_number != "0").then_some(counters.last_box_number))
            .unwrap_or_else(|| "—".to_owned())
            .into(),
    );
    ui.set_last_print(
        if counters.total_units > 0 && counters.last_pack_number != "0" {
            format!("#{} · из базы", counters.last_pack_number).into()
        } else {
            "—".into()
        },
    );
}

fn apply_core_event(ui: &WeighingPrototype, event: CoreEvent) {
    match event {
        CoreEvent::Event { name, payload } if name == "scale-reading" => {
            if let Some(weight) = payload.get("weight").and_then(Value::as_f64) {
                ui.set_gross_weight(format!("{weight:.3}").into());
                ui.set_net_weight(
                    format!(
                        "{:.3}",
                        (weight - f64::from(ui.get_product_tare_kg())).max(0.0)
                    )
                    .into(),
                );
            }
            ui.set_stable(
                payload
                    .get("stable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
            ui.set_scale_online(true);
            ui.set_scale_status("Весы: подключены".into());
        }
        CoreEvent::Event { name, payload } if name == "scale-status" => {
            let status = payload.as_str().unwrap_or("disconnected");
            let (label, online) = match status {
                "connected" => ("Весы: подключены", true),
                "connecting" | "reconnecting" => ("Весы: подключение", false),
                _ => ("Весы: отключены", false),
            };
            ui.set_scale_status(label.into());
            ui.set_scale_online(online);
        }
        CoreEvent::Event { name, payload } if name == "scale-error" => {
            ui.set_scale_online(false);
            ui.set_scale_status("Весы: ошибка".into());
            let message = payload
                .as_str()
                .unwrap_or("Ошибка подключения промышленных весов");
            show_alert(ui, message);
        }
        CoreEvent::Event { name, payload } if name == "server-status-updated" => {
            let connected = payload.get("status").and_then(Value::as_str) == Some("connected");
            ui.set_server_online(connected);
            ui.set_server_status(
                if connected {
                    "Сервер: подключен"
                } else {
                    "Сервер: недоступен"
                }
                .into(),
            );
        }
        CoreEvent::Event { name, .. } if name == "sync-complete" => {
            show_toast(ui, "Данные от сервера применены");
        }
        CoreEvent::Event { name, payload } if name == "printer-status-update" => {
            let status = payload.get("status").and_then(Value::as_str);
            match status {
                Some("connected" | "accepted") => {
                    ui.set_printer_ready(true);
                    ui.set_printer_status("Принтер: готов".into());
                }
                Some("error" | "failed" | "unreachable") => {
                    ui.set_printer_ready(false);
                    ui.set_printer_status("Принтер: ошибка".into());
                    show_alert(ui, "Ошибка транспорта принтера");
                }
                _ => {}
            }
        }
        CoreEvent::Log {
            subsystem,
            level,
            message,
        } if level == "ERROR" || level == "WARN" => {
            show_alert(ui, &format!("{subsystem}: {message}"));
        }
        _ => {}
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AdaptiveLayout {
    compact: bool,
    narrow: bool,
    short: bool,
    wide: bool,
    tall: bool,
}

fn adaptive_layout(physical_width: u32, physical_height: u32, scale_factor: f32) -> AdaptiveLayout {
    let scale_factor = scale_factor.max(f32::EPSILON);
    let logical_width = physical_width as f32 / scale_factor;
    let logical_height = physical_height as f32 / scale_factor;
    AdaptiveLayout {
        compact: logical_width < 1280.0,
        narrow: logical_width < 1120.0,
        short: logical_height < 720.0,
        wide: logical_width >= 1600.0,
        tall: logical_height >= 900.0,
    }
}

fn sync_adaptive_layout(ui: &WeighingPrototype) {
    let size = ui.window().size();
    let layout = adaptive_layout(size.width, size.height, ui.window().scale_factor());
    ui.set_compact(layout.compact);
    ui.set_narrow(layout.narrow);
    ui.set_short(layout.short);
    ui.set_wide(layout.wide);
    ui.set_tall(layout.tall);
}

pub fn run() -> Result<(), String> {
    let ui = WeighingPrototype::new()
        .map_err(|error| format!("initialize Slint weighing UI: {error}"))?;
    let initial_width = env::var("LABELPILOT_SLINT_WINDOW_WIDTH")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(1366.0);
    let initial_height = env::var("LABELPILOT_SLINT_WINDOW_HEIGHT")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(768.0);
    ui.window()
        .set_size(slint::LogicalSize::new(initial_width, initial_height));
    let windowed = env::var_os("LABELPILOT_SLINT_WINDOWED").is_some()
        || env::var_os("LABELPILOT_SLINT_SELF_TEST").is_some();
    ui.set_kiosk_mode(!windowed);
    if !windowed {
        // A borderless maximized window follows Windows per-monitor DPI/resize events,
        // unlike borderless fullscreen when moved with Win+Shift+Arrow.
        ui.window().set_maximized(true);
    }
    sync_adaptive_layout(&ui);
    let (message_tx, message_rx) = mpsc::channel::<UiMessage>();
    let product_store = Rc::new(RefCell::new(Vec::<NativeUiProduct>::new()));
    let product_search_generation = Arc::new(AtomicU64::new(0));
    let operator_store = Rc::new(RefCell::new(Vec::<NativeUiOperator>::new()));
    let selected_product = Rc::new(Cell::new(None::<i64>));
    let selected_product_details = Rc::new(RefCell::new(None::<NativeUiProduct>));
    let fixed_product_store = Rc::new(RefCell::new(Vec::<NativeUiProduct>::new()));
    let selected_fixed_product = Rc::new(Cell::new(None::<i64>));
    let production_job_store = Rc::new(RefCell::new(Vec::<NativeProductionPrintJob>::new()));
    let selected_production_job = Rc::new(Cell::new(None::<i64>));
    let selected_production_product = Rc::new(RefCell::new(None::<NativeUiProduct>));
    let printer_settings_store = Rc::new(RefCell::new(None::<NativePrinterSettingsSnapshot>));
    let catalog_product_store = Rc::new(RefCell::new(Vec::<NativeUiProduct>::new()));
    let selected_catalog_product = Rc::new(Cell::new(None::<i64>));

    let active_printer_config;
    let native_updater;
    let mut auto_print_enabled;
    let runtime = if native_runtime_enabled() {
        let persisted = PersistedState::resolve()
            .map_err(|error| format!("resolve LabelPilot data directory: {error}"))?;
        native_updater = Some(NativeUpdateManager::new(
            persisted.data_dir().to_path_buf(),
        )?);
        if let Some(updater) = native_updater.as_ref() {
            apply_update_snapshot(&ui, &updater.snapshot());
        }
        let scale_config = if env::var_os("LABELPILOT_SCALE_HOST").is_some() {
            scale_config()
        } else {
            persisted.load_scale_config()
        };
        let persisted_printer_config = persisted.load_printer_config();
        ui.set_ui_language(
            normalized_ui_language(
                persisted_printer_config
                    .get("language")
                    .and_then(Value::as_str),
            )
            .into(),
        );
        auto_print_enabled = persisted_printer_config
            .get("autoPrintOnStable")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        active_printer_config = if env::var_os("LABELPILOT_PRINTER_HOST").is_some() {
            printer_config()
        } else {
            persisted_printer_config
                .get("packPrinter")
                .cloned()
                .unwrap_or_else(printer_config)
        };
        let callback_tx = message_tx.clone();
        let initialized = NativeUiRuntime::with_persisted(persisted, move |event| {
            let _ = callback_tx.send(UiMessage::Core(event));
        })
        .and_then(|runtime| {
            runtime
                .weighing_snapshot(None, None)
                .map(|snapshot| (runtime, snapshot))
        });
        match initialized {
            Ok((runtime, snapshot)) => {
                apply_snapshot(
                    &ui,
                    snapshot,
                    &product_store,
                    &operator_store,
                    &selected_product,
                    &selected_product_details,
                );
                if env::var_os("LABELPILOT_SLINT_SKIP_OPERATOR_PROMPT").is_some() {
                    ui.set_operator_bypass_active(true);
                    ui.set_operator_login_visible(false);
                }

                let configured = printer_is_configured(&active_printer_config);
                ui.set_printer_ready(configured);
                ui.set_printer_status(
                    if configured {
                        "Принтер: настроен"
                    } else {
                        "Принтер: не настроен"
                    }
                    .into(),
                );
                ui.set_scale_status("Весы: подключение".into());
                if let Err(error) = runtime.connect_scale(scale_config) {
                    ui.set_scale_status("Весы: ошибка".into());
                    let _ = message_tx.send(UiMessage::Core(CoreEvent::Log {
                        subsystem: "scale".to_owned(),
                        level: "ERROR".to_owned(),
                        message: error,
                    }));
                }
                if let Err(error) = runtime.start_station_ingress() {
                    ui.set_server_online(false);
                    ui.set_server_status("Синхронизация: резервный режим".into());
                    let _ = message_tx.send(UiMessage::Core(CoreEvent::Log {
                        subsystem: "ingress".to_owned(),
                        level: "INFO".to_owned(),
                        message: error,
                    }));
                }
                Some(runtime)
            }
            Err(error)
                if native_updater
                    .as_ref()
                    .is_some_and(|updater| updater.snapshot().rollback_available) =>
            {
                append_runtime_log(&format!(
                    "native runtime initialization failed; entering recovery mode: {error}"
                ));
                auto_print_enabled = false;
                ui.set_active_page(9);
                ui.set_operator_login_visible(false);
                ui.set_server_online(false);
                ui.set_scale_online(false);
                ui.set_printer_ready(false);
                ui.set_update_state("recovery".into());
                ui.set_update_status("Режим восстановления".into());
                ui.set_update_error(
                    "Рабочие данные не открылись. Восстановите предыдущую версию и базу из сохранённой точки."
                        .into(),
                );
                show_alert(
                    &ui,
                    "Рабочая база данных не открылась. Доступно ручное восстановление предыдущей версии.",
                );
                None
            }
            Err(error) => {
                return Err(format!("initialize native Slint runtime: {error}"));
            }
        }
    } else {
        active_printer_config = Value::Null;
        auto_print_enabled = false;
        native_updater = None;
        None
    };

    if env::var_os("LABELPILOT_SLINT_SHOW_PRODUCT_PICKER").is_some() {
        ui.set_operator_login_visible(false);
        ui.set_product_modal_visible(true);
        ui.set_touch_keyboard_visible(true);
        ui.set_touch_keyboard_layout(0);
        ui.set_touch_keyboard_uppercase(false);
    }
    if env::var_os("LABELPILOT_SLINT_PRODUCT_SEARCH_TEST").is_some() {
        ui.set_operator_login_visible(false);
        ui.set_product_modal_visible(true);
        ui.set_touch_keyboard_visible(false);
        ui.set_products(ModelRc::new(VecModel::from(
            (1..=12)
                .map(|index| ProductRow {
                    id: index,
                    name: format!("Тестовый товар {index:02} / Product {index:02}").into(),
                    article: format!("ART-{index:04}").into(),
                    details: format!("арт. ART-{index:04} · срок 45 дн.").into(),
                })
                .collect::<Vec<_>>(),
        )));
    }
    if env::var_os("LABELPILOT_SLINT_SIDEBAR_INFO_TEST").is_some() {
        ui.set_operator_login_visible(false);
        ui.set_station_number("02".into());
        ui.set_operator_name("Fedorovskyi".into());
        ui.set_server_online(env::var_os("LABELPILOT_SLINT_SIDEBAR_INFO_OFFLINE").is_none());
    }
    let auto_print_gate = Rc::new(RefCell::new(AutoPrintGate::new(auto_print_enabled)));
    ui.set_auto_print_enabled(auto_print_enabled);
    ui.set_auto_print_status(
        if auto_print_enabled {
            "АВТОПЕЧАТЬ: ПОДГОТОВКА"
        } else {
            ""
        }
        .into(),
    );
    if env::var_os("LABELPILOT_SLINT_STATUS_HEADER_TEST").is_some() {
        ui.set_auto_print_enabled(true);
        ui.set_auto_print_status("СНИМИТЕ ТОВАР".into());
        ui.set_scale_online(false);
        ui.set_scale_status("Весы: отключены".into());
        ui.set_printer_ready(false);
        ui.set_printer_status("Принтер: не готов".into());
    }

    if auto_print_enabled {
        let weak = ui.as_weak();
        let gate = Rc::clone(&auto_print_gate);
        slint::Timer::single_shot(Duration::from_millis(1_500), move || {
            gate.borrow_mut().mark_ready();
            if let Some(ui) = weak.upgrade() {
                ui.set_auto_print_status("АВТОПЕЧАТЬ: ГОТОВА".into());
            }
        });
    }

    let runtime_revision = Rc::new(RefCell::new(
        runtime.as_ref().and_then(|runtime| runtime.revision().ok()),
    ));
    let refresh_coordinator = Rc::new(RefCell::new(RefreshCoordinator::default()));
    let queue_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let diagnostics_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let printer_health_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let pack_printer_configured = Rc::new(Cell::new(printer_is_configured(&active_printer_config)));
    let printer_settings_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let scale_settings_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let fixed_weight_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let production_jobs_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let catalog_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    let server_license_refresh_gate = Rc::new(RefCell::new(RefreshGate::default()));
    if env::var_os("LABELPILOT_SLINT_SIDEBAR_INFO_TEST").is_none() {
        if let Some(server_runtime) = runtime.as_ref() {
            schedule_server_license_refresh(
                &server_license_refresh_gate,
                server_runtime,
                &message_tx,
            );
        }
    }
    if let Some(warmup_runtime) = runtime.clone() {
        if printer_is_configured(&active_printer_config) {
            ui.set_printer_ready(false);
            ui.set_printer_status("Принтер: подключение".into());
        }
        let warmup_tx = message_tx.clone();
        thread::spawn(move || {
            let _ = warmup_tx.send(UiMessage::WarmupFinished(
                warmup_runtime.warmup_production_assets(),
            ));
        });
    }

    let today = time::OffsetDateTime::now_utc().date();
    if parse_display_date(ui.get_labeling_date().as_str()).is_none() {
        ui.set_labeling_date(format_date(today).into());
    }
    let (today_label, previous_label) = production_dates();
    ui.set_today_date(today_label.into());
    ui.set_previous_date(previous_label.into());
    let calendar_month = Rc::new(Cell::new(first_day_of_month(today)));
    apply_calendar(&ui, calendar_month.get());
    if env::var_os("LABELPILOT_SLINT_SESSION_CARD_TEST").is_some() {
        ui.set_active_page(0);
        ui.set_batch_number("240831".into());
        ui.set_labeling_date("31.08.2026".into());
        ui.set_pack_number("02000604".into());
        ui.set_box_number("0277".into());
        ui.set_units_in_box(6);
        ui.set_box_limit(10);
        ui.set_boxes_on_pallet(33);
        ui.set_total_units(604);
        apply_calendar(&ui, calendar_month.get());
    }
    if env::var_os("LABELPILOT_SLINT_CALENDAR_TEST").is_some() {
        ui.set_date_modal_visible(true);
    }

    ui.on_open_date_calendar({
        let weak = ui.as_weak();
        let calendar_month = Rc::clone(&calendar_month);
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let selected = parse_display_date(ui.get_labeling_date().as_str())
                .unwrap_or_else(|| time::OffsetDateTime::now_utc().date());
            let visible_month = first_day_of_month(selected);
            calendar_month.set(visible_month);
            apply_calendar(&ui, visible_month);
        }
    });
    ui.on_shift_calendar_month({
        let weak = ui.as_weak();
        let calendar_month = Rc::clone(&calendar_month);
        move |delta| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(visible_month) =
                offset_calendar_month(calendar_month.get(), delta.clamp(-1, 1))
            else {
                return;
            };
            calendar_month.set(visible_month);
            apply_calendar(&ui, visible_month);
        }
    });

    ui.on_edit_touch_text(|current, key, uppercase| {
        edit_touch_text(current.as_str(), key.as_str(), uppercase).into()
    });
    ui.on_edit_fixed_copies(|current, key| {
        edit_fixed_copies(current.as_str(), key.as_str()).into()
    });
    ui.on_step_fixed_copies(|current, delta| step_fixed_copies(current.as_str(), delta).into());
    ui.on_search_products({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        let product_search_generation = Arc::clone(&product_search_generation);
        move |query| {
            let Some(runtime) = runtime.clone() else {
                return;
            };
            let generation = product_search_generation.fetch_add(1, Ordering::AcqRel) + 1;
            if let Some(ui) = weak.upgrade() {
                ui.set_product_search_busy(true);
            }
            let query = query
                .trim()
                .chars()
                .take(TOUCH_SEARCH_MAX_CHARS)
                .collect::<String>();
            let message_tx = message_tx.clone();
            let product_search_generation = Arc::clone(&product_search_generation);
            thread::spawn(move || {
                thread::sleep(PRODUCT_SEARCH_DEBOUNCE);
                if product_search_generation.load(Ordering::Acquire) != generation {
                    return;
                }
                let search = (!query.is_empty()).then_some(query.as_str());
                let outcome = runtime.products(search);
                if product_search_generation.load(Ordering::Acquire) == generation {
                    let _ = message_tx.send(UiMessage::ProductSearchLoaded {
                        generation,
                        outcome,
                    });
                }
            });
        }
    });

    ui.on_select_product({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let product_store = Rc::clone(&product_store);
        let message_tx = message_tx.clone();
        move |index| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                return;
            };
            let Some(product_id) = usize::try_from(index)
                .ok()
                .and_then(|index| product_store.borrow().get(index).map(|product| product.id))
            else {
                return;
            };
            let search = ui.get_product_search().trim().to_owned();
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let search = (!search.is_empty()).then_some(search.as_str());
                let _ = message_tx.send(UiMessage::Hydrated(
                    runtime.weighing_snapshot(Some(product_id), search),
                ));
            });
        }
    });

    ui.on_select_operator({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let operator_store = Rc::clone(&operator_store);
        let selected_product = Rc::clone(&selected_product);
        let message_tx = message_tx.clone();
        move |index| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                ui.set_operator_login_visible(false);
                return;
            };
            let Some(operator) = usize::try_from(index)
                .ok()
                .and_then(|index| operator_store.borrow().get(index).cloned())
            else {
                show_alert(&ui, "Оператор больше не доступен — обновите список");
                return;
            };
            if operator.has_pin {
                ui.set_selected_operator_index(index);
                ui.set_selected_operator_name(operator.full_name.into());
                ui.set_operator_pin("".into());
                ui.set_operator_login_error("".into());
                ui.set_operator_pin_visible(true);
                return;
            }
            ui.set_operator_login_busy(true);
            let selected_id = selected_product.get();
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.login_operator(&operator.uuid, "");
                let snapshot = runtime.weighing_snapshot(selected_id, None);
                let _ = message_tx.send(UiMessage::SessionFinished {
                    action: "login".to_owned(),
                    outcome,
                    snapshot: Box::new(snapshot),
                });
            });
        }
    });

    ui.on_submit_operator_pin({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let operator_store = Rc::clone(&operator_store);
        let selected_product = Rc::clone(&selected_product);
        let message_tx = message_tx.clone();
        move |index, pin| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                return;
            };
            let Some(operator) = usize::try_from(index)
                .ok()
                .and_then(|index| operator_store.borrow().get(index).cloned())
            else {
                ui.set_operator_pin_visible(false);
                show_alert(&ui, "Оператор больше не доступен — обновите список");
                return;
            };
            ui.set_operator_login_busy(true);
            let selected_id = selected_product.get();
            let pin = pin.to_string();
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.login_operator(&operator.uuid, &pin);
                let snapshot = runtime.weighing_snapshot(selected_id, None);
                let _ = message_tx.send(UiMessage::SessionFinished {
                    action: "login".to_owned(),
                    outcome,
                    snapshot: Box::new(snapshot),
                });
            });
        }
    });

    ui.on_continue_without_operator({
        let weak = ui.as_weak();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            ui.set_operator_bypass_active(true);
            ui.set_operator_login_visible(false);
            ui.set_operator_pin_visible(false);
            ui.set_operator_login_error("".into());
            show_toast(&ui, "Работа без оператора включена");
        }
    });

    ui.on_switch_operator({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected_product = Rc::clone(&selected_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            ui.set_operator_bypass_active(false);
            ui.set_operator_login_error("".into());
            let Some(runtime) = runtime.clone() else {
                ui.set_operator_login_visible(true);
                return;
            };
            ui.set_operator_login_busy(true);
            let selected_id = selected_product.get();
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.logout_operator();
                let snapshot = runtime.weighing_snapshot(selected_id, None);
                let _ = message_tx.send(UiMessage::SessionFinished {
                    action: "logout".to_owned(),
                    outcome,
                    snapshot: Box::new(snapshot),
                });
            });
        }
    });
    ui.on_print_label({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected_product = Rc::clone(&selected_product);
        let auto_print_gate = Rc::clone(&auto_print_gate);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if let Some(runtime) = runtime.clone() {
                let Some(product_id) = selected_product.get() else {
                    show_alert(&ui, "Выберите товар перед печатью");
                    return;
                };
                let gross_weight = ui
                    .get_gross_weight()
                    .replace(',', ".")
                    .parse::<f64>()
                    .unwrap_or(0.0);
                if !auto_print_gate
                    .borrow_mut()
                    .begin_manual_print(gross_weight)
                {
                    show_toast(&ui, "Печать уже выполняется");
                    return;
                }
                if ui.get_auto_print_enabled() {
                    ui.set_auto_print_status("ПЕЧАТЬ…".into());
                }
                let batch_number = ui.get_batch_number().to_string();
                let production_date = ui.get_labeling_date().to_string();
                show_toast(&ui, "Запись упаковки и формирование этикетки…");
                let message_tx = message_tx.clone();
                thread::spawn(move || {
                    let outcome = runtime.print_production_pack(
                        product_id,
                        gross_weight,
                        batch_number,
                        production_date,
                    );
                    let snapshot = runtime.weighing_snapshot(Some(product_id), None);
                    let _ = message_tx.send(UiMessage::ProductionFinished {
                        action: "pack".to_owned(),
                        outcome,
                        snapshot: Box::new(snapshot),
                    });
                });
                return;
            }

            let units = ui.get_units_in_box() + 1;
            ui.set_units_in_box(units);
            ui.set_total_units(ui.get_total_units() + 1);
            ui.set_last_print(format!("#01000247 · {}", chrono_like_time()).into());
            show_toast(&ui, "Этикетка отправлена в очередь");
        }
    });

    ui.on_repeat_print({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected_product = Rc::clone(&selected_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if let Some(runtime) = runtime.clone() {
                let selected_id = selected_product.get();
                show_toast(&ui, "Повтор последней этикетки…");
                let message_tx = message_tx.clone();
                thread::spawn(move || {
                    let outcome = runtime.repeat_production_print();
                    let snapshot = runtime.weighing_snapshot(selected_id, None);
                    let _ = message_tx.send(UiMessage::ProductionFinished {
                        action: "repeat".to_owned(),
                        outcome,
                        snapshot: Box::new(snapshot),
                    });
                });
            } else {
                show_toast(&ui, "Последняя этикетка отправлена повторно");
            }
        }
    });

    ui.on_close_box({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected_product = Rc::clone(&selected_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if let Some(runtime) = runtime.clone() {
                let from_production_job =
                    ui.get_active_page() == 6 && ui.get_selected_production_product_id() > 0;
                let selected_id = if from_production_job {
                    Some(i64::from(ui.get_selected_production_product_id()))
                } else {
                    selected_product.get()
                };
                let Some(product_id) = selected_id else {
                    show_alert(&ui, "Выберите товар перед закрытием короба");
                    return;
                };
                if ui.get_units_in_box() == 0 {
                    show_alert(&ui, "В текущем коробе ещё нет упаковок");
                    return;
                }
                let job_batch = ui.get_selected_production_job_batch().to_string();
                let batch_number =
                    if from_production_job && !job_batch.trim().is_empty() && job_batch != "—" {
                        job_batch
                    } else {
                        ui.get_batch_number().to_string()
                    };
                let job_date = ui.get_selected_production_job_date().to_string();
                let production_date = if from_production_job
                    && !job_date.trim().is_empty()
                    && job_date != "—"
                    && job_date != "текущая дата"
                {
                    job_date
                } else {
                    ui.get_labeling_date().to_string()
                };
                if from_production_job {
                    ui.set_production_jobs_busy(true);
                    ui.set_production_jobs_status(
                        format!(
                            "Закрытие короба по заданию #{}…",
                            ui.get_selected_production_job_id()
                        )
                        .into(),
                    );
                }
                show_toast(&ui, "Закрытие короба и формирование этикетки…");
                let message_tx = message_tx.clone();
                thread::spawn(move || {
                    let outcome =
                        runtime.close_production_box(product_id, &batch_number, &production_date);
                    let snapshot = runtime.weighing_snapshot(Some(product_id), None);
                    let _ = message_tx.send(UiMessage::ProductionFinished {
                        action: "box".to_owned(),
                        outcome,
                        snapshot: Box::new(snapshot),
                    });
                });
                return;
            }
            if ui.get_units_in_box() == 0 {
                show_alert(&ui, "В текущем коробе ещё нет упаковок");
                return;
            }
            ui.set_boxes_on_pallet(ui.get_boxes_on_pallet() + 1);
            ui.set_units_in_box(0);
            ui.set_box_number(format!("0100{:04}", ui.get_boxes_on_pallet() + 24).into());
            show_toast(&ui, "Короб закрыт, коробная этикетка сформирована");
        }
    });

    ui.on_print_pallet({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected_product = Rc::clone(&selected_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if let Some(runtime) = runtime.clone() {
                let from_production_job =
                    ui.get_active_page() == 6 && ui.get_selected_production_product_id() > 0;
                let selected_id = if from_production_job {
                    Some(i64::from(ui.get_selected_production_product_id()))
                } else {
                    selected_product.get()
                };
                if from_production_job {
                    ui.set_production_jobs_busy(true);
                    ui.set_production_jobs_status("Формирование паллетного листа…".into());
                }
                show_toast(&ui, "Формирование паллетного листа…");
                let message_tx = message_tx.clone();
                thread::spawn(move || {
                    let outcome = runtime.print_production_pallet(selected_id);
                    let snapshot = runtime.weighing_snapshot(selected_id, None);
                    let _ = message_tx.send(UiMessage::ProductionFinished {
                        action: "pallet".to_owned(),
                        outcome,
                        snapshot: Box::new(snapshot),
                    });
                });
            } else {
                show_toast(&ui, "Паллетный лист сформирован");
            }
        }
    });

    ui.on_refresh_print_queue({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&queue_refresh_gate);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_queue_busy(false);
                ui.set_queue_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_queue_busy(true);
            ui.set_queue_status("Чтение локальной очереди…".into());
            schedule_queue_refresh(&gate, runtime, &message_tx);
        }
    });

    ui.on_retry_print_job({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move |job_id| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                show_alert(&ui, "Нативный runtime не подключен");
                return;
            };
            ui.set_queue_busy(true);
            ui.set_queue_status("Повторная отправка задания…".into());
            let job_id = job_id.to_string();
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.retry_print_job(&job_id).map(|_| ());
                let snapshot = runtime.printer_queue_snapshot(100);
                let _ = message_tx.send(UiMessage::QueueActionFinished {
                    action: "retry".to_owned(),
                    outcome,
                    snapshot,
                });
            });
        }
    });

    ui.on_cancel_print_job({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move |job_id| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                show_alert(&ui, "Нативный runtime не подключен");
                return;
            };
            ui.set_queue_busy(true);
            ui.set_queue_status("Отмена задания…".into());
            let job_id = job_id.to_string();
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.cancel_print_job(&job_id).map(|_| ());
                let snapshot = runtime.printer_queue_snapshot(100);
                let _ = message_tx.send(UiMessage::QueueActionFinished {
                    action: "cancel".to_owned(),
                    outcome,
                    snapshot,
                });
            });
        }
    });

    ui.on_probe_printers({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&diagnostics_refresh_gate);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_diagnostics_busy(false);
                ui.set_diagnostics_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_diagnostics_busy(true);
            ui.set_diagnostics_status("Опрашиваем настроенные устройства…".into());
            schedule_diagnostics_refresh(&gate, runtime, &message_tx);
        }
    });

    ui.on_reload_printer_settings({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&printer_settings_refresh_gate);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_settings_busy(false);
                ui.set_settings_status("Нативный runtime не подключен".into());
                return;
            };
            if ui.get_settings_dirty() {
                show_toast(&ui, "Несохранённые изменения сброшены");
            }
            ui.set_settings_busy(true);
            ui.set_settings_status("Чтение настроек и системных устройств…".into());
            schedule_printer_settings_refresh(&gate, runtime, &message_tx);
        }
    });

    ui.on_select_printer_role({
        let weak = ui.as_weak();
        let store = Rc::clone(&printer_settings_store);
        move |role| {
            let Some(ui) = weak.upgrade() else { return };
            if ui.get_settings_dirty() {
                show_toast(&ui, "Сохраните или обновите текущую карточку");
                return;
            }
            let role = role.to_string();
            let selected = store
                .borrow()
                .as_ref()
                .and_then(|snapshot| snapshot.roles.iter().find(|item| item.role == role))
                .cloned();
            if let Some(selected) = selected.as_ref() {
                apply_printer_role_editor(&ui, selected);
            }
        }
    });

    ui.on_save_printer_settings({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                show_alert(&ui, "Нативный runtime не подключен");
                return;
            };
            let input = match printer_settings_input(&ui) {
                Ok(input) => input,
                Err(error) => {
                    show_alert(&ui, &format!("Настройки принтера: {error}"));
                    return;
                }
            };
            let auto_print = ui.get_settings_auto_print();
            ui.set_settings_busy(true);
            ui.set_settings_status("Проверка и атомарное сохранение…".into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.save_printer_role_settings(input, auto_print);
                let _ = message_tx.send(UiMessage::PrinterSettingsSaved(outcome));
            });
        }
    });

    ui.on_detect_printer_settings({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                show_alert(&ui, "Нативный runtime не подключен");
                return;
            };
            let input = match printer_settings_input(&ui) {
                Ok(input) => input,
                Err(error) => {
                    show_alert(&ui, &format!("Определение принтера: {error}"));
                    return;
                }
            };
            let auto_print = ui.get_settings_auto_print();
            ui.set_settings_busy(true);
            ui.set_settings_status("Определяем транспорт и профиль…".into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.detect_and_apply_printer_settings(input, auto_print);
                let snapshot = if outcome.as_ref().is_ok_and(|result| result.applied) {
                    Some(runtime.printer_settings_snapshot())
                } else {
                    None
                };
                let _ = message_tx.send(UiMessage::PrinterSettingsDetected { outcome, snapshot });
            });
        }
    });

    ui.on_test_printer_settings({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                show_alert(&ui, "Нативный runtime не подключен");
                return;
            };
            let input = match printer_settings_input(&ui) {
                Ok(input) => input,
                Err(error) => {
                    show_alert(&ui, &format!("Тестовая печать: {error}"));
                    return;
                }
            };
            ui.set_settings_busy(true);
            ui.set_settings_status("Генерация и отправка тестовой этикетки…".into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let _ = message_tx.send(UiMessage::PrinterSettingsTested(
                    runtime.test_printer_settings(input),
                ));
            });
        }
    });

    ui.on_reload_scale_settings({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&scale_settings_refresh_gate);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_scale_settings_busy(false);
                ui.set_scale_settings_status("Нативный runtime не подключен".into());
                return;
            };
            if ui.get_scale_settings_dirty() {
                show_toast(&ui, "Несохранённые настройки весов сброшены");
            }
            ui.set_scale_settings_busy(true);
            ui.set_scale_settings_status("Чтение конфигурации и Serial-портов…".into());
            schedule_scale_settings_refresh(&gate, runtime, &message_tx);
        }
    });

    ui.on_save_scale_settings({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                show_alert(&ui, "Нативный runtime не подключен");
                return;
            };
            let input = match scale_settings_input(&ui) {
                Ok(input) => input,
                Err(error) => {
                    show_alert(&ui, &format!("Настройки весов: {error}"));
                    return;
                }
            };
            ui.set_scale_settings_busy(true);
            ui.set_scale_settings_status("Сохранение и перезапуск потока весов…".into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let _ = message_tx.send(UiMessage::ScaleSettingsSaved(
                    runtime.save_scale_settings(input),
                ));
            });
        }
    });

    ui.on_test_scale_settings({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                show_alert(&ui, "Нативный runtime не подключен");
                return;
            };
            let input = match scale_settings_input(&ui) {
                Ok(input) => input,
                Err(error) => {
                    show_alert(&ui, &format!("Проверка весов: {error}"));
                    return;
                }
            };
            ui.set_scale_settings_busy(true);
            ui.set_scale_settings_status("Открываем транспорт и ждём реальный кадр…".into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let _ = message_tx.send(UiMessage::ScaleSettingsTested(
                    runtime.test_scale_settings(input),
                ));
            });
        }
    });

    ui.on_reload_fixed_weight({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&fixed_weight_refresh_gate);
        let selected = Rc::clone(&selected_fixed_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_fixed_busy(false);
                ui.set_fixed_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_fixed_busy(true);
            ui.set_fixed_status("Загрузка товаров фиксированного веса…".into());
            schedule_fixed_weight_refresh(&gate, runtime, &message_tx, selected.get(), None);
        }
    });

    ui.on_search_fixed_products({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&fixed_weight_refresh_gate);
        let selected = Rc::clone(&selected_fixed_product);
        let message_tx = message_tx.clone();
        move |query| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_fixed_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_fixed_busy(true);
            let query = query.to_string();
            schedule_fixed_weight_refresh(
                &gate,
                runtime,
                &message_tx,
                selected.get(),
                (!query.trim().is_empty()).then_some(query.trim().to_owned()),
            );
        }
    });

    ui.on_select_fixed_product({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&fixed_weight_refresh_gate);
        let store = Rc::clone(&fixed_product_store);
        let selected = Rc::clone(&selected_fixed_product);
        let message_tx = message_tx.clone();
        move |index| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                return;
            };
            let Some(product_id) = usize::try_from(index)
                .ok()
                .and_then(|index| store.borrow().get(index).map(|product| product.id))
            else {
                return;
            };
            selected.set(Some(product_id));
            ui.set_fixed_product_modal_visible(false);
            ui.set_fixed_busy(true);
            schedule_fixed_weight_refresh(&gate, runtime, &message_tx, Some(product_id), None);
        }
    });

    ui.on_print_fixed_weight({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected = Rc::clone(&selected_fixed_product);
        let auto_print_gate = Rc::clone(&auto_print_gate);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                ui.set_fixed_status("Нативный runtime не подключен".into());
                return;
            };
            let Some(product_id) = selected.get() else {
                show_alert(&ui, "Выберите товар фиксированного веса");
                return;
            };
            if !ui.get_stable() || !ui.get_fixed_control_in_range() {
                show_alert(
                    &ui,
                    "Дождитесь стабильного контрольного веса в пределах допуска",
                );
                return;
            }
            let measured = ui
                .get_gross_weight()
                .replace(',', ".")
                .parse::<f64>()
                .unwrap_or(0.0);
            if !auto_print_gate.borrow_mut().begin_manual_print(measured) {
                show_toast(&ui, "Печать уже выполняется");
                return;
            }
            let batch = ui.get_batch_number().to_string();
            let date = ui.get_labeling_date().to_string();
            ui.set_fixed_busy(true);
            ui.set_fixed_status("Запись упаковки и печать фиксированной этикетки…".into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.print_fixed_weight_pack(product_id, measured, batch, date);
                let snapshot = runtime.fixed_weight_snapshot(Some(product_id), None);
                let _ = message_tx.send(UiMessage::FixedWeightPrinted {
                    automatic: false,
                    outcome,
                    snapshot,
                });
            });
        }
    });

    ui.on_start_fixed_batch({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected = Rc::clone(&selected_fixed_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                ui.set_fixed_status("Нативный runtime не подключен".into());
                return;
            };
            let Some(product_id) = selected.get() else {
                show_alert(&ui, "Выберите товар фиксированного веса");
                return;
            };
            let copies = match ui.get_fixed_copies().trim().parse::<i64>() {
                Ok(copies) if (1..=5_000).contains(&copies) => copies,
                _ => {
                    show_alert(&ui, "Количество этикеток должно быть от 1 до 5000");
                    return;
                }
            };
            let batch = ui.get_batch_number().to_string();
            let date = ui.get_labeling_date().to_string();
            ui.set_fixed_busy(true);
            ui.set_fixed_progress(0);
            ui.set_fixed_progress_total(clamp_i32(copies));
            ui.set_fixed_status(format!("Пакетная печать · 0 из {copies}").into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.print_fixed_weight_batch(product_id, copies, batch, date);
                let snapshot = runtime.fixed_weight_snapshot(Some(product_id), None);
                let _ = message_tx.send(UiMessage::FixedBatchFinished { outcome, snapshot });
            });
        }
    });

    ui.on_cancel_fixed_batch({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if runtime
                .as_ref()
                .is_some_and(NativeUiRuntime::cancel_fixed_weight_batch)
            {
                ui.set_fixed_status("Остановка после текущей этикетки…".into());
            }
        }
    });

    ui.on_reload_production_jobs({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&production_jobs_refresh_gate);
        let selected = Rc::clone(&selected_production_job);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_production_jobs_busy(false);
                ui.set_production_jobs_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_production_jobs_busy(true);
            ui.set_production_jobs_status("Чтение заданий сервера…".into());
            schedule_production_jobs_refresh(
                &gate,
                runtime,
                &message_tx,
                selected.get(),
                ui.get_production_jobs_completed(),
            );
        }
    });

    ui.on_select_production_job({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&production_jobs_refresh_gate);
        let store = Rc::clone(&production_job_store);
        let selected = Rc::clone(&selected_production_job);
        let message_tx = message_tx.clone();
        move |index| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                return;
            };
            let Some(job) = usize::try_from(index)
                .ok()
                .and_then(|index| store.borrow().get(index).cloned())
            else {
                return;
            };
            let job_id = job.job_id;
            let format_quantity = |value: f64| {
                if job.quantity_unit == "kg" {
                    format!("{value:.3} кг")
                } else {
                    format!("{:.0} шт.", value.floor())
                }
            };
            selected.set(Some(job_id));
            ui.set_selected_production_job_id(clamp_i32(job.job_id));
            ui.set_selected_production_product_id(clamp_i32(job.product_id));
            ui.set_selected_production_job_product(job.product_name.clone().into());
            ui.set_selected_production_job_article(job.product_article.clone().into());
            ui.set_selected_production_job_quantity(format_quantity(job.quantity).into());
            ui.set_selected_production_job_printed(format_quantity(job.printed_quantity).into());
            ui.set_selected_production_job_remaining(
                format_quantity((job.quantity - job.printed_quantity).max(0.0)).into(),
            );
            ui.set_selected_production_job_progress(if job.quantity > 0.0 {
                (job.printed_quantity / job.quantity).clamp(0.0, 1.0) as f32
            } else {
                0.0
            });
            ui.set_selected_production_job_unit(job.quantity_unit.clone().into());
            ui.set_selected_production_job_batch(job.batch_number.clone().into());
            ui.set_selected_production_job_date(
                job.marking_date
                    .clone()
                    .unwrap_or_else(|| "текущая дата".to_owned())
                    .into(),
            );
            ui.set_selected_production_job_status(job.status.clone().into());
            ui.set_production_job_weight_valid(false);
            ui.set_production_jobs_busy(true);
            schedule_production_jobs_refresh(
                &gate,
                runtime,
                &message_tx,
                Some(job_id),
                ui.get_production_jobs_completed(),
            );
        }
    });

    ui.on_print_production_job_pack({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected = Rc::clone(&selected_production_job);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                ui.set_production_jobs_status("Нативный runtime не подключен".into());
                return;
            };
            let Some(job_id) = selected.get() else {
                show_alert(&ui, "Выберите задание на печать");
                return;
            };
            if !ui.get_stable() || !ui.get_production_job_weight_valid() {
                show_alert(&ui, "Дождитесь стабильного допустимого веса");
                return;
            }
            let measured = ui
                .get_gross_weight()
                .replace(',', ".")
                .parse::<f64>()
                .unwrap_or(0.0);
            ui.set_production_jobs_busy(true);
            ui.set_production_jobs_status(format!("Печать по заданию #{job_id}…").into());
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.print_production_job_pack(job_id, measured);
                let snapshot = runtime.production_print_jobs_snapshot(Some(job_id), None);
                let _ = message_tx.send(UiMessage::ProductionJobPrinted {
                    outcome,
                    snapshot: Box::new(snapshot),
                });
            });
        }
    });

    ui.on_complete_production_job({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected = Rc::clone(&selected_production_job);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                return;
            };
            let Some(job_id) = selected.get() else { return };
            if ui.get_units_in_box() > 0 {
                let box_number = ui.get_box_number();
                show_alert(
                    &ui,
                    &format!(
                        "Перед завершением задания закройте короб {} · {} упаковок",
                        box_number,
                        ui.get_units_in_box()
                    ),
                );
                return;
            }
            ui.set_production_jobs_busy(true);
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.complete_production_print_job(job_id);
                let snapshot = runtime.production_print_jobs_snapshot(None, None);
                let _ = message_tx.send(UiMessage::ProductionJobActionFinished {
                    action: "complete".to_owned(),
                    outcome,
                    snapshot: Box::new(snapshot),
                });
            });
        }
    });

    ui.on_delete_production_job({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected = Rc::clone(&selected_production_job);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                return;
            };
            let Some(job_id) = selected.get() else { return };

            ui.set_production_jobs_busy(true);
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let outcome = runtime.delete_production_print_job(job_id);
                let snapshot = runtime.production_print_jobs_snapshot(None, None);
                let _ = message_tx.send(UiMessage::ProductionJobActionFinished {
                    action: "delete".to_owned(),
                    outcome,
                    snapshot: Box::new(snapshot),
                });
            });
        }
    });

    ui.on_quit_app(|| {
        let _ = slint::quit_event_loop();
    });
    ui.on_reload_catalog({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&catalog_refresh_gate);
        let selected = Rc::clone(&selected_catalog_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_catalog_busy(false);
                ui.set_catalog_error(true);
                ui.set_catalog_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_catalog_busy(true);
            ui.set_catalog_error(false);
            ui.set_catalog_status("Чтение локального каталога…".into());
            let query = ui.get_catalog_search().to_string();
            schedule_catalog_refresh(
                &gate,
                runtime,
                &message_tx,
                selected.get(),
                (!query.trim().is_empty()).then_some(query.trim().to_owned()),
                ui.get_catalog_limit().max(CATALOG_PAGE_SIZE as i32) as usize,
            );
        }
    });

    ui.on_search_catalog({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&catalog_refresh_gate);
        let selected = Rc::clone(&selected_catalog_product);
        let message_tx = message_tx.clone();
        move |query| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_catalog_error(true);
                ui.set_catalog_status("Нативный runtime не подключен".into());
                return;
            };
            let query = query.to_string();
            ui.set_catalog_search(query.clone().into());
            ui.set_catalog_limit(CATALOG_PAGE_SIZE as i32);
            ui.set_catalog_busy(true);
            ui.set_catalog_error(false);
            ui.set_catalog_status("Поиск в локальном каталоге…".into());
            schedule_catalog_refresh(
                &gate,
                runtime,
                &message_tx,
                selected.get(),
                (!query.trim().is_empty()).then_some(query.trim().to_owned()),
                CATALOG_PAGE_SIZE,
            );
        }
    });

    ui.on_load_more_catalog({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&catalog_refresh_gate);
        let selected = Rc::clone(&selected_catalog_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_catalog_error(true);
                ui.set_catalog_status("Нативный runtime не подключен".into());
                return;
            };
            let current = ui.get_catalog_limit().max(CATALOG_PAGE_SIZE as i32) as usize;
            let total = ui.get_catalog_total().max(0) as usize;
            if current >= total {
                return;
            }
            let next = current.saturating_add(CATALOG_PAGE_SIZE).min(total);
            ui.set_catalog_limit(next.min(i32::MAX as usize) as i32);
            ui.set_catalog_busy(true);
            ui.set_catalog_error(false);
            ui.set_catalog_status("Загрузка следующей части каталога…".into());
            let query = ui.get_catalog_search().to_string();
            schedule_catalog_refresh(
                &gate,
                runtime,
                &message_tx,
                selected.get(),
                (!query.trim().is_empty()).then_some(query.trim().to_owned()),
                next,
            );
        }
    });

    ui.on_select_catalog_product({
        let weak = ui.as_weak();
        let store = Rc::clone(&catalog_product_store);
        let selected = Rc::clone(&selected_catalog_product);
        move |index| {
            let Some(ui) = weak.upgrade() else { return };
            let product = usize::try_from(index)
                .ok()
                .and_then(|index| store.borrow().get(index).cloned());
            if let Some(product) = product.as_ref() {
                selected.set(Some(product.id));
                apply_catalog_product(&ui, Some(product));
            }
        }
    });

    ui.on_reload_license({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let gate = Rc::clone(&server_license_refresh_gate);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.as_ref() else {
                ui.set_license_busy(false);
                ui.set_license_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_license_busy(true);
            ui.set_license_status("Проверка сервера и лицензии…".into());
            schedule_server_license_refresh(&gate, runtime, &message_tx);
        }
    });

    ui.on_save_server_address({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let message_tx = message_tx.clone();
        move |address| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(runtime) = runtime.clone() else {
                ui.set_license_status("Нативный runtime не подключен".into());
                return;
            };
            ui.set_license_busy(true);
            ui.set_license_status("Сохранение адреса и проверка связи…".into());
            let address = address.to_string();
            let message_tx = message_tx.clone();
            thread::spawn(move || {
                let _ = message_tx.send(UiMessage::ServerAddressSaved(
                    runtime.save_server_address(&address),
                ));
            });
        }
    });

    ui.on_check_update({
        let weak = ui.as_weak();
        let updater = native_updater.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(updater) = updater.clone() else {
                ui.set_update_error("Нативный updater не подключен".into());
                return;
            };
            ui.set_update_busy(true);
            ui.set_update_error("".into());
            ui.set_update_status("Проверка канала обновлений…".into());
            let tx = message_tx.clone();
            thread::spawn(move || {
                let result = updater.check_online();
                let _ = tx.send(UiMessage::UpdateFinished {
                    action: "check".to_owned(),
                    result,
                });
            });
        }
    });

    ui.on_download_update({
        let weak = ui.as_weak();
        let updater = native_updater.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(updater) = updater.clone() else {
                ui.set_update_error("Нативный updater не подключен".into());
                return;
            };
            ui.set_update_busy(true);
            ui.set_update_error("".into());
            let tx = message_tx.clone();
            thread::spawn(move || {
                let progress_tx = tx.clone();
                let result = updater.download(move |downloaded, total| {
                    let _ = progress_tx.send(UiMessage::UpdateProgress { downloaded, total });
                });
                let _ = tx.send(UiMessage::UpdateFinished {
                    action: "download".to_owned(),
                    result,
                });
            });
        }
    });

    ui.on_stage_offline_update({
        let weak = ui.as_weak();
        let updater = native_updater.clone();
        let message_tx = message_tx.clone();
        move |path| {
            let Some(ui) = weak.upgrade() else { return };
            let Some(updater) = updater.clone() else {
                ui.set_update_error("Нативный updater не подключен".into());
                return;
            };
            let path = PathBuf::from(path.to_string().trim());
            if path.as_os_str().is_empty() {
                ui.set_update_error("Укажите путь к native-latest.json".into());
                return;
            }
            ui.set_update_busy(true);
            ui.set_update_error("".into());
            ui.set_update_status("Проверка офлайн-пакета…".into());
            let tx = message_tx.clone();
            thread::spawn(move || {
                let result = updater.stage_offline_manifest(&path);
                let _ = tx.send(UiMessage::UpdateFinished {
                    action: "offline".to_owned(),
                    result,
                });
            });
        }
    });

    ui.on_install_update({
        let weak = ui.as_weak();
        let updater = native_updater.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(updater) = updater.clone() else {
                ui.set_update_error("Нативный updater не подключен".into());
                return;
            };
            ui.set_update_busy(true);
            ui.set_update_status("Создание точки восстановления…".into());
            let tx = message_tx.clone();
            thread::spawn(move || {
                let result = updater.queue_install();
                let _ = tx.send(UiMessage::UpdateFinished {
                    action: "install".to_owned(),
                    result,
                });
            });
        }
    });

    ui.on_rollback_update({
        let weak = ui.as_weak();
        let updater = native_updater.clone();
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let Some(updater) = updater.clone() else {
                ui.set_update_error("Нативный updater не подключен".into());
                return;
            };
            ui.set_update_busy(true);
            ui.set_update_error("".into());
            ui.set_update_status("Подготовка ручного восстановления…".into());
            let tx = message_tx.clone();
            thread::spawn(move || {
                let result = updater.queue_manual_rollback();
                let _ = tx.send(UiMessage::UpdateFinished {
                    action: "rollback".to_owned(),
                    result,
                });
            });
        }
    });
    ui.on_delete_last({
        let weak = ui.as_weak();
        let runtime = runtime.clone();
        let selected_product = Rc::clone(&selected_product);
        let message_tx = message_tx.clone();
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if let Some(runtime) = runtime.clone() {
                let Some(product_id) = selected_product.get() else {
                    show_alert(&ui, "Выберите товар перед удалением упаковки");
                    return;
                };
                show_toast(&ui, "Удаление последней упаковки…");
                let message_tx = message_tx.clone();
                thread::spawn(move || {
                    let outcome = runtime.delete_latest_production_pack(product_id);
                    let snapshot = runtime.weighing_snapshot(Some(product_id), None);
                    let _ = message_tx.send(UiMessage::DeleteFinished {
                        outcome,
                        snapshot: Box::new(snapshot),
                    });
                });
                return;
            }
            if ui.get_units_in_box() == 0 {
                show_alert(&ui, "В текущем коробе нет упаковок для удаления");
                return;
            }
            ui.set_units_in_box(ui.get_units_in_box() - 1);
            ui.set_total_units((ui.get_total_units() - 1).max(0));
            show_toast(&ui, "Последняя упаковка удалена");
        }
    });

    match env::var("LABELPILOT_SLINT_START_PAGE").ok().as_deref() {
        Some("queue") => {
            ui.set_active_page(1);
            ui.invoke_refresh_print_queue();
        }
        Some("diagnostics") => {
            ui.set_active_page(2);
            ui.invoke_probe_printers();
        }
        Some("settings") => {
            ui.set_active_page(3);
            ui.invoke_reload_printer_settings();
        }
        Some("scale-settings" | "scales") => {
            ui.set_active_page(4);
            ui.invoke_reload_scale_settings();
        }
        Some("fixed-weight" | "fixed") => {
            ui.set_active_page(5);
            ui.invoke_reload_fixed_weight();
        }
        Some("print-jobs" | "jobs") => {
            ui.set_active_page(6);
            ui.invoke_reload_production_jobs();
        }
        Some("products" | "catalog") => {
            ui.set_active_page(7);
            ui.invoke_reload_catalog();
        }
        Some("license" | "server") => {
            ui.set_active_page(8);
            ui.invoke_reload_license();
        }
        Some("update" | "updates" | "maintenance") => {
            ui.set_active_page(9);
            ui.invoke_check_update();
        }
        _ => {}
    }
    if env::var_os("LABELPILOT_SLINT_SELF_TEST").is_some() {
        ui.set_operator_login_visible(true);
        ui.invoke_continue_without_operator();
        assert!(ui.get_operator_bypass_active());
        assert!(!ui.get_operator_login_visible());
        ui.invoke_switch_operator();
        assert!(!ui.get_operator_bypass_active());
        assert!(ui.get_operator_login_visible());
        ui.set_operator_login_visible(false);
        ui.set_active_page(1);
        ui.invoke_refresh_print_queue();
        assert!(ui.get_queue_status().contains("runtime"));
        ui.set_active_page(2);
        ui.invoke_probe_printers();
        assert!(ui.get_diagnostics_status().contains("runtime"));
        ui.set_active_page(3);
        ui.invoke_reload_printer_settings();
        assert!(ui.get_settings_status().contains("runtime"));
        ui.set_active_page(4);
        ui.invoke_reload_scale_settings();
        assert!(ui.get_scale_settings_status().contains("runtime"));
        ui.set_active_page(5);
        ui.invoke_reload_fixed_weight();
        assert!(ui.get_fixed_status().contains("runtime"));
        ui.set_active_page(6);
        ui.invoke_reload_production_jobs();
        assert!(ui.get_production_jobs_status().contains("runtime"));
        ui.set_active_page(7);
        ui.invoke_reload_catalog();
        assert!(ui.get_catalog_status().contains("runtime"));
        ui.set_active_page(8);
        ui.invoke_reload_license();
        assert!(ui.get_license_status().contains("runtime"));
        ui.invoke_save_server_address("127.0.0.1:8000".into());
        assert!(ui.get_license_status().contains("runtime"));
        ui.set_active_page(0);

        let initial_units = ui.get_units_in_box();
        let initial_total = ui.get_total_units();
        let initial_boxes = ui.get_boxes_on_pallet();
        ui.set_selected_product_id(1);
        ui.invoke_print_label();
        assert_eq!(ui.get_units_in_box(), initial_units + 1);
        assert_eq!(ui.get_total_units(), initial_total + 1);
        assert!(ui.get_toast_visible());

        ui.invoke_repeat_print();
        assert!(ui.get_toast_text().contains("повторно"));

        ui.invoke_close_box();
        assert_eq!(ui.get_units_in_box(), 0);
        assert_eq!(ui.get_boxes_on_pallet(), initial_boxes + 1);

        ui.invoke_close_box();
        assert!(ui.get_alert_visible());
        ui.set_alert_visible(false);

        ui.set_units_in_box(1);
        ui.invoke_delete_last();
        assert_eq!(ui.get_units_in_box(), 0);
        assert_eq!(ui.get_total_units(), initial_total);

        ui.invoke_print_pallet();
        assert!(ui.get_toast_text().contains("Паллетный"));
        crate::native_update::confirm_startup_health()
            .map_err(|error| format!("confirm updater self-test health: {error}"))?;
        std::process::exit(0);
    }

    let adaptive_timer = slint::Timer::default();
    {
        let weak = ui.as_weak();
        adaptive_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(100),
            move || {
                if let Some(ui) = weak.upgrade() {
                    sync_adaptive_layout(&ui);
                }
            },
        );
    }

    let event_timer = slint::Timer::default();
    if let Some(event_runtime) = runtime.clone() {
        let weak = ui.as_weak();
        let product_store = Rc::clone(&product_store);
        let operator_store = Rc::clone(&operator_store);
        let selected_product = Rc::clone(&selected_product);
        let event_selected_product_details = Rc::clone(&selected_product_details);
        let auto_print_gate = Rc::clone(&auto_print_gate);
        let event_revision = Rc::clone(&runtime_revision);
        let event_refresh_coordinator = Rc::clone(&refresh_coordinator);
        let event_queue_gate = Rc::clone(&queue_refresh_gate);
        let event_diagnostics_gate = Rc::clone(&diagnostics_refresh_gate);
        let event_printer_health_gate = Rc::clone(&printer_health_refresh_gate);
        let event_pack_printer_configured = Rc::clone(&pack_printer_configured);
        let event_settings_gate = Rc::clone(&printer_settings_refresh_gate);
        let event_scale_settings_gate = Rc::clone(&scale_settings_refresh_gate);
        let event_fixed_weight_gate = Rc::clone(&fixed_weight_refresh_gate);
        let event_production_jobs_gate = Rc::clone(&production_jobs_refresh_gate);
        let event_catalog_gate = Rc::clone(&catalog_refresh_gate);
        let event_server_license_gate = Rc::clone(&server_license_refresh_gate);
        let event_settings_store = Rc::clone(&printer_settings_store);
        let event_fixed_product_store = Rc::clone(&fixed_product_store);
        let event_selected_fixed_product = Rc::clone(&selected_fixed_product);
        let event_production_job_store = Rc::clone(&production_job_store);
        let event_selected_production_job = Rc::clone(&selected_production_job);
        let event_selected_production_product = Rc::clone(&selected_production_product);
        let event_catalog_product_store = Rc::clone(&catalog_product_store);
        let event_selected_catalog_product = Rc::clone(&selected_catalog_product);
        let event_message_tx = message_tx.clone();
        let event_product_search_generation = Arc::clone(&product_search_generation);
        event_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(30),
            move || loop {
                match message_rx.try_recv() {
                    Ok(UiMessage::Core(event)) => {
                        let reading = match &event {
                            CoreEvent::Event { name, payload } if name == "scale-reading" => {
                                payload.get("weight").and_then(Value::as_f64).map(|weight| {
                                    (
                                        weight,
                                        payload
                                            .get("stable")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false),
                                    )
                                })
                            }
                            _ => None,
                        };
                        let refresh_flags = direct_refresh_flags(&event);
                        let fixed_progress = match &event {
                            CoreEvent::Event { name, payload } if name == "fixed-batch-progress" => {
                                Some((
                                    payload.get("completed").and_then(Value::as_i64).unwrap_or(0),
                                    payload.get("requested").and_then(Value::as_i64).unwrap_or(0),
                                ))
                            }
                            _ => None,
                        };
                        let production_jobs_changed = matches!(
                            &event,
                            CoreEvent::Event { name, .. } if name == "print-jobs-updated"
                        );
                        let queue_changed = matches!(
                            &event,
                            CoreEvent::Event { name, .. }
                                if matches!(
                                    name.as_str(),
                                    "printer-durable-job-update" | "printer-durable-recovery"
                                )
                        );
                        let diagnostics_changed = matches!(
                            &event,
                            CoreEvent::Event { name, .. } if name == "printer-config-updated"
                        );
                        let scale_settings_changed = matches!(
                            &event,
                            CoreEvent::Event { name, .. } if name == "scale-config-updated"
                        );
                        if let Some(ui) = weak.upgrade() {
                            apply_core_event(&ui, event);
                            update_production_weight_validity(
                                &ui,
                                event_selected_fixed_product
                                    .get()
                                    .and_then(|id| {
                                        event_fixed_product_store
                                            .borrow()
                                            .iter()
                                            .find(|product| product.id == id)
                                            .cloned()
                                    })
                                    .as_ref(),
                                event_selected_production_product.borrow().as_ref(),
                            );
                            if let Some((completed, requested)) = fixed_progress {
                                ui.set_fixed_progress(clamp_i32(completed));
                                ui.set_fixed_progress_total(clamp_i32(requested));
                                ui.set_fixed_status(
                                    format!("Пакетная печать · {completed} из {requested}").into(),
                                );
                            }
                            if let Some((data_changed, printer_changed)) = refresh_flags {
                                schedule_runtime_refresh(
                                    &event_refresh_coordinator,
                                    &event_runtime,
                                    selected_product.get(),
                                    &event_message_tx,
                                    data_changed,
                                    printer_changed,
                                    None,
                                );
                            }
                            if production_jobs_changed && ui.get_active_page() == 6 {
                                ui.set_production_jobs_busy(true);
                                schedule_production_jobs_refresh(
                                    &event_production_jobs_gate,
                                    &event_runtime,
                                    &event_message_tx,
                                    event_selected_production_job.get(),
                                    ui.get_production_jobs_completed(),
                                );
                            }
                            if refresh_flags.is_some() && ui.get_active_page() == 5 {
                                ui.set_fixed_busy(true);
                                schedule_fixed_weight_refresh(
                                    &event_fixed_weight_gate,
                                    &event_runtime,
                                    &event_message_tx,
                                    event_selected_fixed_product.get(),
                                    None,
                                );
                            }
                            if refresh_flags.is_some() && ui.get_active_page() == 7 {
                                ui.set_catalog_busy(true);
                                let query = ui.get_catalog_search().to_string();
                                schedule_catalog_refresh(
                                    &event_catalog_gate,
                                    &event_runtime,
                                    &event_message_tx,
                                    event_selected_catalog_product.get(),
                                    (!query.trim().is_empty())
                                        .then_some(query.trim().to_owned()),
                                    ui.get_catalog_limit().max(CATALOG_PAGE_SIZE as i32) as usize,
                                );
                            }
                            if queue_changed && ui.get_active_page() == 1 {
                                ui.set_queue_busy(true);
                                schedule_queue_refresh(
                                    &event_queue_gate,
                                    &event_runtime,
                                    &event_message_tx,
                                );
                            }
                            if diagnostics_changed && ui.get_active_page() == 2 {
                                ui.set_diagnostics_busy(true);
                                schedule_diagnostics_refresh(
                                    &event_diagnostics_gate,
                                    &event_runtime,
                                    &event_message_tx,
                                );
                            }
                            if diagnostics_changed && ui.get_active_page() == 3 {
                                if ui.get_settings_dirty() {
                                    ui.set_settings_status(
                                        "Конфигурация изменилась извне · нажмите ОБНОВИТЬ или СОХРАНИТЬ"
                                            .into(),
                                    );
                                } else {
                                    ui.set_settings_busy(true);
                                    schedule_printer_settings_refresh(
                                        &event_settings_gate,
                                        &event_runtime,
                                        &event_message_tx,
                                    );
                                }
                            }
                            if scale_settings_changed && ui.get_active_page() == 4 {
                                if ui.get_scale_settings_dirty() {
                                    ui.set_scale_settings_status(
                                        "Конфигурация изменилась извне · нажмите ОБНОВИТЬ или СОХРАНИТЬ"
                                            .into(),
                                    );
                                } else {
                                    ui.set_scale_settings_busy(true);
                                    schedule_scale_settings_refresh(
                                        &event_scale_settings_gate,
                                        &event_runtime,
                                        &event_message_tx,
                                    );
                                }
                            }
                            if let Some((weight, stable)) = reading {
                                let active_page = ui.get_active_page();
                                let production_selected_id = selected_product.get();
                                let production_has_template =
                                    production_selected_id.is_some_and(|id| {
                                        event_selected_product_details
                                            .borrow()
                                            .as_ref()
                                            .is_some_and(|product| {
                                                product.id == id
                                                    && product.pack_label_id.is_some()
                                            })
                                    });
                                let fixed_selected_id = event_selected_fixed_product.get();
                                let fixed_product = {
                                    let products = event_fixed_product_store.borrow();
                                    self::selected_fixed_product(
                                        products.as_slice(),
                                        fixed_selected_id,
                                    )
                                };
                                let fixed_has_template = fixed_product
                                    .as_ref()
                                    .is_some_and(|product| product.pack_label_id.is_some());
                                let fixed_control_in_range = weight_is_valid_for_product(
                                    fixed_product.as_ref(),
                                    weight,
                                    stable,
                                    true,
                                );
                                let fixed_verify_mode = ui.get_fixed_mode().as_str() == "verify";
                                let target = select_auto_print_target(
                                    active_page,
                                    production_selected_id,
                                    production_has_template,
                                    fixed_selected_id,
                                    fixed_has_template,
                                    fixed_control_in_range,
                                    fixed_verify_mode,
                                    ui.get_fixed_busy(),
                                    ui.get_printer_ready(),
                                );
                                let printable = target.is_some();
                                let decision = auto_print_gate
                                    .borrow_mut()
                                    .observe(weight, stable, printable);
                                match decision {
                                    AutoPrintDecision::None => {
                                        if stable
                                            && weight > 0.010
                                            && ui.get_auto_print_enabled()
                                            && !printable
                                        {
                                            let status = match active_page {
                                                0 if production_selected_id.is_none() => {
                                                    "АВТОПЕЧАТЬ: ВЫБЕРИТЕ ТОВАР"
                                                }
                                                0 if !production_has_template => {
                                                    "АВТОПЕЧАТЬ: НЕТ ШАБЛОНА"
                                                }
                                                5 if !fixed_verify_mode => {
                                                    "АВТОПЕЧАТЬ: РЕЖИМ ПАРТИИ"
                                                }
                                                5 if fixed_selected_id.is_none() => {
                                                    "АВТОПЕЧАТЬ: ВЫБЕРИТЕ ТОВАР"
                                                }
                                                5 if !fixed_has_template => {
                                                    "АВТОПЕЧАТЬ: НЕТ ШАБЛОНА"
                                                }
                                                5 if !fixed_control_in_range => {
                                                    "АВТОПЕЧАТЬ: ВНЕ ДОПУСКА"
                                                }
                                                5 if !ui.get_printer_ready() => {
                                                    "АВТОПЕЧАТЬ: ПРИНТЕР НЕДОСТУПЕН"
                                                }
                                                _ => "АВТОПЕЧАТЬ: ОЖИДАНИЕ",
                                            };
                                            ui.set_auto_print_status(status.into());
                                        }
                                    }
                                    AutoPrintDecision::Rearmed => {
                                        ui.set_auto_print_status("АВТОПЕЧАТЬ: ГОТОВА".into())
                                    }
                                    AutoPrintDecision::Fire => {
                                        ui.set_auto_print_status("АВТОПЕЧАТЬ…".into());
                                        let batch_number = ui.get_batch_number().to_string();
                                        let production_date = ui.get_labeling_date().to_string();
                                        let runtime = event_runtime.clone();
                                        let message_tx = event_message_tx.clone();
                                        match target {
                                            Some(AutoPrintTarget::ProductionPack(product_id)) => {
                                                thread::spawn(move || {
                                                    let outcome = runtime.print_production_pack(
                                                        product_id,
                                                        weight,
                                                        batch_number,
                                                        production_date,
                                                    );
                                                    let snapshot = runtime
                                                        .weighing_snapshot(Some(product_id), None);
                                                    let _ = message_tx.send(
                                                        UiMessage::ProductionFinished {
                                                            action: "auto-pack".to_owned(),
                                                            outcome,
                                                            snapshot: Box::new(snapshot),
                                                        },
                                                    );
                                                });
                                            }
                                            Some(AutoPrintTarget::FixedWeightPack(product_id)) => {
                                                ui.set_fixed_busy(true);
                                                ui.set_fixed_status(
                                                    "Вес стабилен и в допуске · автопечать…"
                                                        .into(),
                                                );
                                                thread::spawn(move || {
                                                    let outcome = runtime.print_fixed_weight_pack(
                                                        product_id,
                                                        weight,
                                                        batch_number,
                                                        production_date,
                                                    );
                                                    let snapshot = runtime.fixed_weight_snapshot(
                                                        Some(product_id),
                                                        None,
                                                    );
                                                    let _ = message_tx.send(
                                                        UiMessage::FixedWeightPrinted {
                                                            automatic: true,
                                                            outcome,
                                                            snapshot,
                                                        },
                                                    );
                                                });
                                            }
                                            None => {
                                                auto_print_gate.borrow_mut().finish_print();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(UiMessage::WarmupFinished(outcome)) => {
                        let Some(ui) = weak.upgrade() else { return };
                        apply_warmup_status(&ui, outcome);
                    }
                    Ok(UiMessage::PrinterHealthChecked(outcome)) => {
                        let pending = event_printer_health_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        match outcome {
                            Ok(device) => {
                                event_pack_printer_configured
                                    .set(device.status != "unconfigured");
                                apply_pack_printer_diagnostic(&ui, &device);
                            }
                            Err(_) if event_pack_printer_configured.get() => {
                                ui.set_printer_ready(false);
                                ui.set_printer_status("Принтер: недоступен".into());
                            }
                            Err(_) => {
                                ui.set_printer_ready(false);
                                ui.set_printer_status("Принтер: не настроен".into());
                            }
                        }
                        if pending {
                            schedule_printer_health_refresh(
                                &event_printer_health_gate,
                                &event_runtime,
                                &event_message_tx,
                            );
                        }
                    }
                    Ok(UiMessage::RuntimeRefreshed {
                        revision,
                        data_changed,
                        printer_changed,
                        snapshot,
                        printer_config,
                        warmup,
                    }) => {
                        let pending = event_refresh_coordinator.borrow_mut().complete();
                        if let Some(revision) = revision {
                            *event_revision.borrow_mut() = Some(revision);
                        }
                        let Some(ui) = weak.upgrade() else { return };
                        if data_changed {
                            match snapshot {
                                Some(Ok(snapshot)) => apply_snapshot(
                                    &ui,
                                    snapshot,
                                    &product_store,
                                    &operator_store,
                                    &selected_product,
                                    &selected_product_details,
                                ),
                                Some(Err(error)) => {
                                    show_alert(&ui, &format!("Обновление данных: {error}"))
                                }
                                None => {}
                            }
                        }
                        if printer_changed {
                            match printer_config {
                                Some(Ok(config)) => {
                                    event_pack_printer_configured.set(printer_is_configured(
                                        &effective_pack_printer(&config),
                                    ));
                                    apply_refreshed_printer_config(&ui, &auto_print_gate, &config)
                                }
                                Some(Err(error)) => {
                                    ui.set_printer_ready(false);
                                    ui.set_printer_status("Принтер: ошибка конфигурации".into());
                                    show_alert(&ui, &format!("Настройки принтера: {error}"));
                                }
                                None => {}
                            }
                            if let Some(outcome) = warmup {
                                apply_warmup_status(&ui, outcome);
                            }
                        }
                        if let Some((pending_data, pending_printer)) = pending {
                            schedule_runtime_refresh(
                                &event_refresh_coordinator,
                                &event_runtime,
                                selected_product.get(),
                                &event_message_tx,
                                pending_data,
                                pending_printer,
                                None,
                            );
                        }
                    }
                    Ok(UiMessage::Hydrated(outcome)) => {
                        let Some(ui) = weak.upgrade() else { return };
                        match outcome {
                            Ok(snapshot) => apply_snapshot(
                                &ui,
                                snapshot,
                                &product_store,
                                &operator_store,
                                &selected_product,
                                &selected_product_details,
                            ),
                            Err(error) => show_alert(&ui, &format!("Данные: {error}")),
                        }
                    }
                    Ok(UiMessage::ProductSearchLoaded {
                        generation,
                        outcome,
                    }) => {
                        if event_product_search_generation.load(Ordering::Acquire) != generation {
                            continue;
                        }
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_product_search_busy(false);
                        ui.set_product_scroll_y(0.0);
                        match outcome {
                            Ok(products) => apply_products(&ui, products, &product_store),
                            Err(error) => show_alert(&ui, &format!("Поиск товаров: {error}")),
                        }
                    }
                    Ok(UiMessage::ProductionFinished {
                        action,
                        outcome,
                        snapshot,
                    }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        if matches!(action.as_str(), "box" | "pallet") {
                            ui.set_production_jobs_busy(false);
                        }
                        if matches!(action.as_str(), "pack" | "auto-pack") {
                            auto_print_gate.borrow_mut().finish_print();
                        }
                        if let Ok(snapshot) = *snapshot {
                            apply_snapshot(
                                &ui,
                                snapshot,
                                &product_store,
                                &operator_store,
                                &selected_product,
                                &selected_product_details,
                            );
                        }
                        match outcome {
                            Ok(result) => {
                                ui.set_last_print(
                                    format!("#{} · {}", result.number, chrono_like_time()).into(),
                                );
                                ui.set_printer_ready(true);
                                ui.set_printer_status("Принтер: готов".into());
                                let message = match action.as_str() {
                                    "repeat" => "Этикетка повторно принята принтером",
                                    "box" if result.receipt.is_none() => {
                                        "Короб закрыт; коробная этикетка не назначена"
                                    }
                                    "box" => "Короб закрыт, этикетка принята принтером",
                                    "pallet" => "Паллетный лист напечатан, паллета закрыта",
                                    "pack" if result.auto_closed_box => {
                                        "Упаковка напечатана, короб автоматически закрыт"
                                    }
                                    "auto-pack" if result.auto_closed_box => {
                                        "Автопечать выполнена, короб автоматически закрыт"
                                    }
                                    "auto-pack" => "Автопечать: этикетка принята принтером",
                                    _ => "Принтер принял этикетку",
                                };
                                if ui.get_auto_print_enabled()
                                    && matches!(action.as_str(), "pack" | "auto-pack")
                                {
                                    ui.set_auto_print_status("СНИМИТЕ ТОВАР".into());
                                }
                                show_toast(&ui, message);
                            }
                            Err(error) => {
                                if ui.get_auto_print_enabled()
                                    && matches!(action.as_str(), "pack" | "auto-pack")
                                {
                                    ui.set_auto_print_status("ОШИБКА ПЕЧАТИ".into());
                                }
                                // Latch the gate: without a working printer the same
                                // product must not loop failed packs and alerts.
                                auto_print_gate.borrow_mut().mark_failed();
                                ui.set_printer_ready(false);
                                ui.set_printer_status("Принтер: ошибка".into());
                                show_alert(&ui, &format!("Операция {action}: {error}"));
                            }
                        }
                    }
                    Ok(UiMessage::DeleteFinished { outcome, snapshot }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        if let Ok(snapshot) = *snapshot {
                            apply_snapshot(
                                &ui,
                                snapshot,
                                &product_store,
                                &operator_store,
                                &selected_product,
                                &selected_product_details,
                            );
                        }
                        match outcome {
                            Ok(pack_id) => show_toast(&ui, &format!("Упаковка #{pack_id} удалена")),
                            Err(error) => show_alert(&ui, &format!("Удаление: {error}")),
                        }
                    }
                    Ok(UiMessage::QueueLoaded(outcome)) => {
                        let pending = event_queue_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_queue_busy(false);
                        match outcome {
                            Ok(snapshot) => apply_queue_snapshot(&ui, snapshot),
                            Err(error) => {
                                ui.set_queue_status("Ошибка чтения очереди".into());
                                show_alert(&ui, &format!("Очередь печати: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 1 {
                            ui.set_queue_busy(true);
                            schedule_queue_refresh(
                                &event_queue_gate,
                                &event_runtime,
                                &event_message_tx,
                            );
                        }
                    }
                    Ok(UiMessage::QueueActionFinished {
                        action,
                        outcome,
                        snapshot,
                    }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_queue_busy(false);
                        if let Ok(snapshot) = snapshot {
                            apply_queue_snapshot(&ui, snapshot);
                        }
                        match outcome {
                            Ok(()) if action == "retry" => {
                                show_toast(&ui, "Задание повторно отправлено")
                            }
                            Ok(()) => show_toast(&ui, "Задание отменено"),
                            Err(error) => show_alert(
                                &ui,
                                &format!(
                                    "{}: {error}",
                                    if action == "retry" {
                                        "Повтор печати"
                                    } else {
                                        "Отмена задания"
                                    }
                                ),
                            ),
                        }
                    }
                    Ok(UiMessage::DiagnosticsLoaded(outcome)) => {
                        let pending = event_diagnostics_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_diagnostics_busy(false);
                        match outcome {
                            Ok(devices) => {
                                if let Some(pack) =
                                    devices.iter().find(|device| device.role == "pack")
                                {
                                    event_pack_printer_configured
                                        .set(pack.status != "unconfigured");
                                    apply_pack_printer_diagnostic(&ui, pack);
                                }
                                apply_diagnostics(&ui, devices);
                            }
                            Err(error) => {
                                ui.set_diagnostics_status("Ошибка проверки оборудования".into());
                                show_alert(&ui, &format!("Диагностика: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 2 {
                            ui.set_diagnostics_busy(true);
                            schedule_diagnostics_refresh(
                                &event_diagnostics_gate,
                                &event_runtime,
                                &event_message_tx,
                            );
                        }
                    }
                    Ok(UiMessage::PrinterSettingsLoaded(outcome)) => {
                        let pending = event_settings_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_settings_busy(false);
                        match outcome {
                            Ok(snapshot) => apply_printer_settings_snapshot(
                                &ui,
                                snapshot,
                                &event_settings_store,
                            ),
                            Err(error) => {
                                ui.set_settings_status("Ошибка чтения настроек".into());
                                show_alert(&ui, &format!("Настройки принтеров: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 3 {
                            ui.set_settings_busy(true);
                            schedule_printer_settings_refresh(
                                &event_settings_gate,
                                &event_runtime,
                                &event_message_tx,
                            );
                        }
                    }
                    Ok(UiMessage::PrinterSettingsSaved(outcome)) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_settings_busy(false);
                        match outcome {
                            Ok(snapshot) => {
                                apply_printer_settings_snapshot(
                                    &ui,
                                    snapshot,
                                    &event_settings_store,
                                );
                                show_toast(&ui, "Настройки принтера сохранены");
                            }
                            Err(error) => {
                                ui.set_settings_status("Сохранение отклонено".into());
                                show_alert(&ui, &format!("Настройки принтера: {error}"));
                            }
                        }
                    }
                    Ok(UiMessage::PrinterSettingsDetected { outcome, snapshot }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_settings_busy(false);
                        match outcome {
                            Ok(result) => {
                                ui.set_settings_detection(
                                    format!(
                                        "{} · {} DPI · {} · {}",
                                        if result.detected {
                                            "Принтер доступен"
                                        } else {
                                            "Принтер не отвечает"
                                        },
                                        result.dpi,
                                        result.recommended_profile,
                                        bounded_text(&result.details, 180)
                                    )
                                    .into(),
                                );
                                if let Some(Ok(snapshot)) = snapshot {
                                    apply_printer_settings_snapshot(
                                        &ui,
                                        snapshot,
                                        &event_settings_store,
                                    );
                                    ui.set_settings_detection(
                                        format!(
                                            "Профиль {} определён и сохранён",
                                            result.recommended_profile
                                        )
                                        .into(),
                                    );
                                    show_toast(&ui, "Профиль принтера применён");
                                } else if !result.detected {
                                    ui.set_settings_status(
                                        "Определение завершено без применения".into(),
                                    );
                                }
                            }
                            Err(error) => {
                                ui.set_settings_status("Ошибка определения".into());
                                show_alert(&ui, &format!("Определение принтера: {error}"));
                            }
                        }
                    }
                    Ok(UiMessage::PrinterSettingsTested(outcome)) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_settings_busy(false);
                        match outcome {
                            Ok(receipt) => {
                                let bytes = receipt
                                    .get("bytes")
                                    .and_then(Value::as_u64)
                                    .unwrap_or_default();
                                ui.set_settings_status(
                                    format!("Тестовая этикетка отправлена · {bytes} байт").into(),
                                );
                                show_toast(&ui, "Тестовая этикетка отправлена");
                            }
                            Err(error) => {
                                ui.set_settings_status("Ошибка тестовой печати".into());
                                show_alert(&ui, &format!("Тестовая печать: {error}"));
                            }
                        }
                    }
                    Ok(UiMessage::ScaleSettingsLoaded(outcome)) => {
                        let pending = event_scale_settings_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_scale_settings_busy(false);
                        match outcome {
                            Ok(snapshot) => apply_scale_settings_snapshot(&ui, snapshot),
                            Err(error) => {
                                ui.set_scale_settings_status("Ошибка чтения настроек".into());
                                show_alert(&ui, &format!("Настройки весов: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 4 {
                            ui.set_scale_settings_busy(true);
                            schedule_scale_settings_refresh(
                                &event_scale_settings_gate,
                                &event_runtime,
                                &event_message_tx,
                            );
                        }
                    }
                    Ok(UiMessage::ScaleSettingsSaved(outcome)) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_scale_settings_busy(false);
                        match outcome {
                            Ok(snapshot) => {
                                apply_scale_settings_snapshot(&ui, snapshot);
                                show_toast(&ui, "Настройки весов сохранены, подключение перезапущено");
                            }
                            Err(error) => {
                                ui.set_scale_settings_status("Сохранение отклонено".into());
                                show_alert(&ui, &format!("Настройки весов: {error}"));
                            }
                        }
                    }
                    Ok(UiMessage::ScaleSettingsTested(outcome)) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_scale_settings_busy(false);
                        match outcome {
                            Ok(result) => {
                                let status = if result.valid_frame {
                                    "Протокол подтверждён"
                                } else if result.reachable {
                                    "Транспорт доступен, кадр не распознан"
                                } else {
                                    "Весы недоступны"
                                };
                                ui.set_scale_settings_probe(
                                    format!(
                                        "{status} · {} · {} мс",
                                        bounded_text(&result.details, 190),
                                        result.elapsed_ms
                                    )
                                    .into(),
                                );
                                ui.set_scale_settings_status(
                                    format!("Проверка завершена · {}", chrono_like_time()).into(),
                                );
                                if result.valid_frame {
                                    show_toast(&ui, "Получен корректный кадр весов");
                                }
                            }
                            Err(error) => {
                                ui.set_scale_settings_status("Ошибка проверки подключения".into());
                                show_alert(&ui, &format!("Проверка весов: {error}"));
                            }
                        }
                    }

                    Ok(UiMessage::FixedWeightLoaded(outcome)) => {
                        let pending = event_fixed_weight_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_fixed_busy(false);
                        match outcome {
                            Ok(snapshot) => apply_fixed_weight_snapshot(
                                &ui,
                                snapshot,
                                &event_fixed_product_store,
                                &event_selected_fixed_product,
                            ),
                            Err(error) => {
                                ui.set_fixed_status("Ошибка чтения товаров".into());
                                show_alert(&ui, &format!("Фиксированный вес: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 5 {
                            ui.set_fixed_busy(true);
                            schedule_fixed_weight_refresh(
                                &event_fixed_weight_gate,
                                &event_runtime,
                                &event_message_tx,
                                event_selected_fixed_product.get(),
                                None,
                            );
                        }
                    }
                    Ok(UiMessage::FixedWeightPrinted {
                        automatic,
                        outcome,
                        snapshot,
                    }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        auto_print_gate.borrow_mut().finish_print();
                        ui.set_fixed_busy(false);
                        if let Ok(snapshot) = snapshot {
                            apply_fixed_weight_snapshot(
                                &ui,
                                snapshot,
                                &event_fixed_product_store,
                                &event_selected_fixed_product,
                            );
                        }
                        match outcome {
                            Ok(result) => {
                                ui.set_last_print(
                                    format!("#{} · {}", result.number, chrono_like_time()).into(),
                                );
                                ui.set_fixed_status(
                                    if result.auto_closed_box {
                                        if automatic {
                                            "Автопечать выполнена · короб автоматически закрыт"
                                        } else {
                                            "Этикетка напечатана · короб автоматически закрыт"
                                        }
                                    } else if automatic {
                                        "Вес стабилен · этикетка автоматически напечатана"
                                    } else {
                                        "Контроль пройден · этикетка принята принтером"
                                    }
                                    .into(),
                                );
                                ui.set_printer_ready(true);
                                ui.set_printer_status("Принтер: готов".into());
                                if ui.get_auto_print_enabled() {
                                    ui.set_auto_print_status("СНИМИТЕ ТОВАР".into());
                                }
                                show_toast(
                                    &ui,
                                    if automatic {
                                        "Автопечать фиксированного веса выполнена"
                                    } else {
                                        "Этикетка фиксированного веса напечатана"
                                    },
                                );
                            }
                            Err(error) => {
                                auto_print_gate.borrow_mut().mark_failed();
                                ui.set_fixed_status("Ошибка печати".into());
                                if ui.get_auto_print_enabled() {
                                    ui.set_auto_print_status("ОШИБКА ПЕЧАТИ".into());
                                }
                                ui.set_printer_ready(false);
                                ui.set_printer_status("Принтер: ошибка".into());
                                show_alert(
                                    &ui,
                                    &format!(
                                        "{}: {error}",
                                        if automatic {
                                            "Автопечать фиксированного веса"
                                        } else {
                                            "Фиксированный вес"
                                        }
                                    ),
                                );
                            }
                        }
                    }
                    Ok(UiMessage::FixedBatchFinished { outcome, snapshot }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_fixed_busy(false);
                        if let Ok(snapshot) = snapshot {
                            apply_fixed_weight_snapshot(
                                &ui,
                                snapshot,
                                &event_fixed_product_store,
                                &event_selected_fixed_product,
                            );
                        }
                        match outcome {
                            Ok(result) => {
                                ui.set_fixed_progress(clamp_i32(result.completed));
                                ui.set_fixed_progress_total(clamp_i32(result.requested));
                                ui.set_fixed_status(
                                    if result.cancelled {
                                        format!(
                                            "Партия остановлена · напечатано {} из {}",
                                            result.completed, result.requested
                                        )
                                    } else {
                                        format!(
                                            "Партия завершена · напечатано {} этикеток",
                                            result.completed
                                        )
                                    }
                                    .into(),
                                );
                                if let Some(last) = result.last_print {
                                    ui.set_last_print(
                                        format!("#{} · {}", last.number, chrono_like_time()).into(),
                                    );
                                }
                                show_toast(
                                    &ui,
                                    if result.cancelled {
                                        "Пакетная печать остановлена"
                                    } else {
                                        "Пакетная печать завершена"
                                    },
                                );
                            }
                            Err(error) => {
                                ui.set_fixed_status("Ошибка пакетной печати".into());
                                show_alert(&ui, &format!("Пакетная печать: {error}"));
                            }
                        }
                    }
                    Ok(UiMessage::ProductionJobsLoaded(outcome)) => {
                        let pending = event_production_jobs_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_production_jobs_busy(false);
                        match *outcome {
                            Ok(snapshot) => apply_production_jobs_snapshot(
                                &ui,
                                snapshot,
                                &event_production_job_store,
                                &event_selected_production_job,
                                &event_selected_production_product,
                            ),
                            Err(error) => {
                                ui.set_production_jobs_status("Ошибка чтения заданий".into());
                                show_alert(&ui, &format!("Задания печати: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 6 {
                            ui.set_production_jobs_busy(true);
                            schedule_production_jobs_refresh(
                                &event_production_jobs_gate,
                                &event_runtime,
                                &event_message_tx,
                                event_selected_production_job.get(),
                                ui.get_production_jobs_completed(),
                            );
                        }
                    }
                    Ok(UiMessage::ProductionJobPrinted { outcome, snapshot }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_production_jobs_busy(false);
                        if let Ok(snapshot) = *snapshot {
                            apply_production_jobs_snapshot(
                                &ui,
                                snapshot,
                                &event_production_job_store,
                                &event_selected_production_job,
                                &event_selected_production_product,
                            );
                        }
                        match outcome {
                            Ok(result) => {
                                ui.set_last_print(
                                    format!("#{} · {}", result.print.number, chrono_like_time())
                                        .into(),
                                );
                                ui.set_production_jobs_status(
                                    format!(
                                        "Задание #{} · выполнено {:.3} из {:.3}",
                                        result.job_id,
                                        result.printed_quantity,
                                        result.total_quantity
                                    )
                                    .into(),
                                );
                                ui.set_printer_ready(true);
                                show_toast(
                                    &ui,
                                    if result.status == "completed" {
                                        "Последняя этикетка задания напечатана"
                                    } else {
                                        "Прогресс задания обновлён"
                                    },
                                );
                            }
                            Err(error) => {
                                ui.set_production_jobs_status("Ошибка печати задания".into());
                                ui.set_printer_ready(false);
                                show_alert(&ui, &format!("Задание печати: {error}"));
                            }
                        }
                    }
                    Ok(UiMessage::ProductionJobActionFinished {
                        action,
                        outcome,
                        snapshot,
                    }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_production_jobs_busy(false);
                        if let Ok(snapshot) = *snapshot {
                            apply_production_jobs_snapshot(
                                &ui,
                                snapshot,
                                &event_production_job_store,
                                &event_selected_production_job,
                                &event_selected_production_product,
                            );
                        }
                        match outcome {
                            Ok(_) => {
                                ui.set_production_job_marking_visible(false);
                                ui.set_production_jobs_scroll_y(0.0);
                                show_toast(
                                    &ui,
                                    if action == "delete" {
                                        "Задание удалено"
                                    } else {
                                        "Задание завершено"
                                    },
                                );
                            }
                            Err(error) => {
                                show_alert(&ui, &format!("Операция с заданием: {error}"))
                            }
                        }
                    }

                    Ok(UiMessage::CatalogLoaded(outcome)) => {
                        let pending = event_catalog_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_catalog_busy(false);
                        match outcome {
                            Ok(snapshot) => apply_catalog_snapshot(
                                &ui,
                                snapshot,
                                &event_catalog_product_store,
                                &event_selected_catalog_product,
                            ),
                            Err(error) => {
                                ui.set_catalog_error(true);
                                ui.set_catalog_status("Ошибка чтения каталога".into());
                                show_alert(&ui, &format!("Каталог товаров: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 7 {
                            ui.set_catalog_busy(true);
                            let query = ui.get_catalog_search().to_string();
                            schedule_catalog_refresh(
                                &event_catalog_gate,
                                &event_runtime,
                                &event_message_tx,
                                event_selected_catalog_product.get(),
                                (!query.trim().is_empty()).then_some(query.trim().to_owned()),
                                ui.get_catalog_limit().max(CATALOG_PAGE_SIZE as i32) as usize,
                            );
                        }
                    }
                    Ok(UiMessage::ServerLicenseLoaded(outcome)) => {
                        let pending = event_server_license_gate.borrow_mut().complete();
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_license_busy(false);
                        match outcome {
                            Ok(snapshot) => apply_server_license_snapshot(&ui, snapshot),
                            Err(error) => {
                                ui.set_license_status("Ошибка проверки сервера".into());
                                show_alert(&ui, &format!("Сервер и лицензия: {error}"));
                            }
                        }
                        if pending && ui.get_active_page() == 8 {
                            ui.set_license_busy(true);
                            schedule_server_license_refresh(
                                &event_server_license_gate,
                                &event_runtime,
                                &event_message_tx,
                            );
                        }
                    }
                    Ok(UiMessage::ServerAddressSaved(outcome)) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_license_busy(false);
                        match outcome {
                            Ok(snapshot) => {
                                apply_server_license_snapshot(&ui, snapshot);
                                show_toast(&ui, "Адрес сервера сохранён");
                            }
                            Err(error) => {
                                ui.set_license_status("Адрес сервера отклонён".into());
                                show_alert(&ui, &format!("Адрес сервера: {error}"));
                            }
                        }
                    }

                    Ok(UiMessage::UpdateProgress { downloaded, total }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_update_busy(true);
                        ui.set_update_state("downloading".into());
                        ui.set_update_status("Загрузка подписанного пакета…".into());
                        ui.set_update_size(format_update_bytes(total).into());
                        ui.set_update_progress(update_percent(downloaded, total));
                    }
                    Ok(UiMessage::UpdateFinished { action, result }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_update_busy(false);
                        match result {
                            Ok(snapshot) => {
                                apply_update_snapshot(&ui, &snapshot);
                                match action.as_str() {
                                    "download" => show_toast(&ui, "Пакет обновления проверен"),
                                    "offline" => show_toast(&ui, "Офлайн-пакет проверен"),
                                    "install" => {
                                        show_toast(&ui, "Перезапуск для установки…");
                                        slint::Timer::single_shot(
                                            Duration::from_millis(700),
                                            || {
                                                let _ = slint::quit_event_loop();
                                            },
                                        );
                                    }
                                    "rollback" => {
                                        show_toast(&ui, "Перезапуск для восстановления…");
                                        slint::Timer::single_shot(
                                            Duration::from_millis(700),
                                            || {
                                                let _ = slint::quit_event_loop();
                                            },
                                        );
                                    }
                                    _ => {}
                                }
                            }
                            Err(error) => {
                                append_runtime_log(&format!(
                                    "native updater action={action} failed: {error}"
                                ));
                                let message = update_user_message(&error);
                                ui.set_update_state("error".into());
                                let operation = if action == "rollback" {
                                    "Восстановление"
                                } else {
                                    "Обновление"
                                };
                                ui.set_update_status(
                                    format!("{operation} завершилось с ошибкой").into(),
                                );
                                ui.set_update_error(message.clone().into());
                                show_alert(&ui, &format!("{operation}: {message}"));
                            }
                        }
                    }
                    Ok(UiMessage::SessionFinished {
                        action,
                        outcome,
                        snapshot,
                    }) => {
                        let Some(ui) = weak.upgrade() else { return };
                        ui.set_operator_login_busy(false);
                        if let Ok(snapshot) = *snapshot {
                            apply_snapshot(
                                &ui,
                                snapshot,
                                &product_store,
                                &operator_store,
                                &selected_product,
                                &selected_product_details,
                            );
                        }
                        match outcome {
                            Ok(result)
                                if result.get("ok").and_then(Value::as_bool) == Some(true) =>
                            {
                                ui.set_operator_login_error("".into());
                                ui.set_operator_pin("".into());
                                ui.set_operator_pin_visible(false);
                                if action == "login" {
                                    ui.set_operator_login_visible(false);
                                    show_toast(&ui, "Оператор выбран");
                                } else {
                                    ui.set_operator_login_visible(true);
                                    show_toast(&ui, "Выберите следующего оператора");
                                }
                            }
                            Ok(result)
                                if result.get("reason").and_then(Value::as_str)
                                    == Some("bad_pin") =>
                            {
                                ui.set_operator_pin("".into());
                                ui.set_operator_pin_visible(true);
                                ui.set_operator_login_visible(true);
                                ui.set_operator_login_error("Неверный PIN".into());
                            }
                            Ok(result)
                                if result.get("reason").and_then(Value::as_str)
                                    == Some("open_entities") =>
                            {
                                let mut reasons = Vec::new();
                                if result
                                    .get("openBoxCount")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)
                                    > 0
                                {
                                    let number = result
                                        .get("openBoxNumber")
                                        .and_then(Value::as_str)
                                        .unwrap_or("?");
                                    reasons.push(format!("закройте короб {number}"));
                                }
                                if result
                                    .get("openPalletCount")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)
                                    > 0
                                {
                                    reasons.push("напечатайте и закройте паллету".to_owned());
                                }
                                let reason = if reasons.is_empty() {
                                    "закройте активные производственные сущности".to_owned()
                                } else {
                                    reasons.join("; ")
                                };
                                show_alert(&ui, &format!("Смена оператора: {reason}"));
                            }
                            Ok(_) => {
                                ui.set_operator_pin("".into());
                                ui.set_operator_pin_visible(false);
                                ui.set_operator_login_visible(true);
                                ui.set_operator_login_error("Вход не выполнен".into());
                            }
                            Err(error) => show_alert(&ui, &format!("Сессия оператора: {error}")),
                        }
                    }
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                }
            },
        );
    }

    let queue_live_timer = slint::Timer::default();
    if let Some(queue_runtime) = runtime.clone() {
        let weak = ui.as_weak();
        let gate = Rc::clone(&queue_refresh_gate);
        let queue_tx = message_tx.clone();
        queue_live_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_secs(2),
            move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_active_page() == 1 {
                    ui.set_queue_busy(true);
                    schedule_queue_refresh(&gate, &queue_runtime, &queue_tx);
                }
            },
        );
    }

    let diagnostics_live_timer = slint::Timer::default();
    if let Some(diagnostics_runtime) = runtime.clone() {
        let weak = ui.as_weak();
        let gate = Rc::clone(&diagnostics_refresh_gate);
        let diagnostics_tx = message_tx.clone();
        diagnostics_live_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_secs(15),
            move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_active_page() == 2 {
                    ui.set_diagnostics_busy(true);
                    schedule_diagnostics_refresh(&gate, &diagnostics_runtime, &diagnostics_tx);
                }
            },
        );
    }

    let printer_health_timer = slint::Timer::default();
    if let Some(printer_health_runtime) = runtime.clone() {
        let weak = ui.as_weak();
        let gate = Rc::clone(&printer_health_refresh_gate);
        let configured = Rc::clone(&pack_printer_configured);
        let health_tx = message_tx.clone();
        let tick = Cell::new(0_u8);
        printer_health_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_secs(5),
            move || {
                let Some(ui) = weak.upgrade() else { return };
                let next = tick.get().wrapping_add(1) % 6;
                tick.set(next);
                if printer_health_poll_due(next, configured.get(), ui.get_printer_ready()) {
                    schedule_printer_health_refresh(&gate, &printer_health_runtime, &health_tx);
                }
            },
        );
    }

    let license_live_timer = slint::Timer::default();
    if let Some(license_runtime) = runtime.clone() {
        let weak = ui.as_weak();
        let gate = Rc::clone(&server_license_refresh_gate);
        let license_tx = message_tx.clone();
        license_live_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_secs(60),
            move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_active_page() == 8 {
                    ui.set_license_busy(true);
                }
                schedule_server_license_refresh(&gate, &license_runtime, &license_tx);
            },
        );
    }
    let refresh_timer = slint::Timer::default();
    if let Some(refresh_runtime) = runtime.clone() {
        let revision_state = Rc::clone(&runtime_revision);
        let coordinator = Rc::clone(&refresh_coordinator);
        let selected_product = Rc::clone(&selected_product);
        let refresh_tx = message_tx.clone();
        refresh_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_secs(5),
            move || {
                let Ok(revision) = refresh_runtime.revision() else {
                    return;
                };
                let previous = *revision_state.borrow();
                let Some(previous) = previous else {
                    *revision_state.borrow_mut() = Some(revision);
                    return;
                };
                let data_changed = revision.data_changed_from(&previous);
                let printer_changed = revision.printer_changed_from(&previous);
                schedule_runtime_refresh(
                    &coordinator,
                    &refresh_runtime,
                    selected_product.get(),
                    &refresh_tx,
                    data_changed,
                    printer_changed,
                    Some(revision),
                );
            },
        );
    }

    let live_weight_timer = slint::Timer::default();
    if runtime.is_none() && live_weight_enabled() {
        let weak = ui.as_weak();
        let tick = Rc::new(Cell::new(0_u32));
        let tick_for_timer = Rc::clone(&tick);
        live_weight_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(120),
            move || {
                let Some(ui) = weak.upgrade() else { return };
                let next = tick_for_timer.get().wrapping_add(1);
                tick_for_timer.set(next);
                let grams = 3_406_i32 + ((next % 7) as i32 - 3);
                let gross = grams as f32 / 1_000.0;
                ui.set_gross_weight(format!("{gross:.3}").into());
                ui.set_net_weight(
                    format!("{:.3}", (gross - ui.get_product_tare_kg()).max(0.0)).into(),
                );
                ui.set_stable(next % 9 >= 3);
            },
        );
    }
    if let Some(snapshot_path) = env::var_os("LABELPILOT_SLINT_SNAPSHOT_PATH") {
        let snapshot_path = PathBuf::from(snapshot_path);
        let weak = ui.as_weak();
        slint::Timer::single_shot(Duration::from_secs(5), move || {
            let result = (|| -> Result<(), String> {
                if let Some(parent) = snapshot_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| {
                        format!(
                            "create Slint snapshot directory {}: {error}",
                            parent.display()
                        )
                    })?;
                }
                let ui = weak
                    .upgrade()
                    .ok_or_else(|| "Slint window closed before snapshot".to_owned())?;
                let pixels = ui
                    .window()
                    .take_snapshot()
                    .map_err(|error| format!("capture Slint window: {error}"))?;
                image::save_buffer(
                    &snapshot_path,
                    pixels.as_bytes(),
                    pixels.width(),
                    pixels.height(),
                    image::ColorType::Rgba8,
                )
                .map_err(|error| {
                    format!("save Slint snapshot {}: {error}", snapshot_path.display())
                })
            })();
            if let Err(error) = result {
                let error_path = snapshot_path.with_extension("error.txt");
                let _ = std::fs::write(error_path, error);
            }
        });
    }

    if runtime.is_some() {
        crate::native_update::confirm_startup_health()
            .map_err(|error| format!("confirm updater startup health: {error}"))?;
    }
    let result = ui.run();
    if let Some(runtime) = &runtime {
        runtime.shutdown();
    }
    result.map_err(|error| format!("run Slint event loop: {error}"))
}

fn chrono_like_time() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    let seconds_in_day = seconds % 86_400;
    format!(
        "{:02}:{:02}:{:02}",
        seconds_in_day / 3_600,
        (seconds_in_day % 3_600) / 60,
        seconds_in_day % 60
    )
}

#[cfg(test)]
mod calendar_tests {
    use super::{
        calendar_day_rows, calendar_month_label, first_day_of_month, format_date,
        offset_calendar_month, parse_display_date,
    };

    fn date(year: i32, month: time::Month, day: u8) -> time::Date {
        time::Date::from_calendar_date(year, month, day).unwrap()
    }

    #[test]
    fn parses_and_formats_display_dates_strictly() {
        let parsed = parse_display_date("31.08.2026").unwrap();
        assert_eq!(format_date(parsed), "31.08.2026");
        assert!(parse_display_date("2026-08-31").is_none());
        assert!(parse_display_date("31.02.2026").is_none());
    }

    #[test]
    fn calendar_is_a_monday_first_six_week_grid() {
        let selected = date(2026, time::Month::August, 31);
        let rows = calendar_day_rows(first_day_of_month(selected), selected);
        assert_eq!(rows.len(), 42);
        assert_eq!(rows[0].date.as_str(), "27.07.2026");
        assert_eq!(rows[41].date.as_str(), "06.09.2026");
        assert_eq!(rows.iter().filter(|row| row.selected).count(), 1);
        assert!(
            rows.iter()
                .find(|row| row.selected)
                .unwrap()
                .in_current_month
        );
    }

    #[test]
    fn month_navigation_wraps_year_boundaries() {
        let january = date(2026, time::Month::January, 1);
        let december = offset_calendar_month(january, -1).unwrap();
        assert_eq!(format_date(december), "01.12.2025");
        assert_eq!(
            format_date(offset_calendar_month(december, 1).unwrap()),
            "01.01.2026"
        );
    }

    #[test]
    fn month_caption_supports_all_four_ui_locales() {
        let august = date(2026, time::Month::August, 1);
        assert_eq!(calendar_month_label(august, "ru"), "Август 2026");
        assert_eq!(calendar_month_label(august, "en"), "August 2026");
        assert_eq!(calendar_month_label(august, "de"), "August 2026");
        assert_eq!(calendar_month_label(august, "uk"), "Серпень 2026");
    }
}

#[cfg(test)]
mod refresh_coordinator_tests {
    use super::{
        diagnostic_status_label, direct_refresh_flags, format_optional_setting,
        pack_printer_ui_state, parse_optional_settings_f64, parse_settings_i32,
        printer_health_poll_due, queue_action_label, queue_state_label, CoreEvent,
        NativePrinterDiagnostic, RefreshCoordinator, RefreshGate,
    };
    use serde_json::{json, Value};

    #[test]
    fn coalesces_direct_events_without_losing_data_or_printer_refresh() {
        let mut coordinator = RefreshCoordinator::default();
        assert_eq!(coordinator.request(false, true), Some((false, true)));
        assert_eq!(coordinator.request(true, false), None);
        assert_eq!(coordinator.request(true, false), None);
        assert_eq!(coordinator.complete(), Some((true, false)));
        assert_eq!(coordinator.request(true, false), Some((true, false)));
        assert_eq!(coordinator.request(false, true), None);
        assert_eq!(coordinator.complete(), Some((false, true)));
        assert_eq!(coordinator.request(false, true), Some((false, true)));
        assert_eq!(coordinator.complete(), None);
    }

    #[test]
    fn coalesces_touch_screen_background_refresh_and_maps_operator_labels() {
        let mut gate = RefreshGate::default();
        assert!(gate.request());
        assert!(!gate.request());
        assert!(!gate.request());
        assert!(gate.complete());
        assert!(gate.request());
        assert!(!gate.complete());

        assert_eq!(queue_state_label("uncertain"), "НЕЯСНО");
        assert_eq!(queue_state_label("accepted"), "ПРИНЯТО");
        assert_eq!(queue_action_label("driver-page"), "Паллетный лист");
        assert_eq!(diagnostic_status_label("paper-out"), "НЕТ БУМАГИ");
        assert_eq!(diagnostic_status_label("unconfigured"), "НЕ НАСТРОЕН");
    }
    fn printer_diagnostic(reachable: bool, status: &str) -> NativePrinterDiagnostic {
        NativePrinterDiagnostic {
            role: "pack".to_owned(),
            role_label: "Этикетка упаковки".to_owned(),
            printer_id: "pack".to_owned(),
            printer_name: "Test printer".to_owned(),
            endpoint: "127.0.0.1:9100".to_owned(),
            protocol: "zpl".to_owned(),
            connection: "tcp".to_owned(),
            reachable,
            status: status.to_owned(),
            details: String::new(),
            queried_at_ms: 1,
        }
    }

    #[test]
    fn maps_pack_printer_health_across_all_transport_states() {
        assert_eq!(
            pack_printer_ui_state(&printer_diagnostic(true, "ready")),
            (true, "Принтер: готов")
        );
        assert_eq!(
            pack_printer_ui_state(&printer_diagnostic(true, "reachable")),
            (true, "Принтер: готов")
        );
        assert_eq!(
            pack_printer_ui_state(&printer_diagnostic(true, "printing")),
            (true, "Принтер: печатает")
        );
        assert_eq!(
            pack_printer_ui_state(&printer_diagnostic(true, "paper-out")),
            (false, "Принтер: нет бумаги")
        );
        assert_eq!(
            pack_printer_ui_state(&printer_diagnostic(false, "unreachable")),
            (false, "Принтер: недоступен")
        );
        assert_eq!(
            pack_printer_ui_state(&printer_diagnostic(false, "unconfigured")),
            (false, "Принтер: не настроен")
        );
    }

    #[test]
    fn polls_unavailable_printer_fast_and_throttles_healthy_or_unconfigured() {
        assert!(printer_health_poll_due(1, true, false));
        assert!(printer_health_poll_due(2, true, false));
        assert!(!printer_health_poll_due(1, true, true));
        assert!(printer_health_poll_due(3, true, true));
        assert!(!printer_health_poll_due(5, false, false));
        assert!(printer_health_poll_due(0, false, false));
    }

    #[test]
    fn parses_touch_form_numbers_and_keeps_optional_values_compact() {
        assert_eq!(parse_settings_i32("DPI", " 300 ").unwrap(), 300);
        assert_eq!(
            parse_optional_settings_f64("Зазор", "2,5").unwrap(),
            Some(2.5)
        );
        assert_eq!(parse_optional_settings_f64("Размер", "").unwrap(), None);
        assert_eq!(format_optional_setting(Some(12.0)), "12");
        assert_eq!(format_optional_setting(Some(2.5)), "2.5");
        assert!(parse_settings_i32("Порт", "abc").is_err());
    }

    #[test]
    fn maps_only_committed_runtime_events_to_refresh_work() {
        assert_eq!(
            direct_refresh_flags(&CoreEvent::Event {
                name: "data-updated".to_owned(),
                payload: Value::Null,
            }),
            Some((true, false))
        );
        assert_eq!(
            direct_refresh_flags(&CoreEvent::Event {
                name: "print-jobs-updated".to_owned(),
                payload: Value::Null,
            }),
            Some((true, false))
        );
        assert_eq!(
            direct_refresh_flags(&CoreEvent::Event {
                name: "printer-config-updated".to_owned(),
                payload: json!({"autoPrintOnStable": true}),
            }),
            Some((false, true))
        );
        assert_eq!(
            direct_refresh_flags(&CoreEvent::Event {
                name: "sync-complete".to_owned(),
                payload: json!({"success": true}),
            }),
            None
        );
    }
}

#[cfg(test)]
mod adaptive_layout_tests {
    use super::{adaptive_layout, AdaptiveLayout};

    #[test]
    fn classifies_supported_touch_resolutions() {
        let cases = [
            (
                (1024, 600, 1.0),
                AdaptiveLayout {
                    compact: true,
                    narrow: true,
                    short: true,
                    wide: false,
                    tall: false,
                },
            ),
            (
                (1280, 720, 1.0),
                AdaptiveLayout {
                    compact: false,
                    narrow: false,
                    short: false,
                    wide: false,
                    tall: false,
                },
            ),
            (
                (1366, 768, 1.0),
                AdaptiveLayout {
                    compact: false,
                    narrow: false,
                    short: false,
                    wide: false,
                    tall: false,
                },
            ),
            (
                (1600, 900, 1.0),
                AdaptiveLayout {
                    compact: false,
                    narrow: false,
                    short: false,
                    wide: true,
                    tall: true,
                },
            ),
            (
                (1920, 1080, 1.0),
                AdaptiveLayout {
                    compact: false,
                    narrow: false,
                    short: false,
                    wide: true,
                    tall: true,
                },
            ),
            (
                (2560, 1440, 1.0),
                AdaptiveLayout {
                    compact: false,
                    narrow: false,
                    short: false,
                    wide: true,
                    tall: true,
                },
            ),
        ];
        for ((width, height, scale), expected) in cases {
            assert_eq!(adaptive_layout(width, height, scale), expected);
        }
    }

    #[test]
    fn normalizes_breakpoints_by_per_monitor_dpi() {
        assert_eq!(
            adaptive_layout(1920, 1080, 1.5),
            AdaptiveLayout {
                compact: false,
                narrow: false,
                short: false,
                wide: false,
                tall: false
            }
        );
        assert_eq!(
            adaptive_layout(1366, 768, 1.25),
            AdaptiveLayout {
                compact: true,
                narrow: true,
                short: true,
                wide: false,
                tall: false
            }
        );
    }
}
#[cfg(test)]
mod auto_print_gate_tests {
    use super::{select_auto_print_target, AutoPrintDecision, AutoPrintGate, AutoPrintTarget};
    use std::time::{Duration, Instant};

    #[test]
    fn routes_fixed_weight_only_when_every_print_precondition_is_true() {
        let ready =
            select_auto_print_target(5, None, false, Some(42), true, true, true, false, true);
        assert_eq!(ready, Some(AutoPrintTarget::FixedWeightPack(42)));

        let blocked = [
            select_auto_print_target(5, None, false, Some(42), false, true, true, false, true),
            select_auto_print_target(5, None, false, Some(42), true, false, true, false, true),
            select_auto_print_target(5, None, false, Some(42), true, true, false, false, true),
            select_auto_print_target(5, None, false, Some(42), true, true, true, true, true),
            select_auto_print_target(5, None, false, Some(42), true, true, true, false, false),
            select_auto_print_target(5, None, false, None, true, true, true, false, true),
        ];
        assert!(blocked.into_iter().all(|target| target.is_none()));
    }

    #[test]
    fn preserves_the_main_weighing_auto_print_route() {
        assert_eq!(
            select_auto_print_target(0, Some(7), true, None, false, false, false, true, false,),
            Some(AutoPrintTarget::ProductionPack(7))
        );
        assert_eq!(
            select_auto_print_target(0, Some(7), false, None, false, false, false, false, true,),
            None
        );
    }

    #[test]
    fn enabling_after_startup_arms_an_empty_scale_without_a_second_timer() {
        let mut gate = AutoPrintGate::new(false);
        gate.set_enabled(true, 0.0);
        assert_eq!(gate.observe(0.170, true, true), AutoPrintDecision::Fire);

        let mut occupied = AutoPrintGate::new(false);
        occupied.rearm_hold = Duration::ZERO;
        occupied.set_enabled(true, 0.170);
        assert_eq!(occupied.observe(0.170, true, true), AutoPrintDecision::None);
        assert_eq!(
            occupied.observe(0.0, true, true),
            AutoPrintDecision::Rearmed
        );
        assert_eq!(occupied.observe(0.170, true, true), AutoPrintDecision::Fire);
    }

    #[test]
    fn waits_for_startup_readiness_and_stable_positive_weight() {
        let mut gate = AutoPrintGate::new(true);

        assert_eq!(gate.observe(3.406, true, true), AutoPrintDecision::None);
        gate.mark_ready();
        assert_eq!(gate.observe(3.406, false, true), AutoPrintDecision::None);
        assert_eq!(gate.observe(0.010, true, true), AutoPrintDecision::None);
        assert_eq!(gate.observe(3.406, true, true), AutoPrintDecision::Fire);
    }

    #[test]
    fn fires_once_per_placed_product_and_rearms_below_threshold() {
        let mut gate = AutoPrintGate::new(true);
        gate.mark_ready();
        gate.rearm_hold = Duration::ZERO;

        assert_eq!(gate.observe(1.250, true, true), AutoPrintDecision::Fire);
        gate.finish_print();
        assert_eq!(gate.observe(1.250, true, true), AutoPrintDecision::None);
        assert_eq!(gate.observe(0.009, true, true), AutoPrintDecision::Rearmed);
        assert_eq!(gate.observe(1.250, true, true), AutoPrintDecision::Fire);
    }

    #[test]
    fn manual_print_marks_current_product_as_already_printed() {
        let mut gate = AutoPrintGate::new(true);
        gate.mark_ready();
        gate.rearm_hold = Duration::ZERO;

        assert!(gate.begin_manual_print(2.100));
        assert!(!gate.begin_manual_print(2.100));
        gate.finish_print();
        assert_eq!(gate.observe(2.100, true, true), AutoPrintDecision::None);
        assert_eq!(gate.observe(0.0, true, true), AutoPrintDecision::Rearmed);
        gate.set_enabled(false, 0.0);
        assert_eq!(gate.observe(2.100, true, true), AutoPrintDecision::None);
        gate.set_enabled(true, 2.100);
        assert_eq!(gate.observe(2.100, true, true), AutoPrintDecision::None);
        assert_eq!(gate.observe(0.0, true, true), AutoPrintDecision::Rearmed);
        assert_eq!(gate.observe(2.100, true, true), AutoPrintDecision::Fire);
    }

    #[test]
    fn disabled_or_unprintable_gate_never_fires() {
        let mut disabled = AutoPrintGate::new(false);
        disabled.mark_ready();
        assert_eq!(disabled.observe(4.000, true, true), AutoPrintDecision::None);

        let mut missing_template = AutoPrintGate::new(true);
        missing_template.mark_ready();
        assert_eq!(
            missing_template.observe(4.000, true, false),
            AutoPrintDecision::None
        );
    }

    #[test]
    fn single_zero_frame_between_stable_readings_does_not_rearm() {
        let mut gate = AutoPrintGate::new(true);
        gate.mark_ready();

        assert_eq!(gate.observe(1.250, true, true), AutoPrintDecision::Fire);
        gate.finish_print();
        // One dropped frame between stable readings must not rearm the gate.
        assert_eq!(gate.observe(0.0, true, true), AutoPrintDecision::None);
        assert_eq!(gate.observe(1.250, true, true), AutoPrintDecision::None);
        // A scale that reads empty for the whole hold window rearms.
        gate.below_since = Some(Instant::now() - Duration::from_millis(2_000));
        assert_eq!(gate.observe(0.0, true, true), AutoPrintDecision::Rearmed);
        assert_eq!(gate.observe(1.250, true, true), AutoPrintDecision::Fire);
    }

    #[test]
    fn failed_auto_pack_latches_until_scale_is_cleared() {
        let mut gate = AutoPrintGate::new(true);
        gate.mark_ready();

        assert_eq!(gate.observe(2.400, true, true), AutoPrintDecision::Fire);
        gate.finish_print();
        gate.mark_failed();
        // Printer still down and the scale blips a zero: no new attempts and
        // the latch survives until the scale reads empty for the hold window.
        assert_eq!(gate.observe(0.0, true, true), AutoPrintDecision::None);
        assert_eq!(gate.observe(2.400, true, true), AutoPrintDecision::None);
        // The operator clears the scale: sustained empty readings clear the
        // latch and the next product can print.
        gate.below_since = Some(Instant::now() - Duration::from_millis(2_000));
        assert_eq!(gate.observe(0.0, true, true), AutoPrintDecision::Rearmed);
        assert_eq!(gate.observe(2.400, true, true), AutoPrintDecision::Fire);
    }

    #[test]
    fn disabling_the_gate_clears_the_failure_latch() {
        let mut gate = AutoPrintGate::new(true);
        gate.mark_ready();
        gate.rearm_hold = Duration::ZERO;
        assert_eq!(gate.observe(2.400, true, true), AutoPrintDecision::Fire);
        gate.finish_print();
        gate.mark_failed();
        gate.set_enabled(false, 2.400);
        gate.set_enabled(true, 2.400);
        assert_eq!(gate.observe(2.400, true, true), AutoPrintDecision::None);
    }
}

#[cfg(test)]
mod update_error_presentation_tests {
    use super::{redact_update_links, update_user_message};

    #[test]
    fn hides_manifest_endpoint_from_operator_messages() {
        let raw = "request update manifest: error sending request for url (https://example.invalid/releases/latest/download/native-latest.json)";
        let message = update_user_message(raw);
        assert_eq!(
            message,
            "Нет связи с сервером обновлений. Проверьте подключение к сети и повторите попытку."
        );
        assert!(!message.contains("http"));
        assert!(!message.contains("example.invalid"));
    }

    #[test]
    fn redacts_links_from_unclassified_updater_errors() {
        let message = redact_update_links(
            "unexpected response from https://example.invalid/private/path; retry",
        );
        assert_eq!(
            message,
            "unexpected response from [адрес сервера скрыт]; retry"
        );
    }
}
