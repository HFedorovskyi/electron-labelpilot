#![cfg_attr(feature = "native-ui", allow(dead_code, unused_imports))]

#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod barcode;
#[cfg(feature = "desktop")]
mod commands;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod crypto;
#[cfg(feature = "desktop")]
mod diagnostic;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod generator;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod ingress;
#[cfg(feature = "desktop")]
mod lifecycle;
#[cfg(feature = "native-update")]
pub mod native_update;
#[cfg(feature = "desktop")]
mod network;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod operational;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod persisted;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod printer;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod processor;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod runtime_events;
pub mod runtime_selector;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod scale;
#[cfg(any(feature = "desktop", feature = "slint-ui"))]
mod session;
#[cfg(feature = "desktop")]
mod telemetry;
#[cfg(feature = "desktop")]
mod transfer;

#[cfg(feature = "slint-ui")]
mod native_print;
#[cfg(feature = "slint-ui")]
mod native_raster;
#[cfg(feature = "native-ui")]
pub mod native_ui;
#[cfg(feature = "slint-ui")]
pub mod slint_runtime;

#[cfg(feature = "desktop")]
use commands::RuntimeState;
#[cfg(feature = "desktop")]
use generator::GeneratorState;
#[cfg(feature = "desktop")]
use ingress::IngressState;
#[cfg(feature = "desktop")]
use lifecycle::UpdateRuntimeState;
#[cfg(feature = "desktop")]
use network::NetworkState;
#[cfg(feature = "desktop")]
use operational::OperationalState;
#[cfg(feature = "desktop")]
use persisted::PersistedState;
#[cfg(feature = "desktop")]
use printer::PrinterTransportState;
#[cfg(feature = "desktop")]
use scale::ScaleState;
#[cfg(feature = "desktop")]
use session::SessionState;
#[cfg(feature = "desktop")]
use tauri::Manager;
#[cfg(feature = "desktop")]
use telemetry::TelemetryState;

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let log_dir = app.path().app_log_dir().map_err(|error| {
                std::io::Error::other(format!("failed to resolve log directory: {error}"))
            })?;
            let state = RuntimeState::new(log_dir).map_err(std::io::Error::other)?;
            state.log_startup().map_err(std::io::Error::other)?;
            let persisted = PersistedState::resolve().map_err(std::io::Error::other)?;
            if let Some(backup_id) = lifecycle::apply_pending_rollback(persisted.data_dir())
                .map_err(std::io::Error::other)?
            {
                state
                    .log(
                        "INFO",
                        &format!("applied pending rollback from {backup_id}"),
                    )
                    .map_err(std::io::Error::other)?;
            }
            state
                .log_data_directory(persisted.data_dir())
                .map_err(std::io::Error::other)?;
            let operational = OperationalState::new(&persisted).map_err(std::io::Error::other)?;
            let session = SessionState::new(persisted.data_dir().to_path_buf());
            let scale = ScaleState::new();
            let printer = PrinterTransportState::with_database(&persisted.database_path())
                .map_err(std::io::Error::other)?;
            let telemetry = TelemetryState::new(persisted.data_dir().to_path_buf());
            app.manage(state);
            app.manage(UpdateRuntimeState::default());
            app.manage(persisted);
            app.manage(operational);
            app.manage(session);
            app.manage(scale);
            app.manage(printer);
            app.manage(GeneratorState::default());
            app.manage(telemetry);
            let recovered_print_jobs = app
                .state::<PrinterTransportState>()
                .recover_pending(app.handle().clone())
                .map_err(std::io::Error::other)?;
            if recovered_print_jobs > 0 {
                app.state::<RuntimeState>()
                    .log(
                        "INFO",
                        &format!(
                            "scheduled {recovered_print_jobs} durable print jobs for recovery"
                        ),
                    )
                    .map_err(std::io::Error::other)?;
            }
            let network = NetworkState::new().map_err(std::io::Error::other)?;
            network
                .start(app.handle().clone())
                .map_err(std::io::Error::other)?;
            app.manage(network);
            app.manage(IngressState::new());
            app.state::<IngressState>()
                .start(app.handle().clone())
                .map_err(std::io::Error::other)?;
            let scale_config = app.state::<PersistedState>().load_scale_config();
            if let Err(error) = app
                .state::<ScaleState>()
                .connect(app.handle().clone(), scale_config)
            {
                let _ = app
                    .state::<RuntimeState>()
                    .log("ERROR", &format!("scale auto-connect failed: {error}"));
            }
            app.state::<TelemetryState>()
                .start(app.handle().clone())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_get_version,
            commands::desktop_updater_check,
            commands::desktop_updater_download,
            commands::desktop_updater_install,
            commands::desktop_updater_install_offline,
            commands::desktop_updater_list_backups,
            commands::desktop_updater_rollback,
            commands::desktop_updater_refresh_server_version,
            commands::desktop_import_identity_file,
            commands::desktop_offline_import,
            commands::desktop_offline_export,
            commands::desktop_import_print_job_file,
            commands::desktop_usb_export,
            commands::desktop_usb_import,
            commands::desktop_demo_status,
            commands::desktop_seed_demo_data,
            commands::desktop_exit_demo,
            commands::desktop_reset_database,
            commands::desktop_contract_summary,
            commands::desktop_get_scale_config,
            commands::desktop_save_scale_config,
            commands::desktop_connect_scale,
            commands::desktop_disconnect_scale,
            commands::desktop_get_scale_status,
            commands::desktop_get_serial_ports,
            commands::desktop_get_protocols,
            commands::desktop_scale_summary,
            commands::desktop_get_numbering_config,
            commands::desktop_save_numbering_config,
            commands::desktop_get_printer_config,
            commands::desktop_save_printer_config,
            commands::desktop_printer_send_raw,
            commands::desktop_printer_send_fallback_raw,
            commands::desktop_printer_send_driver_bitmap,
            commands::desktop_printer_send_driver_page,
            commands::desktop_printer_plan_backend,
            commands::desktop_printer_warmup_raw,
            commands::desktop_printer_transport_summary,
            commands::desktop_printer_disconnect_all,
            commands::desktop_printer_query_status,
            commands::desktop_printer_export_diagnostic,
            commands::desktop_printer_durable_jobs,
            commands::desktop_printer_durable_summary,
            commands::desktop_printer_retry_durable,
            commands::desktop_printer_cancel_durable,
            commands::desktop_printer_plan_generation,
            commands::desktop_printer_generate_native,
            commands::desktop_printer_generate_and_send,
            commands::desktop_printer_generator_summary,
            commands::desktop_get_identity,
            commands::desktop_get_next_sequence,
            commands::desktop_sync_data,
            commands::desktop_get_server_status,
            commands::desktop_get_license_status,
            commands::desktop_set_app_mode,
            commands::desktop_renderer_ready,
            commands::desktop_network_summary,
            commands::desktop_ingress_summary,
            commands::desktop_telemetry_summary,
            commands::desktop_telemetry_flush,
            commands::desktop_get_station_info,
            commands::desktop_get_products,
            commands::desktop_get_fixed_weight_products,
            commands::desktop_get_containers,
            commands::desktop_get_label,
            commands::desktop_get_all_labels,
            commands::desktop_get_barcode_template,
            commands::desktop_get_printers,
            commands::desktop_get_print_jobs,
            commands::desktop_update_print_job_progress,
            commands::desktop_complete_print_job,
            commands::desktop_delete_print_job,
            commands::desktop_record_pack,
            commands::desktop_close_box,
            commands::desktop_get_latest_counters,
            commands::desktop_get_open_pallet_content,
            commands::desktop_get_pallet_render_data,
            commands::desktop_close_pallet,
            commands::desktop_delete_pack,
            commands::desktop_delete_box,
            commands::desktop_list_operators,
            commands::desktop_session_get,
            commands::desktop_session_set,
            commands::desktop_session_logout,
            commands::desktop_log,
            commands::desktop_open_logs_folder,
            commands::desktop_quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LabelPilot Tauri runtime");
}
