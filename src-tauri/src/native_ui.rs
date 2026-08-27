use crate::ingress::IngressState;
#[cfg(feature = "slint-ui")]
use crate::native_print::{NativePrintOutcome, NativePrintService, PackPrintRequest};
use crate::operational::{OpenEntitiesSummary, OperationalState};
use crate::persisted::PersistedState;
use crate::printer::{
    list_system_printers, query_printer_status, DurablePrintJobRecord, DurableQueueSummary,
    PrinterTransportState,
};
use crate::runtime_events::{NativeRuntimeEvent, RuntimeEventSink};
use crate::scale::{
    list_serial_ports, protocol_catalog, ScaleConfig, ScaleProbeResult, ScaleState,
};
use crate::session::SessionState;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::UNIX_EPOCH;

pub use crate::runtime_events::NativeRuntimeEvent as Event;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUiStation {
    pub uuid: Option<String>,
    pub number: Option<String>,
    pub name: Option<String>,
    pub last_sync_time: Option<String>,
    pub provisioned: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUiProduct {
    pub id: i64,
    pub name: String,
    pub article: String,
    pub expiration_days: i64,
    pub portion_container_id: Option<i64>,
    pub portion_container_name: String,
    pub box_container_id: Option<i64>,
    pub box_container_name: String,
    pub portion_tare_grams: f64,
    pub box_tare_grams: f64,
    pub close_box_counter: i64,
    pub pack_label_id: Option<i64>,
    pub pack_label_name: String,
    pub box_label_id: Option<i64>,
    pub box_label_name: String,
    pub pallet_label_id: Option<i64>,
    pub pallet_label_name: String,
    pub extra_data_summary: String,
    pub fixed_weight: bool,
    pub fixed_weight_grams: f64,
    pub min_weight_grams: f64,
    pub max_weight_grams: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCatalogSnapshot {
    pub products: Vec<NativeUiProduct>,
    pub selected_product_id: Option<i64>,
    pub total_matching: i64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLicenseStatus {
    pub licensed: bool,
    pub mode: String,
    pub edition: String,
    pub customer: String,
    pub expires: String,
    pub expired: bool,
    pub max_stations: Option<i64>,
    pub demo_max_stations: Option<i64>,
    pub license_id: String,
    pub features: Vec<String>,
    pub machine_id: String,
    pub strict: bool,
    pub signature_valid: bool,
    pub machine_ok: bool,
    pub stations_used: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeServerLicenseSnapshot {
    pub station: NativeUiStation,
    pub server_address: String,
    pub server_configured: bool,
    pub server_online: bool,
    pub server_compatible: bool,
    pub server_version: String,
    pub min_client_version: String,
    pub compatibility_reason: String,
    pub license_online: bool,
    pub license: Option<NativeLicenseStatus>,
    pub checked_at_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUiContainer {
    pub id: i64,
    pub name: String,
    pub weight_grams: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUiOperator {
    pub uuid: String,
    pub full_name: String,
    pub short_code: String,
    pub has_pin: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUiCounters {
    pub last_pack_number: String,
    pub last_box_number: String,
    pub total_units: i64,
    pub total_boxes: i64,
    pub boxes_in_pallet: i64,
    pub units_in_box: i64,
    pub box_net_weight: f64,
    pub current_box_id: Option<i64>,
    pub current_box_number: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUiOpenEntities {
    pub open_box_count: i64,
    pub open_box_number: Option<String>,
    pub open_pallet_count: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWeighingSnapshot {
    pub station: NativeUiStation,
    pub products: Vec<NativeUiProduct>,
    pub containers: Vec<NativeUiContainer>,
    pub operators: Vec<NativeUiOperator>,
    pub current_operator: Option<NativeUiOperator>,
    pub last_operator_uuid: Option<String>,
    pub selected_product_id: Option<i64>,
    pub counters: NativeUiCounters,
    pub open_entities: NativeUiOpenEntities,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFixedWeightSnapshot {
    pub products: Vec<NativeUiProduct>,
    pub selected_product_id: Option<i64>,
    pub counters: NativeUiCounters,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProductionPrintJob {
    pub id: i64,
    pub job_id: i64,
    pub product_id: i64,
    pub product_name: String,
    pub product_article: String,
    pub quantity: f64,
    pub quantity_unit: String,
    pub batch_number: String,
    pub marking_date: Option<String>,
    pub printed_quantity: f64,
    pub status: String,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrintJobsSnapshot {
    pub jobs: Vec<NativeProductionPrintJob>,
    pub selected_job_id: Option<i64>,
    pub selected_product: Option<NativeUiProduct>,
    pub counters: NativeUiCounters,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFixedBatchOutcome {
    pub requested: i64,
    pub completed: i64,
    pub cancelled: bool,
    pub last_print: Option<NativePrintOutcome>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobPrintOutcome {
    pub job_id: i64,
    pub printed_quantity: f64,
    pub total_quantity: f64,
    pub status: String,
    pub print: NativePrintOutcome,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrinterQueueSnapshot {
    pub summary: DurableQueueSummary,
    pub jobs: Vec<DurablePrintJobRecord>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrinterDiagnostic {
    pub role: String,
    pub role_label: String,
    pub printer_id: String,
    pub printer_name: String,
    pub endpoint: String,
    pub protocol: String,
    pub connection: String,
    pub reachable: bool,
    pub status: String,
    pub details: String,
    pub queried_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrinterChoice {
    pub value: String,
    pub label: String,
    pub details: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrinterRoleSettings {
    pub role: String,
    pub role_label: String,
    pub description: String,
    pub id: String,
    pub active: bool,
    pub name: String,
    pub connection: String,
    pub protocol: String,
    pub compatibility_mode: String,
    pub effective_profile: String,
    pub endpoint: String,
    pub ip: String,
    pub port: i32,
    pub serial_port: String,
    pub baud_rate: i32,
    pub driver_name: String,
    pub dpi: i32,
    pub ram_cache: String,
    pub z64: bool,
    pub persistent_connection: bool,
    pub darkness: Option<f64>,
    pub print_speed: Option<f64>,
    pub gap_mm: Option<f64>,
    pub width_mm: Option<f64>,
    pub height_mm: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativePrinterRoleSettingsInput {
    pub role: String,
    pub active: bool,
    pub name: String,
    pub connection: String,
    pub protocol: String,
    pub compatibility_mode: String,
    pub ip: String,
    pub port: i32,
    pub serial_port: String,
    pub baud_rate: i32,
    pub driver_name: String,
    pub dpi: i32,
    pub ram_cache: String,
    pub z64: bool,
    pub persistent_connection: bool,
    pub darkness: Option<f64>,
    pub print_speed: Option<f64>,
    pub gap_mm: Option<f64>,
    pub width_mm: Option<f64>,
    pub height_mm: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrinterSettingsSnapshot {
    pub auto_print_on_stable: bool,
    pub roles: Vec<NativePrinterRoleSettings>,
    pub system_printers: Vec<NativePrinterChoice>,
    pub serial_ports: Vec<NativePrinterChoice>,
    pub catalog_status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrinterCapability {
    pub role: String,
    pub detected: bool,
    pub applied: bool,
    pub status: String,
    pub details: String,
    pub protocol: String,
    pub dpi: i32,
    pub recommended_profile: String,
    pub endpoint_key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeScaleProtocolSettings {
    pub id: String,
    pub name: String,
    pub description: String,
    pub polling_required: bool,
    pub default_baud_rate: i32,
    pub serial_format: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeScaleSettingsSnapshot {
    pub connection_type: String,
    pub protocol_id: String,
    pub protocol_name: String,
    pub protocol_description: String,
    pub endpoint: String,
    pub serial_path: String,
    pub baud_rate: i32,
    pub host: String,
    pub port: i32,
    pub polling_interval: i32,
    pub stability_count: i32,
    pub runtime_status: String,
    pub protocols: Vec<NativeScaleProtocolSettings>,
    pub serial_ports: Vec<NativePrinterChoice>,
    pub catalog_status: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeScaleSettingsInput {
    pub connection_type: String,
    pub protocol_id: String,
    pub serial_path: String,
    pub baud_rate: i32,
    pub host: String,
    pub port: i32,
    pub polling_interval: i32,
    pub stability_count: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct FileRevision {
    length: u64,
    modified_nanos: u128,
    present: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeUiRevision {
    database: FileRevision,
    database_wal: FileRevision,
    printer_config: FileRevision,
}

impl NativeUiRevision {
    pub fn data_changed_from(&self, previous: &Self) -> bool {
        self.database != previous.database || self.database_wal != previous.database_wal
    }

    pub fn printer_changed_from(&self, previous: &Self) -> bool {
        self.printer_config != previous.printer_config
    }
}

#[derive(Clone)]
pub struct NativeUiRuntime {
    scale: Arc<ScaleState>,
    printer: PrinterTransportState,
    events: RuntimeEventSink,
    ingress: Option<Arc<IngressState>>,
    persisted: Option<Arc<PersistedState>>,
    operational: Option<OperationalState>,
    session: Option<Arc<SessionState>>,
    network_client: Option<reqwest::blocking::Client>,
    #[cfg(feature = "slint-ui")]
    production_printer: Option<NativePrintService>,
    fixed_batch_active: Arc<AtomicBool>,
    fixed_batch_cancel: Arc<AtomicBool>,
}

impl NativeUiRuntime {
    pub fn new<F>(callback: F) -> Self
    where
        F: Fn(NativeRuntimeEvent) + Send + Sync + 'static,
    {
        Self {
            scale: Arc::new(ScaleState::new()),
            printer: PrinterTransportState::new(),
            events: RuntimeEventSink::callback(callback),
            ingress: None,
            persisted: None,
            operational: None,
            session: None,
            network_client: None,
            #[cfg(feature = "slint-ui")]
            production_printer: None,
            fixed_batch_active: Arc::new(AtomicBool::new(false)),
            fixed_batch_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_database<F>(database_path: &Path, callback: F) -> Result<Self, String>
    where
        F: Fn(NativeRuntimeEvent) + Send + Sync + 'static,
    {
        let data_dir = database_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("database path has no parent: {}", database_path.display()))?;
        Self::with_persisted(PersistedState::for_data_dir(data_dir), callback)
    }

    pub fn with_persisted<F>(persisted: PersistedState, callback: F) -> Result<Self, String>
    where
        F: Fn(NativeRuntimeEvent) + Send + Sync + 'static,
    {
        let persisted = Arc::new(persisted);
        let events = RuntimeEventSink::callback(callback);
        let ingress = Arc::new(IngressState::new());
        let operational = OperationalState::new(&persisted)?;
        let session = Arc::new(SessionState::new(persisted.data_dir().to_path_buf()));
        let printer = PrinterTransportState::with_database(&persisted.database_path())?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let network_client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(3))
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .pool_max_idle_per_host(1)
            .build()
            .map_err(|error| format!("failed to build native UI HTTP client: {error}"))?;
        #[cfg(feature = "slint-ui")]
        let production_printer = NativePrintService::new(persisted.data_dir().to_path_buf());
        let recovered_print_jobs = printer.recover_pending_with_sink(events.clone())?;
        if recovered_print_jobs > 0 {
            events.emit(
                "printer-durable-recovery",
                json!({ "scheduled": recovered_print_jobs }),
            );
        }
        Ok(Self {
            scale: Arc::new(ScaleState::new()),
            printer,
            events,
            ingress: Some(ingress),
            persisted: Some(persisted),
            operational: Some(operational),
            session: Some(session),
            network_client: Some(network_client),
            #[cfg(feature = "slint-ui")]
            production_printer: Some(production_printer),
            fixed_batch_active: Arc::new(AtomicBool::new(false)),
            fixed_batch_cancel: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn revision(&self) -> Result<NativeUiRevision, String> {
        let persisted = self.persisted()?;
        let database = persisted.database_path();
        let mut wal = database.as_os_str().to_os_string();
        wal.push("-wal");
        Ok(NativeUiRevision {
            database: file_revision(&database),
            database_wal: file_revision(Path::new(&wal)),
            printer_config: file_revision(&persisted.data_dir().join("printer-config.json")),
        })
    }

    pub fn printer_config(&self) -> Result<Value, String> {
        Ok(self.persisted()?.load_printer_config())
    }

    pub fn start_station_ingress(&self) -> Result<(), String> {
        let persisted = self
            .persisted
            .as_ref()
            .cloned()
            .ok_or_else(|| "production persisted state is not configured".to_owned())?;
        let ingress = self
            .ingress
            .as_ref()
            .ok_or_else(|| "station ingress is not configured".to_owned())?;
        ingress.start_with_sink(
            persisted,
            self.events.clone(),
            env!("CARGO_PKG_VERSION").to_owned(),
            || {},
        )?;
        self.events.emit(
            "ingress-status",
            json!({ "status": "listening", "address": "0.0.0.0:5556" }),
        );
        Ok(())
    }

    pub fn ingress_summary(&self) -> Result<Value, String> {
        let ingress = self
            .ingress
            .as_ref()
            .ok_or_else(|| "station ingress is not configured".to_owned())?;
        serde_json::to_value(ingress.summary())
            .map_err(|error| format!("serialize ingress summary: {error}"))
    }

    #[cfg(feature = "slint-ui")]
    pub fn warmup_production_assets(&self) -> Result<Value, String> {
        let static_fonts = crate::native_raster::warmup_static_assets();
        let config = self.printer_config()?;
        let mut results = serde_json::Map::new();
        for (role, key) in [("pack", "packPrinter"), ("box", "boxPrinter")] {
            let Some(device) = warmup_role_config(&config, key) else {
                results.insert(role.to_owned(), Value::String("unconfigured".to_owned()));
                continue;
            };
            if device.get("active").and_then(Value::as_bool) == Some(false) {
                results.insert(role.to_owned(), Value::String("unconfigured".to_owned()));
                continue;
            }
            // Startup probes are best-effort: return their state to the UI without
            // raising an operator-blocking modal before an actual print attempt.
            let status = match self
                .printer
                .warmup_with_sink(RuntimeEventSink::callback(|_| {}), device)
            {
                Ok(_) => "ready",
                Err(_) => "unreachable",
            };
            results.insert(role.to_owned(), Value::String(status.to_owned()));
        }
        Ok(json!({
            "ok": true,
            "staticFonts": static_fonts,
            "backgroundMode": "inline-rust",
            "results": results,
        }))
    }

    pub fn connect_scale(&self, config: Value) -> Result<(), String> {
        self.scale.connect_with_sink(self.events.clone(), config)
    }

    pub fn disconnect_scale(&self) {
        self.scale.disconnect_with_sink(&self.events);
    }

    pub fn scale_status(&self) -> &'static str {
        self.scale.status()
    }

    pub fn scale_summary(&self) -> Result<Value, String> {
        serde_json::to_value(self.scale.summary())
            .map_err(|error| format!("serialize scale summary: {error}"))
    }

    pub fn scale_settings_snapshot(&self) -> Result<NativeScaleSettingsSnapshot, String> {
        let config = self.persisted()?.load_scale_config();
        let protocols = protocol_catalog()
            .into_iter()
            .map(|protocol| NativeScaleProtocolSettings {
                id: protocol.id.to_owned(),
                name: protocol.name.to_owned(),
                description: protocol.description.to_owned(),
                polling_required: protocol.polling_required,
                default_baud_rate: protocol.default_baud_rate as i32,
                serial_format: protocol.serial_format,
            })
            .collect::<Vec<_>>();
        let protocol_id =
            value_string(config.get("protocolId")).unwrap_or_else(|| "simulator".to_owned());
        let selected_protocol = protocols
            .iter()
            .find(|protocol| protocol.id == protocol_id)
            .or_else(|| protocols.iter().find(|protocol| protocol.id == "generic"));
        let default_baud_rate = selected_protocol
            .map(|protocol| protocol.default_baud_rate)
            .unwrap_or(9_600);
        let (serial_ports, catalog_status) = match list_serial_ports() {
            Ok(ports) => (
                ports
                    .into_iter()
                    .map(|port| NativePrinterChoice {
                        value: port.path.clone(),
                        label: port.path,
                        details: port
                            .product
                            .or(port.manufacturer)
                            .unwrap_or_else(|| "Последовательный порт".to_owned()),
                    })
                    .collect(),
                "Serial-порты обновлены".to_owned(),
            ),
            Err(error) => (Vec::new(), format!("Serial: {error}")),
        };
        Ok(NativeScaleSettingsSnapshot {
            connection_type: value_string(config.get("type"))
                .unwrap_or_else(|| "simulator".to_owned()),
            protocol_id,
            protocol_name: selected_protocol
                .map(|protocol| protocol.name.clone())
                .unwrap_or_else(|| "Generic Text".to_owned()),
            protocol_description: selected_protocol
                .map(|protocol| protocol.description.clone())
                .unwrap_or_else(|| "Универсальный текстовый протокол".to_owned()),
            endpoint: scale_endpoint(&config),
            serial_path: value_string(config.get("path")).unwrap_or_default(),
            baud_rate: value_i64(config.get("baudRate")).unwrap_or(default_baud_rate as i64) as i32,
            host: value_string(config.get("host")).unwrap_or_default(),
            port: value_i64(config.get("port")).unwrap_or(4_001) as i32,
            polling_interval: value_i64(config.get("pollingInterval")).unwrap_or(250) as i32,
            stability_count: value_i64(config.get("stabilityCount")).unwrap_or(4) as i32,
            runtime_status: self.scale.status().to_owned(),
            protocols,
            serial_ports,
            catalog_status,
        })
    }

    pub fn save_scale_settings(
        &self,
        input: NativeScaleSettingsInput,
    ) -> Result<NativeScaleSettingsSnapshot, String> {
        let config = self.build_scale_config(&input)?;
        self.persisted()?.save_scale_config(config.clone())?;
        self.scale
            .connect_with_sink(self.events.clone(), config.clone())?;
        self.events.emit("scale-config-updated", config);
        self.events.log(
            "scale",
            "INFO",
            "scale config persisted and connected by native Slint runtime",
        );
        self.scale_settings_snapshot()
    }

    pub fn test_scale_settings(
        &self,
        input: NativeScaleSettingsInput,
    ) -> Result<ScaleProbeResult, String> {
        let config = self.build_scale_config(&input)?;
        let outcome = self.scale.test_config_with_sink(&self.events, config)?;
        self.events.log(
            "scale",
            if outcome.valid_frame { "INFO" } else { "WARN" },
            &format!("scale settings probe: {}", outcome.details),
        );
        Ok(outcome)
    }

    fn build_scale_config(&self, input: &NativeScaleSettingsInput) -> Result<Value, String> {
        validate_scale_settings_input(input)?;
        let mut config = self.persisted()?.load_scale_config();
        let object = config
            .as_object_mut()
            .ok_or_else(|| "конфигурация весов повреждена".to_owned())?;
        let protocol_id = if input.connection_type == "simulator" {
            "simulator"
        } else {
            input.protocol_id.as_str()
        };
        set_string(object, "type", &input.connection_type);
        set_string(object, "protocolId", protocol_id);
        set_optional_string(object, "path", &input.serial_path);
        set_optional_string(object, "host", &input.host);
        object.insert("baudRate".to_owned(), json!(input.baud_rate));
        object.insert("port".to_owned(), json!(input.port));
        object.insert("pollingInterval".to_owned(), json!(input.polling_interval));
        object.insert("stabilityCount".to_owned(), json!(input.stability_count));
        ScaleConfig::from_value(config.clone())?;
        Ok(config)
    }

    pub fn send_raw(&self, config: Value, data: Vec<u8>) -> Result<Value, String> {
        let receipt = self
            .printer
            .submit_generated_with_sink(self.events.clone(), config, data)?;
        serde_json::to_value(receipt).map_err(|error| format!("serialize print receipt: {error}"))
    }

    pub fn printer_summary(&self) -> Result<Value, String> {
        serde_json::to_value(self.printer.summary())
            .map_err(|error| format!("serialize printer summary: {error}"))
    }

    pub fn printer_queue_snapshot(
        &self,
        limit: usize,
    ) -> Result<NativePrinterQueueSnapshot, String> {
        let limit = limit.clamp(1, 200);
        Ok(NativePrinterQueueSnapshot {
            summary: self.printer.durable_summary()?,
            jobs: self.printer.durable_jobs(None, Some(limit))?,
        })
    }

    pub fn retry_print_job(&self, job_id: &str) -> Result<Value, String> {
        let receipt = self
            .printer
            .retry_durable_with_sink(self.events.clone(), job_id)?;
        serde_json::to_value(receipt)
            .map_err(|error| format!("serialize durable retry receipt: {error}"))
    }

    pub fn cancel_print_job(&self, job_id: &str) -> Result<DurablePrintJobRecord, String> {
        self.printer
            .cancel_durable_with_sink(self.events.clone(), job_id)
    }

    pub fn probe_configured_printers(&self) -> Result<Vec<NativePrinterDiagnostic>, String> {
        let config = self.printer_config()?;
        Ok([
            ("pack", "Этикетка упаковки", "packPrinter"),
            ("box", "Этикетка короба", "boxPrinter"),
            ("pallet", "Паллетный лист", "palletPrinter"),
        ]
        .into_iter()
        .map(|(role, role_label, key)| probe_printer_role(&config, role, role_label, key))
        .collect())
    }

    pub fn printer_settings_snapshot(&self) -> Result<NativePrinterSettingsSnapshot, String> {
        let config = self.printer_config()?;
        let roles = printer_role_catalog()
            .into_iter()
            .map(|(role, role_label, description)| {
                printer_role_settings(&config, role, role_label, description)
            })
            .collect();
        let mut warnings = Vec::new();
        let system_printers = match list_system_printers() {
            Ok(printers) => printers
                .into_iter()
                .map(|printer| NativePrinterChoice {
                    value: printer.name,
                    label: printer.display_name,
                    details: if printer.is_default {
                        "Системный по умолчанию".to_owned()
                    } else if printer.description.trim().is_empty() {
                        "Windows spooler".to_owned()
                    } else {
                        printer.description
                    },
                })
                .collect(),
            Err(error) => {
                warnings.push(format!("Windows: {error}"));
                Vec::new()
            }
        };
        let serial_ports = match list_serial_ports() {
            Ok(ports) => ports
                .into_iter()
                .map(|port| NativePrinterChoice {
                    value: port.path.clone(),
                    label: port.path,
                    details: port
                        .product
                        .or(port.manufacturer)
                        .unwrap_or_else(|| "Последовательный порт".to_owned()),
                })
                .collect(),
            Err(error) => {
                warnings.push(format!("Serial: {error}"));
                Vec::new()
            }
        };
        Ok(NativePrinterSettingsSnapshot {
            auto_print_on_stable: config
                .get("autoPrintOnStable")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            roles,
            system_printers,
            serial_ports,
            catalog_status: if warnings.is_empty() {
                "Системные устройства обновлены".to_owned()
            } else {
                warnings.join(" · ")
            },
        })
    }

    pub fn save_printer_role_settings(
        &self,
        input: NativePrinterRoleSettingsInput,
        auto_print_on_stable: bool,
    ) -> Result<NativePrinterSettingsSnapshot, String> {
        let config = self.build_printer_config(&input, auto_print_on_stable, false)?;
        self.commit_printer_config(config)?;
        self.printer_settings_snapshot()
    }

    pub fn detect_and_apply_printer_settings(
        &self,
        input: NativePrinterRoleSettingsInput,
        auto_print_on_stable: bool,
    ) -> Result<NativePrinterCapability, String> {
        let mut config = self.build_printer_config(&input, auto_print_on_stable, true)?;
        let role = validated_printer_role(&input.role)?;
        let device = config
            .get(role)
            .cloned()
            .ok_or_else(|| format!("отсутствует конфигурация {role}"))?;
        let endpoint_key = printer_endpoint_key(&device);
        let protocol = detected_protocol(&device);
        let dpi = normalized_dpi(value_i64(device.get("dpi")).unwrap_or(203) as i32);
        let recommended_profile = compatible_profile(&protocol).to_owned();
        match query_printer_status(device) {
            Ok(report) => {
                let details = if report.details.is_empty() {
                    "Транспорт доступен".to_owned()
                } else {
                    report.details.join(" · ")
                };
                let applied = report.reachable && !recommended_profile.is_empty();
                if applied {
                    let target = config
                        .get_mut(role)
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| format!("конфигурация {role} повреждена"))?;
                    target.insert(
                        "detectedProfileId".to_owned(),
                        Value::String(recommended_profile.clone()),
                    );
                    target.insert(
                        "detectedEndpointKey".to_owned(),
                        Value::String(endpoint_key.clone()),
                    );
                    target.insert("detectedProfileAt".to_owned(), json!(unix_ms()));
                    self.commit_printer_config(config)?;
                }
                Ok(NativePrinterCapability {
                    role: role.to_owned(),
                    detected: report.reachable,
                    applied,
                    status: report.status,
                    details,
                    protocol,
                    dpi,
                    recommended_profile,
                    endpoint_key,
                })
            }
            Err(error) => Ok(NativePrinterCapability {
                role: role.to_owned(),
                detected: false,
                applied: false,
                status: "error".to_owned(),
                details: error,
                protocol,
                dpi,
                recommended_profile,
                endpoint_key,
            }),
        }
    }

    #[cfg(feature = "slint-ui")]
    pub fn test_printer_settings(
        &self,
        input: NativePrinterRoleSettingsInput,
    ) -> Result<Value, String> {
        let config = self.build_printer_config(&input, false, true)?;
        let role = validated_printer_role(&input.role)?;
        let mut device = config
            .get(role)
            .cloned()
            .ok_or_else(|| format!("отсутствует конфигурация {role}"))?;
        device["active"] = Value::Bool(true);
        let receipt =
            self.production_printer()?
                .test_printer(&self.printer, &self.events, device, role)?;
        serde_json::to_value(receipt)
            .map_err(|error| format!("serialize settings test-print receipt: {error}"))
    }

    fn build_printer_config(
        &self,
        input: &NativePrinterRoleSettingsInput,
        auto_print_on_stable: bool,
        require_target: bool,
    ) -> Result<Value, String> {
        validate_printer_settings_input(input, require_target)?;
        let role = validated_printer_role(&input.role)?;
        let mut config = self.printer_config()?;
        let device = config
            .get_mut(role)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| format!("конфигурация {role} повреждена"))?;
        let previous_signature = printer_detection_signature(&Value::Object(device.clone()));
        if device
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            set_string(
                device,
                "id",
                &format!("native-{}", role.trim_end_matches("Printer")),
            );
        }
        set_string(device, "name", input.name.trim());
        set_string(device, "connection", &input.connection);
        set_string(device, "protocol", &input.protocol);
        set_string(device, "compatibilityMode", &input.compatibility_mode);
        device.insert("active".to_owned(), Value::Bool(input.active));
        set_optional_string(device, "ip", &input.ip);
        set_optional_string(device, "serialPort", &input.serial_port);
        set_optional_string(device, "driverName", &input.driver_name);
        device.insert("port".to_owned(), json!(input.port));
        device.insert("baudRate".to_owned(), json!(input.baud_rate));
        device.insert("dpi".to_owned(), json!(input.dpi));
        set_string(device, "ramCache", &input.ram_cache);
        device.insert("z64".to_owned(), Value::Bool(input.z64));
        device.insert(
            "persistentConnection".to_owned(),
            Value::Bool(input.persistent_connection),
        );
        set_optional_number(device, "darkness", input.darkness);
        set_optional_number(device, "printSpeed", input.print_speed);
        set_optional_number(device, "gapMm", input.gap_mm);
        set_optional_number(device, "widthMm", input.width_mm);
        set_optional_number(device, "heightMm", input.height_mm);
        let current_signature = printer_detection_signature(&Value::Object(device.clone()));
        if current_signature != previous_signature {
            device.remove("detectedProfileId");
            device.remove("detectedEndpointKey");
            device.remove("detectedProfileAt");
        }
        config["autoPrintOnStable"] = Value::Bool(auto_print_on_stable);
        Ok(config)
    }

    fn commit_printer_config(&self, config: Value) -> Result<(), String> {
        self.persisted()?.save_printer_config(config.clone())?;
        self.printer.reconfigure(&config);
        self.events.emit("printer-config-updated", config);
        self.events.log(
            "printer",
            "INFO",
            "printer config persisted by native Slint runtime",
        );
        Ok(())
    }

    pub fn production_available(&self) -> bool {
        self.persisted.is_some() && self.operational.is_some() && self.session.is_some()
    }

    fn station_snapshot(&self) -> Result<NativeUiStation, String> {
        let persisted = self.persisted()?;
        let database_station = self.operational()?.station_info()?;
        let identity = persisted.load_identity().unwrap_or(Value::Null);
        let uuid = value_string(identity.get("station_uuid"))
            .or_else(|| value_string(database_station.get("uuid_client")));
        let number = value_string(identity.get("station_number"))
            .or_else(|| value_string(database_station.get("station_number")));
        Ok(NativeUiStation {
            provisioned: uuid.is_some() && number.is_some(),
            uuid,
            number,
            name: value_string(identity.get("station_name"))
                .or_else(|| value_string(database_station.get("station_name"))),
            last_sync_time: value_string(identity.get("last_sync_time")),
        })
    }
    pub fn products(&self, search: Option<&str>) -> Result<Vec<NativeUiProduct>, String> {
        self.operational()?
            .products(search, false)?
            .iter()
            .map(NativeUiProduct::try_from)
            .collect()
    }

    pub fn catalog_snapshot(
        &self,
        selected_product_id: Option<i64>,
        search: Option<&str>,
    ) -> Result<NativeCatalogSnapshot, String> {
        let products = self.products(search)?;
        let total_matching = self.operational()?.product_count(search, false)?;
        let selected_product_id = selected_product_id
            .filter(|id| products.iter().any(|product| product.id == *id))
            .or_else(|| products.first().map(|product| product.id));
        Ok(NativeCatalogSnapshot {
            truncated: total_matching > products.len() as i64,
            products,
            selected_product_id,
            total_matching,
        })
    }

    pub fn server_license_snapshot(&self) -> Result<NativeServerLicenseSnapshot, String> {
        let persisted = self.persisted()?;
        let station = self.station_snapshot()?;
        let identity = persisted.load_identity().unwrap_or(Value::Null);
        let configured = value_string(persisted.load_printer_config().get("serverIp"))
            .or_else(|| value_string(identity.get("server_url")))
            .unwrap_or_default();
        let server_address = canonical_server_address(&configured).unwrap_or(configured);
        let base_url = native_server_base_url(&server_address);
        let mut snapshot = NativeServerLicenseSnapshot {
            station,
            server_address,
            server_configured: base_url.is_some(),
            server_online: false,
            server_compatible: true,
            server_version: String::new(),
            min_client_version: String::new(),
            compatibility_reason: String::new(),
            license_online: false,
            license: None,
            checked_at_ms: unix_ms(),
        };
        let (Some(client), Some(base_url)) = (self.network_client.as_ref(), base_url) else {
            return Ok(snapshot);
        };

        if let Some(station_uuid) = snapshot.station.uuid.as_deref() {
            let ping = client
                .get(format!("{base_url}/stations/ping/"))
                .query(&[("station_uuid", station_uuid)])
                .send()
                .and_then(reqwest::blocking::Response::error_for_status)
                .and_then(reqwest::blocking::Response::json::<Value>);
            if let Ok(ping) = ping {
                snapshot.server_online =
                    ping.get("status").and_then(Value::as_str) == Some("online");
                snapshot.server_version =
                    value_string(ping.get("server_version")).unwrap_or_default();
                snapshot.min_client_version =
                    value_string(ping.get("min_client_version")).unwrap_or_default();
                if snapshot.server_online && !snapshot.min_client_version.is_empty() {
                    snapshot.server_compatible =
                        !semver_is_less(env!("CARGO_PKG_VERSION"), &snapshot.min_client_version)
                            .unwrap_or(false);
                    if !snapshot.server_compatible {
                        snapshot.compatibility_reason = format!(
                            "Клиент {} ниже минимальной версии {}",
                            env!("CARGO_PKG_VERSION"),
                            snapshot.min_client_version
                        );
                    }
                }
            }
        }

        let license = client
            .get(format!("{base_url}/license/"))
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .and_then(reqwest::blocking::Response::json::<Value>);
        if let Ok(license) = license {
            if license.is_object() {
                snapshot.license_online = true;
                snapshot.license = Some(native_license_status(&license));
            }
        }
        snapshot.checked_at_ms = unix_ms();
        Ok(snapshot)
    }

    pub fn save_server_address(
        &self,
        server_address: &str,
    ) -> Result<NativeServerLicenseSnapshot, String> {
        let trimmed: String = server_address.trim().chars().take(512).collect();
        let canonical = if trimmed.is_empty() {
            String::new()
        } else {
            canonical_server_address(&trimmed).ok_or_else(|| {
                "Адрес сервера должен быть HTTP(S) URL, IP или host:port".to_owned()
            })?
        };
        self.persisted()?.update_server_ip(&canonical)?;
        self.events
            .emit("server-config-updated", json!({ "serverIp": canonical }));
        self.events.log(
            "network",
            "INFO",
            "server address persisted by native Slint runtime",
        );
        self.server_license_snapshot()
    }
    pub fn fixed_weight_products(
        &self,
        search: Option<&str>,
    ) -> Result<Vec<NativeUiProduct>, String> {
        self.operational()?
            .products(search, true)?
            .iter()
            .map(NativeUiProduct::try_from)
            .collect()
    }

    pub fn fixed_weight_snapshot(
        &self,
        selected_product_id: Option<i64>,
        search: Option<&str>,
    ) -> Result<NativeFixedWeightSnapshot, String> {
        let products = self.fixed_weight_products(search)?;
        let selected_product_id = selected_product_id
            .filter(|id| products.iter().any(|product| product.id == *id))
            .or_else(|| products.first().map(|product| product.id));
        let counters =
            NativeUiCounters::try_from(&self.operational()?.latest_counters(selected_product_id)?)?;
        Ok(NativeFixedWeightSnapshot {
            products,
            selected_product_id,
            counters,
        })
    }

    pub fn production_print_jobs(
        &self,
        status: Option<&str>,
    ) -> Result<Vec<NativeProductionPrintJob>, String> {
        self.operational()?
            .print_jobs(status)?
            .iter()
            .map(NativeProductionPrintJob::try_from)
            .collect()
    }

    pub fn production_print_jobs_snapshot(
        &self,
        selected_job_id: Option<i64>,
        status: Option<&str>,
    ) -> Result<NativePrintJobsSnapshot, String> {
        let jobs = self.production_print_jobs(status)?;
        let selected_job_id = selected_job_id
            .filter(|id| jobs.iter().any(|job| job.job_id == *id))
            .or_else(|| {
                jobs.iter()
                    .find(|job| job.status != "completed")
                    .or_else(|| jobs.first())
                    .map(|job| job.job_id)
            });
        let selected_product = selected_job_id
            .and_then(|job_id| jobs.iter().find(|job| job.job_id == job_id))
            .and_then(|job| {
                self.operational()
                    .ok()?
                    .product(job.product_id)
                    .ok()
                    .flatten()
            })
            .as_ref()
            .map(NativeUiProduct::try_from)
            .transpose()?;
        let counters = NativeUiCounters::try_from(
            &self
                .operational()?
                .latest_counters(selected_product.as_ref().map(|product| product.id))?,
        )?;
        Ok(NativePrintJobsSnapshot {
            jobs,
            selected_job_id,
            selected_product,
            counters,
        })
    }

    pub fn weighing_snapshot(
        &self,
        selected_product_id: Option<i64>,
        search: Option<&str>,
    ) -> Result<NativeWeighingSnapshot, String> {
        let operational = self.operational()?;
        let session = self.session()?;

        let station = self.station_snapshot()?;

        let products = self.products(search)?;

        let containers = operational
            .containers()?
            .iter()
            .map(NativeUiContainer::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let operators = operational
            .list_operators()?
            .into_iter()
            .map(|operator| NativeUiOperator {
                uuid: operator.uuid,
                full_name: operator.full_name,
                short_code: operator.short_code,
                has_pin: operator.has_pin,
            })
            .collect::<Vec<_>>();
        let current_operator = session.current().map(|operator| NativeUiOperator {
            uuid: operator.uuid,
            full_name: operator.full_name,
            short_code: operator.short_code,
            has_pin: false,
        });
        let selected_product_id = selected_product_id
            .filter(|id| products.iter().any(|product| product.id == *id))
            .or_else(|| products.first().map(|product| product.id));
        let counters =
            NativeUiCounters::try_from(&operational.latest_counters(selected_product_id)?)?;
        let open_entities = NativeUiOpenEntities::from(operational.open_entities_summary()?);

        Ok(NativeWeighingSnapshot {
            station,
            products,
            containers,
            operators,
            current_operator,
            last_operator_uuid: session.last_operator_uuid(),
            selected_product_id,
            counters,
            open_entities,
        })
    }

    pub fn login_operator(&self, uuid: &str, pin: &str) -> Result<Value, String> {
        let outcome = self.session()?.set(self.operational()?, uuid, pin)?;
        if outcome.get("ok").and_then(Value::as_bool) == Some(true) {
            self.events.emit(
                "session-changed",
                outcome.get("operator").cloned().unwrap_or(Value::Null),
            );
        }
        Ok(outcome)
    }

    pub fn logout_operator(&self) -> Result<Value, String> {
        let open = self.operational()?.open_entities_summary()?;
        let pallet_blocks = open.open_pallet_count > 0
            && has_pallet_target(&self.persisted()?.load_printer_config());
        if open.open_box_count > 0 || pallet_blocks {
            return Ok(json!({
                "ok": false,
                "reason": "open_entities",
                "openBoxCount": open.open_box_count,
                "openBoxNumber": open.open_box_number,
                "openPalletCount": if pallet_blocks { open.open_pallet_count } else { 0 },
            }));
        }
        self.session()?.clear()?;
        self.events.emit("session-changed", Value::Null);
        Ok(json!({ "ok": true }))
    }

    #[cfg(feature = "slint-ui")]
    pub fn print_production_pack(
        &self,
        product_id: i64,
        gross_weight_kg: f64,
        batch_number: String,
        production_date: String,
    ) -> Result<NativePrintOutcome, String> {
        self.production_printer()?.record_and_print_pack(
            self.persisted()?,
            self.operational()?,
            self.session()?,
            &self.printer,
            &self.events,
            PackPrintRequest {
                product_id,
                gross_weight_kg,
                batch_number,
                production_date,
            },
        )
    }

    #[cfg(feature = "slint-ui")]
    pub fn print_fixed_weight_pack(
        &self,
        product_id: i64,
        measured_weight_kg: f64,
        batch_number: String,
        production_date: String,
    ) -> Result<NativePrintOutcome, String> {
        let product = self.production_product(product_id)?;
        validate_fixed_weight_product(&product)?;
        validate_measured_weight(&product, measured_weight_kg)?;
        self.print_production_pack(
            product_id,
            product.fixed_weight_grams / 1_000.0,
            batch_number,
            production_date,
        )
    }

    #[cfg(feature = "slint-ui")]
    pub fn print_fixed_weight_batch(
        &self,
        product_id: i64,
        copies: i64,
        batch_number: String,
        production_date: String,
    ) -> Result<NativeFixedBatchOutcome, String> {
        if !(1..=5_000).contains(&copies) {
            return Err("количество этикеток должно быть от 1 до 5000".to_owned());
        }
        if self.fixed_batch_active.swap(true, Ordering::AcqRel) {
            return Err("пакетная печать уже выполняется".to_owned());
        }
        self.fixed_batch_cancel.store(false, Ordering::Release);
        let outcome = (|| {
            let product = self.production_product(product_id)?;
            validate_fixed_weight_product(&product)?;
            let nominal_weight_kg = product.fixed_weight_grams / 1_000.0;
            let mut completed = 0_i64;
            let mut last_print = None;
            for index in 0..copies {
                if self.fixed_batch_cancel.load(Ordering::Acquire) {
                    break;
                }
                let printed = self.print_production_pack(
                    product_id,
                    nominal_weight_kg,
                    batch_number.clone(),
                    production_date.clone(),
                )?;
                completed += 1;
                last_print = Some(printed);
                self.events.emit(
                    "fixed-batch-progress",
                    json!({
                        "productId": product_id,
                        "completed": completed,
                        "requested": copies,
                        "remaining": copies - completed,
                        "index": index,
                    }),
                );
            }
            let cancelled = completed < copies;
            self.events.emit(
                "fixed-batch-finished",
                json!({
                    "productId": product_id,
                    "completed": completed,
                    "requested": copies,
                    "cancelled": cancelled,
                }),
            );
            Ok(NativeFixedBatchOutcome {
                requested: copies,
                completed,
                cancelled,
                last_print,
            })
        })();
        self.fixed_batch_active.store(false, Ordering::Release);
        outcome
    }

    pub fn cancel_fixed_weight_batch(&self) -> bool {
        let active = self.fixed_batch_active.load(Ordering::Acquire);
        if active {
            self.fixed_batch_cancel.store(true, Ordering::Release);
        }
        active
    }

    pub fn fixed_weight_batch_active(&self) -> bool {
        self.fixed_batch_active.load(Ordering::Acquire)
    }

    #[cfg(feature = "slint-ui")]
    pub fn print_production_job_pack(
        &self,
        job_id: i64,
        measured_weight_kg: f64,
    ) -> Result<NativeJobPrintOutcome, String> {
        let job = self
            .production_print_jobs(None)?
            .into_iter()
            .find(|job| job.job_id == job_id)
            .ok_or_else(|| format!("задание #{job_id} не найдено"))?;
        if job.status == "completed" || job.printed_quantity >= job.quantity {
            return Err(format!("задание #{job_id} уже завершено"));
        }
        let product = self.production_product(job.product_id)?;
        let gross_weight_kg = if product.fixed_weight {
            validate_fixed_weight_product(&product)?;
            validate_measured_weight(&product, measured_weight_kg)?;
            product.fixed_weight_grams / 1_000.0
        } else {
            validate_positive_weight(measured_weight_kg, "контрольный вес")?;
            measured_weight_kg
        };
        let production_date = job
            .marking_date
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(current_local_date);
        let print = self.print_production_pack(
            product.id,
            gross_weight_kg,
            job.batch_number.clone(),
            production_date,
        )?;
        let increment = if job.quantity_unit == "kg" {
            (gross_weight_kg - product.portion_tare_grams / 1_000.0).max(0.0)
        } else {
            1.0
        };
        if increment <= f64::EPSILON {
            return Err("чистый вес упаковки равен нулю".to_owned());
        }
        let printed_quantity = (job.printed_quantity + increment).min(job.quantity);
        let progress = self
            .operational()?
            .update_print_job_progress(job.job_id, printed_quantity)?;
        let status = value_string(progress.get("status")).unwrap_or_else(|| {
            if printed_quantity >= job.quantity {
                "completed".to_owned()
            } else {
                "in_progress".to_owned()
            }
        });
        self.events.emit(
            "print-jobs-updated",
            json!({
                "jobId": job.job_id,
                "printedQuantity": printed_quantity,
                "quantity": job.quantity,
                "status": status,
            }),
        );
        Ok(NativeJobPrintOutcome {
            job_id: job.job_id,
            printed_quantity,
            total_quantity: job.quantity,
            status,
            print,
        })
    }

    pub fn complete_production_print_job(&self, job_id: i64) -> Result<Value, String> {
        let result = self.operational()?.complete_print_job(job_id)?;
        self.events.emit(
            "print-jobs-updated",
            json!({ "jobId": job_id, "status": "completed" }),
        );
        Ok(result)
    }

    pub fn delete_production_print_job(&self, job_id: i64) -> Result<Value, String> {
        let result = self.operational()?.delete_print_job(job_id)?;
        self.events.emit(
            "print-jobs-updated",
            json!({ "jobId": job_id, "deleted": true }),
        );
        Ok(result)
    }

    #[cfg(feature = "slint-ui")]
    pub fn repeat_production_print(&self) -> Result<NativePrintOutcome, String> {
        self.production_printer()?
            .repeat_last(&self.printer, &self.events)
    }

    #[cfg(feature = "slint-ui")]
    pub fn close_production_box(
        &self,
        product_id: i64,
        batch_number: &str,
        production_date: &str,
    ) -> Result<NativePrintOutcome, String> {
        self.production_printer()?.close_box(
            self.persisted()?,
            self.operational()?,
            self.session()?,
            &self.printer,
            &self.events,
            product_id,
            batch_number,
            production_date,
        )
    }

    #[cfg(feature = "slint-ui")]
    pub fn print_production_pallet(
        &self,
        selected_product_id: Option<i64>,
    ) -> Result<NativePrintOutcome, String> {
        self.production_printer()?.print_pallet(
            self.persisted()?,
            self.operational()?,
            self.session()?,
            &self.printer,
            &self.events,
            selected_product_id,
        )
    }
    #[cfg(feature = "slint-ui")]
    pub fn delete_latest_production_pack(&self, product_id: i64) -> Result<i64, String> {
        self.production_printer()?
            .delete_latest_pack(self.operational()?, product_id)
    }
    pub fn disconnect_printers(&self) {
        self.printer.disconnect_all();
    }

    pub fn shutdown(&self) {
        if let Some(ingress) = &self.ingress {
            ingress.stop();
        }
        self.disconnect_scale();
        self.disconnect_printers();
    }

    #[cfg(feature = "slint-ui")]
    fn production_product(&self, product_id: i64) -> Result<NativeUiProduct, String> {
        let value = self
            .operational()?
            .product(product_id)?
            .ok_or_else(|| format!("товар #{product_id} не найден"))?;
        NativeUiProduct::try_from(&value)
    }

    #[cfg(feature = "slint-ui")]
    fn production_printer(&self) -> Result<&NativePrintService, String> {
        self.production_printer
            .as_ref()
            .ok_or_else(|| "production print service is not configured".to_owned())
    }
    fn persisted(&self) -> Result<&PersistedState, String> {
        self.persisted
            .as_deref()
            .ok_or_else(|| "production persisted state is not configured".to_owned())
    }

    fn operational(&self) -> Result<&OperationalState, String> {
        self.operational
            .as_ref()
            .ok_or_else(|| "production operational state is not configured".to_owned())
    }

    fn session(&self) -> Result<&SessionState, String> {
        self.session
            .as_deref()
            .ok_or_else(|| "production session state is not configured".to_owned())
    }
}

fn validate_positive_weight(weight_kg: f64, label: &str) -> Result<(), String> {
    if !weight_kg.is_finite() || weight_kg <= 0.010 {
        return Err(format!("{label} должен быть больше 0.010 кг"));
    }
    Ok(())
}

fn validate_fixed_weight_product(product: &NativeUiProduct) -> Result<(), String> {
    if !product.fixed_weight {
        return Err("выбранный товар не относится к фиксированному весу".to_owned());
    }
    if !product.fixed_weight_grams.is_finite() || product.fixed_weight_grams <= 0.0 {
        return Err("для товара не задан корректный фиксированный вес".to_owned());
    }
    Ok(())
}

fn validate_measured_weight(
    product: &NativeUiProduct,
    measured_weight_kg: f64,
) -> Result<(), String> {
    validate_positive_weight(measured_weight_kg, "контрольный вес")?;
    let measured_grams = measured_weight_kg * 1_000.0;
    let minimum = product.min_weight_grams.max(0.0);
    let maximum = product.max_weight_grams;
    if measured_grams < minimum || (maximum > 0.0 && measured_grams > maximum) {
        let maximum = if maximum > 0.0 {
            format!("{maximum:.0}")
        } else {
            "∞".to_owned()
        };
        return Err(format!(
            "контрольный вес {measured_grams:.0} г вне диапазона {minimum:.0}–{maximum} г"
        ));
    }
    Ok(())
}

fn current_local_date() -> String {
    time::OffsetDateTime::now_utc().date().to_string()
}

fn validate_scale_settings_input(input: &NativeScaleSettingsInput) -> Result<(), String> {
    if !matches!(
        input.connection_type.as_str(),
        "serial" | "tcp" | "simulator"
    ) {
        return Err("выберите Serial, TCP или симулятор".to_owned());
    }
    if input.connection_type != "simulator"
        && !protocol_catalog()
            .iter()
            .any(|protocol| protocol.id == input.protocol_id && protocol.id != "simulator")
    {
        return Err("выберите поддерживаемый протокол весов".to_owned());
    }
    if !(300..=3_000_000).contains(&input.baud_rate) {
        return Err("скорость Serial должна быть в диапазоне 300–3000000".to_owned());
    }
    if !(1..=65_535).contains(&input.port) {
        return Err("TCP-порт должен быть в диапазоне 1–65535".to_owned());
    }
    if !(50..=60_000).contains(&input.polling_interval) {
        return Err("интервал опроса должен быть в диапазоне 50–60000 мс".to_owned());
    }
    if !(2..=32).contains(&input.stability_count) {
        return Err("число отсчётов стабильности должно быть в диапазоне 2–32".to_owned());
    }
    match input.connection_type.as_str() {
        "serial" if input.serial_path.trim().is_empty() => {
            return Err("выберите последовательный порт весов".to_owned())
        }
        "tcp" if input.host.trim().is_empty() => {
            return Err("укажите IP-адрес или имя весов".to_owned())
        }
        _ => {}
    }
    for (label, value) in [
        ("TCP-адрес", input.host.as_str()),
        ("Serial-порт", input.serial_path.as_str()),
    ] {
        if value.chars().count() > 256 || value.chars().any(char::is_control) {
            return Err(format!("{label} содержит недопустимые символы"));
        }
    }
    Ok(())
}

fn scale_endpoint(config: &Value) -> String {
    match value_string(config.get("type")).as_deref() {
        Some("serial") => format!(
            "{} · {} baud",
            value_string(config.get("path")).unwrap_or_else(|| "COM?".to_owned()),
            value_i64(config.get("baudRate")).unwrap_or(9_600)
        ),
        Some("tcp") => format!(
            "{}:{}",
            value_string(config.get("host")).unwrap_or_else(|| "?".to_owned()),
            value_i64(config.get("port")).unwrap_or(4_001)
        ),
        _ => "Встроенный симулятор".to_owned(),
    }
}

fn printer_role_catalog() -> [(&'static str, &'static str, &'static str); 3] {
    [
        (
            "packPrinter",
            "Этикетка упаковки",
            "Отдельная потребительская упаковка",
        ),
        (
            "boxPrinter",
            "Этикетка короба",
            "Групповая транспортная упаковка",
        ),
        (
            "palletPrinter",
            "Паллетный лист",
            "Рулонный или обычный листовой принтер",
        ),
    ]
}

fn validated_printer_role(role: &str) -> Result<&str, String> {
    match role {
        "packPrinter" | "boxPrinter" | "palletPrinter" => Ok(role),
        _ => Err(format!("неизвестная роль принтера: {role}")),
    }
}

fn printer_role_settings(
    config: &Value,
    role: &str,
    role_label: &str,
    description: &str,
) -> NativePrinterRoleSettings {
    let device = config.get(role).cloned().unwrap_or_else(|| json!({}));
    NativePrinterRoleSettings {
        role: role.to_owned(),
        role_label: role_label.to_owned(),
        description: description.to_owned(),
        id: value_string(device.get("id")).unwrap_or_else(|| role.to_owned()),
        active: device
            .get("active")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        name: value_string(device.get("name")).unwrap_or_else(|| role_label.to_owned()),
        connection: value_string(device.get("connection"))
            .unwrap_or_else(|| "windows_driver".to_owned()),
        protocol: value_string(device.get("protocol")).unwrap_or_else(|| "image".to_owned()),
        compatibility_mode: value_string(device.get("compatibilityMode"))
            .unwrap_or_else(|| "auto".to_owned()),
        effective_profile: effective_profile_id(&device),
        endpoint: printer_endpoint(&device),
        ip: value_string(device.get("ip")).unwrap_or_default(),
        port: value_i64(device.get("port")).unwrap_or(9_100) as i32,
        serial_port: value_string(device.get("serialPort")).unwrap_or_default(),
        baud_rate: value_i64(device.get("baudRate")).unwrap_or(9_600) as i32,
        driver_name: value_string(device.get("driverName")).unwrap_or_default(),
        dpi: normalized_dpi(value_i64(device.get("dpi")).unwrap_or(203) as i32),
        ram_cache: value_string(device.get("ramCache")).unwrap_or_else(|| "auto".to_owned()),
        z64: device.get("z64").and_then(Value::as_bool).unwrap_or(false),
        persistent_connection: device
            .get("persistentConnection")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        darkness: value_f64(device.get("darkness")),
        print_speed: value_f64(device.get("printSpeed")),
        gap_mm: value_f64(device.get("gapMm")),
        width_mm: value_f64(device.get("widthMm")),
        height_mm: value_f64(device.get("heightMm")),
    }
}

fn validate_printer_settings_input(
    input: &NativePrinterRoleSettingsInput,
    require_target: bool,
) -> Result<(), String> {
    validated_printer_role(&input.role)?;
    if input.name.trim().is_empty() || input.name.trim().chars().count() > 128 {
        return Err("название принтера должно содержать 1–128 символов".to_owned());
    }
    if input.name.chars().any(char::is_control) {
        return Err("название принтера содержит управляющие символы".to_owned());
    }
    if !matches!(
        input.connection.as_str(),
        "tcp" | "serial" | "windows_driver"
    ) {
        return Err("выберите TCP, Serial или Windows Driver".to_owned());
    }
    if !matches!(
        input.protocol.as_str(),
        "zpl" | "tspl" | "epl" | "cpcl" | "dpl" | "sbpl" | "image" | "browser"
    ) {
        return Err("неподдерживаемый язык печати".to_owned());
    }
    if !matches!(
        input.compatibility_mode.as_str(),
        "auto" | "compatible" | "advanced"
    ) {
        return Err("неподдерживаемый профиль совместимости".to_owned());
    }
    if !matches!(input.ram_cache.as_str(), "auto" | "on" | "off") {
        return Err("неподдерживаемый режим RAM-кэша".to_owned());
    }
    if !(1..=65_535).contains(&input.port) {
        return Err("TCP-порт должен быть в диапазоне 1–65535".to_owned());
    }
    if !(300..=921_600).contains(&input.baud_rate) {
        return Err("скорость Serial должна быть в диапазоне 300–921600".to_owned());
    }
    if !matches!(input.dpi, 203 | 300 | 600) {
        return Err("поддерживаются 203, 300 или 600 DPI".to_owned());
    }
    validate_optional_range("темнота", input.darkness, 0.0, 30.0)?;
    validate_optional_range("скорость печати", input.print_speed, 1.0, 14.0)?;
    validate_optional_range("зазор", input.gap_mm, 0.0, 50.0)?;
    validate_optional_range("ширина", input.width_mm, 1.0, 1_000.0)?;
    validate_optional_range("высота", input.height_mm, 1.0, 1_500.0)?;
    if require_target || input.active {
        match input.connection.as_str() {
            "tcp" if input.ip.trim().is_empty() => {
                return Err("укажите IP-адрес или имя TCP-принтера".to_owned())
            }
            "serial" if input.serial_port.trim().is_empty() => {
                return Err("выберите последовательный порт".to_owned())
            }
            _ => {}
        }
    }
    for (label, value) in [
        ("TCP-адрес", input.ip.as_str()),
        ("Serial-порт", input.serial_port.as_str()),
        ("имя драйвера", input.driver_name.as_str()),
    ] {
        if value.chars().count() > 256 || value.chars().any(char::is_control) {
            return Err(format!("{label} содержит недопустимые символы"));
        }
    }
    Ok(())
}

fn validate_optional_range(
    label: &str,
    value: Option<f64>,
    minimum: f64,
    maximum: f64,
) -> Result<(), String> {
    if value.is_some_and(|value| !value.is_finite() || value < minimum || value > maximum) {
        return Err(format!("{label}: допустимо {minimum}–{maximum}"));
    }
    Ok(())
}

fn set_string(object: &mut serde_json::Map<String, Value>, key: &str, value: &str) {
    object.insert(key.to_owned(), Value::String(value.to_owned()));
}

fn set_optional_string(object: &mut serde_json::Map<String, Value>, key: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        object.remove(key);
    } else {
        set_string(object, key, value);
    }
}

fn set_optional_number(object: &mut serde_json::Map<String, Value>, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        object.insert(key.to_owned(), json!(value));
    } else {
        object.remove(key);
    }
}

fn normalized_dpi(dpi: i32) -> i32 {
    if dpi >= 450 {
        600
    } else if dpi >= 250 {
        300
    } else {
        203
    }
}

fn detected_protocol(device: &Value) -> String {
    match value_string(device.get("protocol")).as_deref() {
        Some("image") => "zpl".to_owned(),
        Some(value @ ("zpl" | "tspl" | "epl" | "cpcl" | "dpl" | "sbpl")) => value.to_owned(),
        _ => String::new(),
    }
}

fn compatible_profile(protocol: &str) -> &'static str {
    match protocol {
        "zpl" => "generic-zpl-safe",
        "tspl" => "generic-tspl-safe",
        "epl" => "generic-epl-raster",
        "cpcl" => "generic-cpcl-raster",
        "dpl" => "generic-dpl-raster",
        "sbpl" => "generic-sbpl-raster",
        _ => "windows-driver",
    }
}

fn advanced_profile(protocol: &str) -> &'static str {
    match protocol {
        "zpl" => "zpl-full",
        "tspl" => "tspl2-full",
        value => compatible_profile(value),
    }
}

fn printer_endpoint_key(device: &Value) -> String {
    match value_string(device.get("connection")).as_deref() {
        Some("tcp") => format!(
            "tcp:{}:{}",
            value_string(device.get("ip"))
                .unwrap_or_default()
                .to_ascii_lowercase(),
            value_i64(device.get("port")).unwrap_or(9_100)
        ),
        Some("serial") => format!(
            "serial:{}:{}",
            value_string(device.get("serialPort"))
                .unwrap_or_default()
                .to_ascii_uppercase(),
            value_i64(device.get("baudRate")).unwrap_or(9_600)
        ),
        _ => format!(
            "spooler:{}",
            value_string(device.get("driverName"))
                .unwrap_or_default()
                .to_ascii_lowercase()
        ),
    }
}

fn printer_detection_signature(device: &Value) -> String {
    format!(
        "{}|{}",
        detected_protocol(device),
        printer_endpoint_key(device)
    )
}

fn effective_profile_id(device: &Value) -> String {
    let protocol = detected_protocol(device);
    if protocol.is_empty() {
        return "windows-driver".to_owned();
    }
    match value_string(device.get("compatibilityMode")).as_deref() {
        Some("advanced") => advanced_profile(&protocol).to_owned(),
        Some("compatible") => compatible_profile(&protocol).to_owned(),
        _ => {
            let endpoint = printer_endpoint_key(device);
            let detected = value_string(device.get("detectedProfileId"));
            let detected_endpoint = value_string(device.get("detectedEndpointKey"));
            if detected_endpoint.as_deref() == Some(endpoint.as_str()) {
                detected.unwrap_or_else(|| compatible_profile(&protocol).to_owned())
            } else {
                compatible_profile(&protocol).to_owned()
            }
        }
    }
}

fn probe_printer_role(
    config: &Value,
    role: &str,
    role_label: &str,
    key: &str,
) -> NativePrinterDiagnostic {
    let Some(device) = warmup_role_config(config, key)
        .filter(|value| value.get("active").and_then(Value::as_bool) != Some(false))
    else {
        return NativePrinterDiagnostic {
            role: role.to_owned(),
            role_label: role_label.to_owned(),
            printer_id: String::new(),
            printer_name: "Не настроен".to_owned(),
            endpoint: "—".to_owned(),
            protocol: "—".to_owned(),
            connection: "—".to_owned(),
            reachable: false,
            status: "unconfigured".to_owned(),
            details: "Назначьте принтер в настройках".to_owned(),
            queried_at_ms: 0,
        };
    };
    let fallback_name = value_string(device.get("name"))
        .or_else(|| value_string(device.get("driverName")))
        .unwrap_or_else(|| role_label.to_owned());
    match query_printer_status(device.clone()) {
        Ok(report) => NativePrinterDiagnostic {
            role: role.to_owned(),
            role_label: role_label.to_owned(),
            printer_id: report.printer_id,
            printer_name: report.printer_name,
            endpoint: report.physical_key,
            protocol: report.protocol,
            connection: report.connection,
            reachable: report.reachable,
            status: report.status,
            details: if report.details.is_empty() {
                "Ответ без дополнительных данных".to_owned()
            } else {
                report.details.join(" · ")
            },
            queried_at_ms: report.queried_at_ms,
        },
        Err(error) => NativePrinterDiagnostic {
            role: role.to_owned(),
            role_label: role_label.to_owned(),
            printer_id: value_string(device.get("id")).unwrap_or_default(),
            printer_name: fallback_name,
            endpoint: printer_endpoint(&device),
            protocol: value_string(device.get("protocol")).unwrap_or_else(|| "—".to_owned()),
            connection: value_string(device.get("connection"))
                .or_else(|| value_string(device.get("type")))
                .unwrap_or_else(|| "—".to_owned()),
            reachable: false,
            status: "error".to_owned(),
            details: error,
            queried_at_ms: unix_ms(),
        },
    }
}

fn printer_endpoint(device: &Value) -> String {
    match value_string(device.get("connection"))
        .or_else(|| value_string(device.get("type")))
        .as_deref()
    {
        Some("tcp") => format!(
            "tcp:{}:{}",
            value_string(device.get("ip")).unwrap_or_else(|| "?".to_owned()),
            value_i64(device.get("port")).unwrap_or(9_100)
        ),
        Some("serial") => format!(
            "serial:{}",
            value_string(device.get("serialPort")).unwrap_or_else(|| "?".to_owned())
        ),
        Some("windows_driver") => format!(
            "spooler:{}",
            value_string(device.get("driverName")).unwrap_or_else(|| "?".to_owned())
        ),
        _ => "—".to_owned(),
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn canonical_server_address(value: &str) -> Option<String> {
    let value: String = value.trim().chars().take(512).collect();
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return None;
    }
    let value = value
        .trim_end_matches('/')
        .strip_suffix("/api/v1")
        .unwrap_or(value.trim_end_matches('/'))
        .trim_end_matches('/');
    let candidate = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_owned()
    } else {
        format!("http://{value}")
    };
    let url = reqwest::Url::parse(&candidate).ok()?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    Some(value.to_owned())
}

fn native_server_base_url(value: &str) -> Option<String> {
    let canonical = canonical_server_address(value)?;
    let base = if canonical.starts_with("http://") || canonical.starts_with("https://") {
        canonical
    } else if has_explicit_server_port(&canonical) {
        format!("http://{canonical}")
    } else {
        format!("http://{canonical}:8000")
    };
    reqwest::Url::parse(&base).ok()?;
    Some(format!("{}/api/v1", base.trim_end_matches('/')))
}

fn has_explicit_server_port(value: &str) -> bool {
    if value.starts_with('[') {
        return value
            .rsplit_once("]:")
            .is_some_and(|(_, port)| port.parse::<u16>().is_ok());
    }
    value
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
}

fn semver_is_less(left: &str, right: &str) -> Option<bool> {
    let parse = |value: &str| -> Option<[u64; 3]> {
        let clean = value.trim().trim_start_matches('v');
        let core = clean.split(['-', '+']).next()?;
        let mut parts = core.split('.');
        Some([
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        ])
    };
    Some(parse(left)? < parse(right)?)
}

fn native_license_status(value: &Value) -> NativeLicenseStatus {
    let features = value
        .get("features")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.chars().take(80).collect())
                .take(64)
                .collect()
        })
        .unwrap_or_default();
    NativeLicenseStatus {
        licensed: value
            .get("licensed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        mode: value_string(value.get("mode")).unwrap_or_else(|| "demo".to_owned()),
        edition: value_string(value.get("edition")).unwrap_or_else(|| "Demo".to_owned()),
        customer: value_string(value.get("customer")).unwrap_or_default(),
        expires: value_string(value.get("expires")).unwrap_or_default(),
        expired: value
            .get("expired")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        max_stations: value_i64(value.get("max_stations")),
        demo_max_stations: value_i64(value.get("demo_max_stations")),
        license_id: value_string(value.get("license_id")).unwrap_or_default(),
        features,
        machine_id: value_string(value.get("machine_id")).unwrap_or_default(),
        strict: value
            .get("strict")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        signature_valid: value
            .get("signature_valid")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        machine_ok: value
            .get("machine_ok")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        stations_used: value_i64(value.get("stations_used")).unwrap_or_default(),
    }
}

fn compact_extra_data(value: Option<&Value>) -> String {
    let parsed = match value {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.clone()))
        }
        Some(value) => value.clone(),
        None => return String::new(),
    };
    let result = match parsed {
        Value::Object(values) => values
            .iter()
            .take(8)
            .map(|(key, value)| {
                let value = match value {
                    Value::String(value) => value.clone(),
                    Value::Null => "—".to_owned(),
                    value => value.to_string(),
                };
                format!("{key}: {value}")
            })
            .collect::<Vec<_>>()
            .join(" · "),
        Value::Null => String::new(),
        Value::String(value) => value,
        value => value.to_string(),
    };
    result.chars().take(512).collect()
}
fn warmup_role_config(config: &Value, key: &str) -> Option<Value> {
    if matches!(key, "packPrinter" | "boxPrinter") {
        if let Some(host) = std::env::var("LABELPILOT_PRINTER_HOST")
            .ok()
            .filter(|host| !host.trim().is_empty())
        {
            let port = std::env::var("LABELPILOT_PRINTER_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(9_100);
            return Some(json!({
                "id": format!("slint-{}-override", key.trim_end_matches("Printer")),
                "active": true,
                "name": "Slint ZPL virtual printer",
                "connection": "tcp",
                "protocol": "image",
                "ip": host,
                "port": port,
                "persistentConnection": true,
            }));
        }
    }
    config.get(key).cloned().filter(Value::is_object)
}

fn file_revision(path: &Path) -> FileRevision {
    let Ok(metadata) = fs::metadata(path) else {
        return FileRevision::default();
    };
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_nanos());
    FileRevision {
        length: metadata.len(),
        modified_nanos,
        present: true,
    }
}

fn has_pallet_target(config: &Value) -> bool {
    let Some(printer) = config.get("palletPrinter").and_then(Value::as_object) else {
        return false;
    };
    match printer.get("connection").and_then(Value::as_str) {
        Some("tcp") => printer
            .get("ip")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        Some("serial") => printer
            .get("serialPort")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        _ => printer
            .get("driverName")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
    }
}

impl TryFrom<&Value> for NativeUiProduct {
    type Error = String;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        Ok(Self {
            id: required_i64(value, "id", "product")?,
            name: required_string(value, "name", "product")?,
            article: value_string(value.get("article")).unwrap_or_default(),
            expiration_days: value_i64(value.get("exp_date")).unwrap_or_default(),
            portion_container_id: value_i64(value.get("portion_container_id")),
            portion_container_name: value_string(value.get("portion_container_name"))
                .unwrap_or_default(),
            box_container_id: value_i64(value.get("box_container_id")),
            box_container_name: value_string(value.get("box_container_name")).unwrap_or_default(),
            portion_tare_grams: value_f64(value.get("portion_weight")).unwrap_or_default(),
            box_tare_grams: value_f64(value.get("box_weight")).unwrap_or_default(),
            close_box_counter: value_i64(value.get("close_box_counter")).unwrap_or_default(),
            pack_label_id: value_i64(value.get("templates_pack_label")),
            pack_label_name: value_string(value.get("pack_label_name")).unwrap_or_default(),
            box_label_id: value_i64(value.get("templates_box_label")),
            box_label_name: value_string(value.get("box_label_name")).unwrap_or_default(),
            pallet_label_id: value_i64(value.get("templates_pallet_label")),
            pallet_label_name: value_string(value.get("pallet_label_name")).unwrap_or_default(),
            extra_data_summary: compact_extra_data(value.get("extra_data")),
            fixed_weight: value_i64(value.get("is_fixed_weight")).unwrap_or_default() != 0,
            fixed_weight_grams: value_f64(value.get("fixed_weight_grams")).unwrap_or_default(),
            min_weight_grams: value_f64(value.get("min_weight_grams")).unwrap_or_default(),
            max_weight_grams: value_f64(value.get("max_weight_grams")).unwrap_or_default(),
        })
    }
}

impl TryFrom<&Value> for NativeProductionPrintJob {
    type Error = String;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let quantity_unit = value_string(value.get("quantity_unit"))
            .filter(|unit| unit == "kg")
            .unwrap_or_else(|| "pcs".to_owned());
        let status = value_string(value.get("status"))
            .filter(|status| matches!(status.as_str(), "pending" | "in_progress" | "completed"))
            .unwrap_or_else(|| "pending".to_owned());
        Ok(Self {
            id: required_i64(value, "id", "print job")?,
            job_id: required_i64(value, "job_id", "print job")?,
            product_id: required_i64(value, "nomenclature_id", "print job")?,
            product_name: required_string(value, "nomenclature_name", "print job")?,
            product_article: value_string(value.get("nomenclature_article")).unwrap_or_default(),
            quantity: value_f64(value.get("quantity")).unwrap_or_default(),
            quantity_unit,
            batch_number: value_string(value.get("batch_number")).unwrap_or_default(),
            marking_date: value_string(value.get("marking_date")),
            printed_quantity: value_f64(value.get("printed_qty")).unwrap_or_default(),
            status,
            created_at: value_string(value.get("created_at")).unwrap_or_default(),
            completed_at: value_string(value.get("completed_at")),
        })
    }
}

impl TryFrom<&Value> for NativeUiContainer {
    type Error = String;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        Ok(Self {
            id: required_i64(value, "id", "container")?,
            name: required_string(value, "name", "container")?,
            weight_grams: value_f64(value.get("weight")).unwrap_or_default(),
        })
    }
}

impl TryFrom<&Value> for NativeUiCounters {
    type Error = String;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        Ok(Self {
            last_pack_number: value_string(value.get("lastPackNumber"))
                .unwrap_or_else(|| "0".to_owned()),
            last_box_number: value_string(value.get("lastBoxNumber"))
                .unwrap_or_else(|| "0".to_owned()),
            total_units: value_i64(value.get("totalUnits")).unwrap_or_default(),
            total_boxes: value_i64(value.get("totalBoxes")).unwrap_or_default(),
            boxes_in_pallet: value_i64(value.get("boxesInPallet")).unwrap_or_default(),
            units_in_box: value_i64(value.get("unitsInBox")).unwrap_or_default(),
            box_net_weight: value_f64(value.get("boxNetWeight")).unwrap_or_default(),
            current_box_id: value_i64(value.get("currentBoxId")),
            current_box_number: value_string(value.get("currentBoxNumber")),
        })
    }
}

impl From<OpenEntitiesSummary> for NativeUiOpenEntities {
    fn from(value: OpenEntitiesSummary) -> Self {
        Self {
            open_box_count: value.open_box_count,
            open_box_number: value.open_box_number,
            open_pallet_count: value.open_pallet_count,
        }
    }
}

fn required_i64(value: &Value, field: &str, kind: &str) -> Result<i64, String> {
    value_i64(value.get(field)).ok_or_else(|| format!("{kind} row has no integer {field}"))
}

fn required_string(value: &Value, field: &str, kind: &str) -> Result<String, String> {
    value_string(value.get(field)).ok_or_else(|| format!("{kind} row has no string {field}"))
}

fn value_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(value) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|value| value as i64)),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn value_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "labelpilot-native-ui-{name}-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn revision_detects_database_and_printer_changes_and_warmup_is_bounded() {
        let directory = TestDirectory::new("revision");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let runtime = NativeUiRuntime::with_persisted(persisted, |_| {}).unwrap();
        let initial = runtime.revision().unwrap();

        thread::sleep(Duration::from_millis(2));
        let persisted = runtime.persisted().unwrap();
        let mut printer_config = persisted.load_printer_config();
        printer_config["autoPrintOnStable"] = json!(false);
        persisted.save_printer_config(printer_config).unwrap();
        let printer_changed = runtime.revision().unwrap();
        assert!(printer_changed.printer_changed_from(&initial));
        assert!(!printer_changed.data_changed_from(&initial));

        thread::sleep(Duration::from_millis(2));
        runtime.operational().unwrap().reset_database().unwrap();
        let database_changed = runtime.revision().unwrap();
        assert!(database_changed.data_changed_from(&printer_changed));

        let warmup = runtime.warmup_production_assets().unwrap();
        assert_eq!(warmup["ok"], true);
        assert_eq!(warmup["staticFonts"], 6);
        assert_eq!(warmup["backgroundMode"], "inline-rust");
        assert_eq!(warmup["results"]["pack"], "unconfigured");
        assert_eq!(warmup["results"]["box"], "unconfigured");
    }

    #[test]
    fn native_snapshot_matches_operational_contract_and_session() {
        let directory = TestDirectory::new("snapshot");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        persisted
            .save_identity(&json!({
                "station_uuid": "station-native",
                "station_number": "07",
                "station_name": "Native line",
                "last_sync_time": "2026-08-24T12:00:00Z"
            }))
            .unwrap();
        let connection = crate::processor::open_database(&persisted).unwrap();
        connection
            .execute_batch(
                r#"
                INSERT OR REPLACE INTO station(uuid, number, name)
                VALUES ('station-native', 7, 'Native line');
                INSERT INTO container(id, name, weight) VALUES (5, 'Tray', 42);
                INSERT INTO nomenclature(
                    id, name, article, exp_date, portion_container_id,
                    close_box_counter, templates_pack_label
                ) VALUES (1, 'Jerky', '3002', 80, 5, 20, 11);
                INSERT INTO operators(uuid, full_name, short_code, is_active)
                VALUES ('operator-1', 'Operator One', 'OP1', 1);
                "#,
            )
            .unwrap();
        drop(connection);

        let direct = OperationalState::new(&persisted).unwrap();
        let raw_products = direct.products(None, false).unwrap();
        let raw_counters = direct.latest_counters(Some(1)).unwrap();
        let runtime = NativeUiRuntime::with_persisted(persisted, |_| {}).unwrap();

        let before_login = runtime.weighing_snapshot(None, None).unwrap();
        assert!(before_login.station.provisioned);
        assert_eq!(before_login.station.number.as_deref(), Some("07"));
        assert_eq!(before_login.products[0].id, raw_products[0]["id"]);
        assert_eq!(before_login.products[0].portion_tare_grams, 42.0);
        assert_eq!(
            before_login.counters.total_units,
            raw_counters["totalUnits"]
        );
        assert_eq!(before_login.current_operator, None);
        assert_eq!(before_login.open_entities.open_box_count, 0);

        let login = runtime.login_operator("operator-1", "").unwrap();
        assert_eq!(login["ok"], true);
        let after_login = runtime.weighing_snapshot(Some(1), None).unwrap();
        assert_eq!(
            after_login
                .current_operator
                .as_ref()
                .map(|value| value.full_name.as_str()),
            Some("Operator One")
        );
        assert_eq!(after_login.selected_product_id, Some(1));
        let recorded = direct
            .record_pack(
                crate::operational::RecordPackPayload {
                    number: "07000001".to_owned(),
                    box_number: "07000001".to_owned(),
                    nomenclature_id: 1,
                    weight_netto: 1.0,
                    weight_brutto: 1.1,
                    barcode_value: "4870254930240".to_owned(),
                    station_number: Some("07".to_owned()),
                    production_date: None,
                    expiration_date: None,
                    batch: None,
                    barcode_spec: None,
                },
                None,
            )
            .unwrap();
        let blocked = runtime.logout_operator().unwrap();
        assert_eq!(blocked["ok"], false);
        assert_eq!(blocked["reason"], "open_entities");
        assert_eq!(blocked["openBoxNumber"], "07000001");
        assert!(runtime
            .weighing_snapshot(Some(1), None)
            .unwrap()
            .current_operator
            .is_some());
        direct
            .close_box(crate::operational::CloseBoxPayload {
                box_id: recorded.box_id,
                weight_netto: 1.0,
                weight_brutto: 1.1,
            })
            .unwrap();
        assert_eq!(runtime.logout_operator().unwrap()["ok"], true);
        assert!(runtime
            .weighing_snapshot(Some(1), Some("missing"))
            .unwrap()
            .products
            .is_empty());
    }

    #[test]
    fn native_catalog_is_bounded_searchable_and_resolves_related_names() {
        let directory = TestDirectory::new("catalog");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let connection = crate::processor::open_database(&persisted).unwrap();
        connection
            .execute_batch(
                r#"
                INSERT INTO container(id,name,weight) VALUES
                    (1,'Лоток',42),(2,'Короб',310);
                INSERT INTO labels(id,name,structure) VALUES
                    (11,'Этикетка упаковки','{}'),
                    (12,'Этикетка короба','{}'),
                    (13,'Паллетный лист','{}');
                "#,
            )
            .unwrap();
        for id in 1..=55_i64 {
            let name = if id == 55 {
                "Искомый промышленный товар".to_owned()
            } else {
                format!("Товар {id:02}")
            };
            connection
                .execute(
                    "INSERT INTO nomenclature(
                        id,name,article,exp_date,portion_container_id,box_container_id,
                        close_box_counter,templates_pack_label,templates_box_label,
                        templates_pallet_label,extra_data,is_fixed_weight,fixed_weight_grams
                     ) VALUES(?1,?2,?3,30,1,2,20,11,12,13,?4,?5,?6)",
                    rusqlite::params![
                        id,
                        name,
                        format!("ART-{id:03}"),
                        json!({"line":"A","temperature":"0..4 C"}).to_string(),
                        i64::from(id == 1),
                        if id == 1 { 500 } else { 0 }
                    ],
                )
                .unwrap();
        }
        drop(connection);

        let runtime = NativeUiRuntime::with_persisted(persisted, |_| {}).unwrap();
        let catalog = runtime.catalog_snapshot(None, None).unwrap();
        assert_eq!(catalog.total_matching, 55);
        assert_eq!(catalog.products.len(), 50);
        assert!(catalog.truncated);
        let first = &catalog.products[0];
        assert_eq!(first.portion_container_name, "Лоток");
        assert_eq!(first.box_container_name, "Короб");
        assert_eq!(first.box_tare_grams, 310.0);
        assert_eq!(first.pack_label_name, "Этикетка упаковки");
        assert_eq!(first.box_label_name, "Этикетка короба");
        assert_eq!(first.pallet_label_name, "Паллетный лист");
        assert!(first.extra_data_summary.contains("line: A"));

        let filtered = runtime
            .catalog_snapshot(None, Some("промышленный"))
            .unwrap();
        assert_eq!(filtered.total_matching, 1);
        assert_eq!(filtered.products.len(), 1);
        assert!(!filtered.truncated);
        assert_eq!(filtered.selected_product_id, Some(55));
    }

    #[test]
    fn native_server_license_snapshot_uses_the_existing_http_contract() {
        let directory = TestDirectory::new("server-license");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        persisted
            .save_identity(&json!({
                "station_uuid": "station-license",
                "station_number": "12",
                "station_name": "Line 12",
                "last_sync_time": "2026-08-27T10:00:00Z"
            }))
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0_u8; 4096];
                let count = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..count]).into_owned();
                let body = if request.starts_with("GET /api/v1/stations/ping/") {
                    r#"{"status":"online","server_version":"2.4.0","min_client_version":"1.9.0"}"#
                } else {
                    r#"{"licensed":true,"mode":"licensed","edition":"Industrial","customer":"Factory","expires":"2028-01-01","expired":false,"max_stations":20,"stations_used":3,"license_id":"LIC-42","features":["printing","telemetry"],"machine_id":"MACHINE-12","strict":true,"signature_valid":true,"machine_ok":true}"#
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
                requests.push(request);
            }
            requests
        });

        let runtime = NativeUiRuntime::with_persisted(persisted, |_| {}).unwrap();
        let snapshot = runtime.save_server_address(&address.to_string()).unwrap();
        assert!(snapshot.server_configured);
        assert!(snapshot.server_online);
        assert!(snapshot.server_compatible);
        assert_eq!(snapshot.server_version, "2.4.0");
        assert!(snapshot.license_online);
        let license = snapshot.license.unwrap();
        assert!(license.licensed);
        assert_eq!(license.edition, "Industrial");
        assert_eq!(license.features, ["printing", "telemetry"]);
        assert_eq!(license.max_stations, Some(20));
        assert_eq!(license.stations_used, 3);
        assert_eq!(
            runtime.persisted().unwrap().load_printer_config()["serverIp"],
            address.to_string()
        );
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /api/v1/stations/ping/?station_uuid=station-license"));
        assert!(requests[1].starts_with("GET /api/v1/license/"));
    }
    #[test]
    fn native_scale_settings_preserve_extensions_and_probe_real_tcp_frame() {
        let directory = TestDirectory::new("scale-settings");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let mut initial = persisted.load_scale_config();
        initial["vendorOption"] = json!({"mode": "industrial", "keep": true});
        initial["calibrationId"] = json!("factory-42");
        persisted.save_scale_config(initial).unwrap();

        let emitted = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let runtime = NativeUiRuntime::with_persisted(persisted, move |event| {
            captured.lock().unwrap().push(event);
        })
        .unwrap();
        runtime
            .connect_scale(json!({
                "type": "simulator",
                "protocolId": "simulator",
                "pollingInterval": 250,
                "stabilityCount": 4
            }))
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"12.340 kg\r\n").unwrap();
        });
        let input = NativeScaleSettingsInput {
            connection_type: "tcp".to_owned(),
            protocol_id: "generic".to_owned(),
            serial_path: String::new(),
            baud_rate: 9_600,
            host: "127.0.0.1".to_owned(),
            port: i32::from(port),
            polling_interval: 100,
            stability_count: 3,
        };
        let probe = runtime.test_scale_settings(input.clone()).unwrap();
        server.join().unwrap();
        assert!(probe.reachable);
        assert!(probe.valid_frame);
        assert_eq!(probe.protocol_id, "generic");
        assert_eq!(
            probe.reading.as_ref().map(|reading| reading.weight),
            Some(12.34)
        );
        assert!(matches!(
            runtime.scale_status(),
            "reconnecting" | "connected"
        ));

        let initial_snapshot = runtime.scale_settings_snapshot().unwrap();
        assert_eq!(initial_snapshot.protocols.len(), 20);
        assert_eq!(initial_snapshot.connection_type, "simulator");

        let simulator = NativeScaleSettingsInput {
            connection_type: "simulator".to_owned(),
            protocol_id: "simulator".to_owned(),
            serial_path: "COM77".to_owned(),
            baud_rate: 115_200,
            host: "saved-host".to_owned(),
            port: 4_001,
            polling_interval: 150,
            stability_count: 3,
        };
        let saved = runtime.save_scale_settings(simulator.clone()).unwrap();
        assert_eq!(saved.connection_type, "simulator");
        assert_eq!(saved.protocol_id, "simulator");
        let reloaded = runtime.persisted().unwrap().load_scale_config();
        assert_eq!(reloaded["vendorOption"]["mode"], "industrial");
        assert_eq!(reloaded["vendorOption"]["keep"], true);
        assert_eq!(reloaded["calibrationId"], "factory-42");
        assert_eq!(reloaded["path"], "COM77");
        assert_eq!(reloaded["host"], "saved-host");
        assert_eq!(reloaded["pollingInterval"], 150);

        let mut invalid = simulator;
        invalid.port = 0;
        assert!(runtime
            .save_scale_settings(invalid)
            .unwrap_err()
            .contains("1–65535"));
        assert!(emitted.lock().unwrap().iter().any(|event| {
            matches!(
                event,
                NativeRuntimeEvent::Event { name, .. } if name == "scale-config-updated"
            )
        }));
        runtime.shutdown();
    }

    #[test]
    fn native_printer_settings_preserve_extensions_validate_and_test_real_pipeline() {
        let directory = TestDirectory::new("printer-settings");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let mut initial = persisted.load_printer_config();
        initial["customRoot"] = json!({"keep": true});
        initial["packPrinter"]["vendorOption"] = json!("keep-me");
        initial["packPrinter"]["pageFit"] = json!("actual-size");
        persisted.save_printer_config(initial).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (printed_tx, printed_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 8_192];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        bytes.extend_from_slice(&buffer[..count]);
                        if bytes.windows(3).any(|window| window == b"^XZ") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            printed_tx.send(bytes).unwrap();
        });

        let emitted = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let runtime = NativeUiRuntime::with_persisted(persisted, move |event| {
            captured.lock().unwrap().push(event);
        })
        .unwrap();
        let input = NativePrinterRoleSettingsInput {
            role: "packPrinter".to_owned(),
            active: true,
            name: "Settings pipeline ZPL".to_owned(),
            connection: "tcp".to_owned(),
            protocol: "zpl".to_owned(),
            compatibility_mode: "compatible".to_owned(),
            ip: "127.0.0.1".to_owned(),
            port: i32::from(port),
            serial_port: String::new(),
            baud_rate: 9_600,
            driver_name: String::new(),
            dpi: 300,
            ram_cache: "auto".to_owned(),
            z64: false,
            persistent_connection: false,
            darkness: Some(12.0),
            print_speed: Some(6.0),
            gap_mm: Some(2.0),
            width_mm: Some(58.0),
            height_mm: Some(40.0),
        };
        let detect_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let detect_port = detect_listener.local_addr().unwrap().port();
        let detect_server = thread::spawn(move || {
            let (mut stream, _) = detect_listener.accept().unwrap();
            let mut command = [0_u8; 16];
            let read = stream.read(&mut command).unwrap();
            assert_eq!(&command[..read], b"~HS\r\n");
            stream.write_all(b"\x02030,0,0,0250,000,0,0,0,000,0,0,0\x03\r\n\x02001,0,0,0,0,2,0,0,00000000,1,000\x03\r\n\x021234,0\x03\r\n").unwrap();
        });
        let mut detect_input = input.clone();
        detect_input.port = i32::from(detect_port);
        let capability = runtime
            .detect_and_apply_printer_settings(detect_input, false)
            .unwrap();
        detect_server.join().unwrap();
        assert!(capability.detected);
        assert!(capability.applied);
        assert_eq!(capability.recommended_profile, "generic-zpl-safe");
        let detected = runtime.persisted().unwrap().load_printer_config();
        assert_eq!(
            detected["packPrinter"]["detectedProfileId"],
            "generic-zpl-safe"
        );

        let saved = runtime
            .save_printer_role_settings(input.clone(), false)
            .unwrap();
        assert_eq!(saved.roles.len(), 3);
        assert_eq!(saved.roles[0].effective_profile, "generic-zpl-safe");
        assert!(!saved.auto_print_on_stable);

        let reloaded = runtime.persisted().unwrap().load_printer_config();
        assert_eq!(reloaded["customRoot"]["keep"], true);
        assert_eq!(reloaded["packPrinter"]["vendorOption"], "keep-me");
        assert_eq!(reloaded["packPrinter"]["pageFit"], "actual-size");
        assert_eq!(reloaded["packPrinter"]["id"], "pack_default");
        assert_eq!(reloaded["packPrinter"]["darkness"], 12.0);
        assert_eq!(reloaded["packPrinter"]["dpi"], 300);
        assert!(reloaded["packPrinter"].get("detectedProfileId").is_none());

        let mut invalid = input.clone();
        invalid.port = 0;
        assert!(runtime
            .save_printer_role_settings(invalid, false)
            .unwrap_err()
            .contains("1–65535"));

        let receipt = runtime.test_printer_settings(input).unwrap();
        assert!(receipt["bytes"].as_u64().unwrap_or_default() > 0);
        let printed = printed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(printed.starts_with(b"^XA"));
        assert!(printed.windows(3).any(|window| window == b"^XZ"));
        server.join().unwrap();
        assert!(emitted.lock().unwrap().iter().any(|event| {
            matches!(
                event,
                NativeRuntimeEvent::Event { name, .. }
                    if name == "printer-config-updated"
            )
        }));
        runtime.shutdown();
    }

    #[test]
    fn native_queue_actions_and_role_diagnostics_work_without_tauri() {
        let directory = TestDirectory::new("printer-operations");
        let closed_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed_listener.local_addr().unwrap().port();
        drop(closed_listener);

        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let mut printer_config = persisted.load_printer_config();
        printer_config["packPrinter"] = json!({
            "id": "native-pack-test",
            "active": true,
            "name": "Native test printer",
            "connection": "tcp",
            "protocol": "zpl",
            "ip": "127.0.0.1",
            "port": closed_port,
            "persistentConnection": false
        });
        persisted
            .save_printer_config(printer_config.clone())
            .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let runtime = NativeUiRuntime::with_persisted(persisted, move |event| {
            captured.lock().unwrap().push(event);
        })
        .unwrap();

        let initial = runtime.printer_queue_snapshot(100).unwrap();
        assert_eq!(initial.summary.total, 0);
        assert!(initial.jobs.is_empty());

        let send = runtime.send_raw(
            printer_config["packPrinter"].clone(),
            b"^XA^FO20,20^FDnative queue test^FS^XZ".to_vec(),
        );
        assert!(send.is_err());
        let uncertain = runtime.printer_queue_snapshot(100).unwrap();
        assert_eq!(uncertain.summary.total, 1);
        assert_eq!(uncertain.summary.uncertain, 1);
        assert_eq!(uncertain.jobs[0].state, "uncertain");
        let job_id = uncertain.jobs[0].job_id.clone();

        let cancelled = runtime.cancel_print_job(&job_id).unwrap();
        assert_eq!(cancelled.state, "cancelled");
        assert_eq!(
            runtime
                .printer_queue_snapshot(100)
                .unwrap()
                .summary
                .cancelled,
            1
        );

        assert!(runtime.retry_print_job(&job_id).is_err());
        let retried = runtime.printer_queue_snapshot(100).unwrap();
        assert_eq!(retried.summary.uncertain, 1);
        assert!(retried.jobs[0].attempt_count >= 2);

        let diagnostics = runtime.probe_configured_printers().unwrap();
        assert_eq!(diagnostics.len(), 3);
        assert_eq!(diagnostics[0].role, "pack");
        assert!(!diagnostics[0].reachable);
        assert_ne!(diagnostics[0].status, "unconfigured");
        assert_eq!(diagnostics[1].status, "unconfigured");
        assert_eq!(diagnostics[2].status, "unconfigured");

        let emitted_durable_update = events.lock().unwrap().iter().any(|event| {
            matches!(
                event,
                NativeRuntimeEvent::Event { name, .. }
                    if name == "printer-durable-job-update"
            )
        });
        assert!(emitted_durable_update);
        runtime.shutdown();
    }

    #[test]
    fn native_fixed_weight_and_server_job_share_production_print_pipeline() {
        let directory = TestDirectory::new("fixed-and-jobs");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        persisted
            .save_identity(&json!({
                "station_uuid": "station-production",
                "station_number": "09",
                "station_name": "Production"
            }))
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (printed_tx, printed_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(45);
            let mut labels = Vec::new();
            while labels.len() < 3 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => panic!("accept production label: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut pending = Vec::new();
                let mut buffer = [0_u8; 8_192];
                loop {
                    match stream.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            pending.extend_from_slice(&buffer[..count]);
                            while let Some(end) =
                                pending.windows(3).position(|window| window == b"^XZ")
                            {
                                labels.push(pending.drain(..end + 3).collect::<Vec<_>>());
                                if labels.len() == 3 {
                                    printed_tx.send(labels).unwrap();
                                    return;
                                }
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) && Instant::now() < deadline =>
                        {
                            continue;
                        }
                        Err(_) => break,
                    }
                }
            }
            printed_tx.send(labels).unwrap();
        });

        let device = json!({
            "id": "native-production-zpl",
            "active": true,
            "name": "Native production ZPL",
            "connection": "tcp",
            "protocol": "zpl",
            "ip": "127.0.0.1",
            "port": port,
            "dpi": 203,
            "persistentConnection": false,
            "compatibilityMode": "compatible"
        });
        persisted
            .save_printer_config(json!({
                "packPrinter": device,
                "boxPrinter": {
                    "id": "native-box-disabled",
                    "active": false,
                    "name": "Box disabled",
                    "connection": "windows_driver",
                    "protocol": "image",
                    "driverName": ""
                },
                "palletPrinter": {
                    "id": "native-pallet-disabled",
                    "active": false,
                    "name": "Pallet disabled",
                    "connection": "windows_driver",
                    "protocol": "browser",
                    "driverName": ""
                },
                "autoPrintOnStable": false,
                "serverIp": "",
                "language": "ru"
            }))
            .unwrap();

        let connection = crate::processor::open_database(&persisted).unwrap();
        let label = json!({
            "canvas": {
                "width": 480,
                "height": 260,
                "widthCm": 6.0,
                "heightCm": 3.2,
                "dpi": 203
            },
            "elements": [
                {
                    "id": "name",
                    "type": "text",
                    "x": 12,
                    "y": 12,
                    "w": 456,
                    "h": 70,
                    "text": "{{ name }}",
                    "fontFamily": "Inter",
                    "fontSize": 24,
                    "fontWeight": 700
                },
                {
                    "id": "weight",
                    "type": "text",
                    "x": 12,
                    "y": 88,
                    "w": 456,
                    "h": 54,
                    "text": "{{ weight_brutto_pack }} kg",
                    "fontFamily": "Inter",
                    "fontSize": 20
                },
                {
                    "id": "barcode",
                    "type": "barcode",
                    "x": 12,
                    "y": 150,
                    "w": 430,
                    "h": 90,
                    "barcodeType": "code128",
                    "value": "{{ article }}",
                    "showText": true
                }
            ]
        });
        connection
            .execute(
                "INSERT INTO labels(id,name,structure) VALUES(1,'Fixed pack',?1)",
                [label.to_string()],
            )
            .unwrap();
        connection
            .execute_batch(
                r#"
                INSERT INTO station(uuid,number,name)
                VALUES('station-production',9,'Production');
                INSERT INTO container(id,name,weight)
                VALUES(1,'Tray',100);
                INSERT INTO nomenclature(
                    id,name,article,exp_date,portion_container_id,
                    templates_pack_label,close_box_counter,is_fixed_weight,
                    fixed_weight_grams,min_weight_grams,max_weight_grams
                ) VALUES(
                    10,'Fixed Product','460000000001',30,1,
                    1,99,1,1000,900,1100
                );
                INSERT INTO print_jobs(
                    job_id,nomenclature_id,nomenclature_name,nomenclature_article,
                    quantity,quantity_unit,batch_number,printed_qty,status,marking_date
                ) VALUES(
                    700,10,'Fixed Product','460000000001',
                    1,'pcs','JOB-700',0,'pending','24.08.2026'
                );
                "#,
            )
            .unwrap();
        drop(connection);

        let emitted = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let runtime = NativeUiRuntime::with_persisted(persisted, move |event| {
            captured.lock().unwrap().push(event);
        })
        .unwrap();

        let fixed = runtime.fixed_weight_snapshot(None, None).unwrap();
        assert_eq!(fixed.products.len(), 1);
        assert_eq!(fixed.products[0].fixed_weight_grams, 1_000.0);
        assert_eq!(fixed.products[0].min_weight_grams, 900.0);
        assert_eq!(fixed.products[0].max_weight_grams, 1_100.0);
        assert!(runtime
            .print_fixed_weight_pack(10, 0.8, "BAD".to_owned(), "24.08.2026".to_owned())
            .unwrap_err()
            .contains("вне диапазона"));

        let single = runtime
            .print_fixed_weight_pack(10, 1.005, "FIXED-1".to_owned(), "24.08.2026".to_owned())
            .unwrap();
        assert_eq!(single.kind, "pack");

        let batch = runtime
            .print_fixed_weight_batch(10, 1, "FIXED-BATCH".to_owned(), "24.08.2026".to_owned())
            .unwrap();
        assert_eq!(batch.requested, 1);
        assert_eq!(batch.completed, 1);
        assert!(!batch.cancelled);
        assert!(!runtime.fixed_weight_batch_active());

        let job = runtime.print_production_job_pack(700, 1.010).unwrap();
        assert_eq!(job.job_id, 700);
        assert_eq!(job.printed_quantity, 1.0);
        assert_eq!(job.status, "completed");
        let jobs = runtime
            .production_print_jobs_snapshot(Some(700), None)
            .unwrap();
        assert_eq!(jobs.jobs.len(), 1);
        assert_eq!(jobs.jobs[0].status, "completed");
        assert_eq!(jobs.jobs[0].printed_quantity, 1.0);

        let diagnostics = Connection::open(runtime.persisted().unwrap().database_path()).unwrap();
        let pack_count: i64 = diagnostics
            .query_row(
                "SELECT COUNT(*) FROM pack WHERE status != 'Deleted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let delivery_count: i64 = diagnostics
            .query_row("SELECT COUNT(*) FROM printer_delivery_jobs", [], |row| {
                row.get(0)
            })
            .unwrap();
        let accepted_count: i64 = diagnostics
            .query_row(
                "SELECT COUNT(*) FROM printer_delivery_jobs WHERE state = 'accepted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pack_count, 3);
        assert_eq!(delivery_count, 3);
        assert_eq!(accepted_count, 3);
        let labels = printed_rx.recv_timeout(Duration::from_secs(45)).unwrap();
        assert_eq!(labels.len(), 3);
        assert!(labels
            .iter()
            .all(|payload| payload.starts_with(b"^XA") && payload.ends_with(b"^XZ")));
        assert!(emitted.lock().unwrap().iter().any(|event| {
            matches!(
                event,
                NativeRuntimeEvent::Event { name, .. } if name == "fixed-batch-progress"
            )
        }));
        assert!(emitted.lock().unwrap().iter().any(|event| {
            matches!(
                event,
                NativeRuntimeEvent::Event { name, .. } if name == "print-jobs-updated"
            )
        }));
        runtime.shutdown();
        server.join().unwrap();
    }

    #[test]
    fn native_runtime_drives_tcp_scale_and_printer_without_tauri_app() {
        let scale_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let scale_port = scale_listener.local_addr().unwrap().port();
        let scale_server = thread::spawn(move || {
            let (mut stream, _) = scale_listener.accept().unwrap();
            for _ in 0..12 {
                if stream.write_all(b"3.406 kg\r\n").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(35));
            }
        });

        let printer_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let printer_port = printer_listener.local_addr().unwrap().port();
        let (printed_tx, printed_rx) = mpsc::channel();
        let printer_server = thread::spawn(move || {
            let (mut stream, _) = printer_listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut data = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        data.extend_from_slice(&buffer[..count]);
                        if data.ends_with(b"^XZ") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            printed_tx.send(data).unwrap();
        });

        let (events_tx, events_rx) = mpsc::channel();
        let runtime = NativeUiRuntime::new(move |event| {
            let _ = events_tx.send(event);
        });
        runtime
            .connect_scale(serde_json::json!({
                "type": "tcp",
                "protocolId": "generic",
                "host": "127.0.0.1",
                "port": scale_port,
                "pollingInterval": 50,
                "stabilityCount": 2
            }))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut scale_weight = None;
        while Instant::now() < deadline {
            let Ok(event) = events_rx.recv_timeout(Duration::from_millis(200)) else {
                continue;
            };
            if let NativeRuntimeEvent::Event { name, payload } = event {
                if name == "scale-reading" {
                    scale_weight = payload.get("weight").and_then(Value::as_f64);
                    break;
                }
            }
        }
        assert_eq!(scale_weight, Some(3.406));

        let zpl = b"^XA^FO20,20^A0N,30,30^FDLabelPilot native runtime^FS^XZ".to_vec();
        let receipt = runtime
            .send_raw(
                serde_json::json!({
                    "id": "slint-poc",
                    "active": true,
                    "name": "Virtual ZPL",
                    "connection": "tcp",
                    "protocol": "zpl",
                    "ip": "127.0.0.1",
                    "port": printer_port,
                    "persistentConnection": false
                }),
                zpl.clone(),
            )
            .unwrap();
        assert_eq!(
            receipt.get("bytes").and_then(Value::as_u64),
            Some(zpl.len() as u64)
        );
        assert_eq!(
            printed_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            zpl
        );

        runtime.shutdown();
        scale_server.join().unwrap();
        printer_server.join().unwrap();
    }
}
