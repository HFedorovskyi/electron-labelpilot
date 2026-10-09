//! Delivers the production report of the Slint station: right after a new label, a job
//! step or an error (bursts are batched by a short pause), and every 5 minutes to catch
//! up. While the server is unreachable reports wait in the outbox (station_report).

use crate::operational::OperationalState;
use crate::persisted::PersistedState;
use crate::station_report;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

const STARTUP_DELAY: Duration = Duration::from_secs(8);
const BATCH_PAUSE: Duration = Duration::from_millis(1_500);
const CATCH_UP_INTERVAL: Duration = Duration::from_secs(5 * 60);

static STARTED: AtomicBool = AtomicBool::new(false);

type Resolver = Box<dyn Fn(&PersistedState) -> Option<String> + Send>;

/// Starts the reporter once per process. `server_base_url` resolves the configured server
/// (the same address the station pings); None while no server is configured.
pub fn start(
    persisted: Arc<PersistedState>,
    operational: OperationalState,
    server_base_url: impl Fn(&PersistedState) -> Option<String> + Send + 'static,
) -> Result<(), String> {
    if STARTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(1)
        .build()
        .map_err(|error| format!("failed to build the report HTTP client: {error}"))?;
    let wake = Arc::new((Mutex::new(false), Condvar::new()));
    {
        let wake = Arc::clone(&wake);
        station_report::set_wake_hook(move || {
            let (flag, signal) = &*wake;
            if let Ok(mut pending) = flag.lock() {
                *pending = true;
                signal.notify_one();
            }
        });
    }
    station_report::set_error_journal(operational);
    let resolver: Resolver = Box::new(server_base_url);
    thread::Builder::new()
        .name("lp-station-report".into())
        .spawn(move || run(persisted, client, wake, resolver))
        .map_err(|error| format!("failed to start the report thread: {error}"))?;
    Ok(())
}

fn run(
    persisted: Arc<PersistedState>,
    client: reqwest::blocking::Client,
    wake: Arc<(Mutex<bool>, Condvar)>,
    server_base_url: Resolver,
) {
    thread::sleep(STARTUP_DELAY);
    let mut last_error = String::new();
    loop {
        let base_url = server_base_url(&persisted);
        let language = report_language(&persisted);
        match station_report::deliver(&persisted, Some(&client), base_url.as_deref(), &language) {
            Ok(_) => last_error.clear(),
            Err(error) => {
                // Journaled once per distinct error (it travels with the next report).
                if error != last_error {
                    station_report::record_warning("sync", &format!("Отчёт для сервера: {error}"));
                    last_error = error;
                }
            }
        }
        if wait_for_news(&wake, CATCH_UP_INTERVAL) {
            thread::sleep(BATCH_PAUSE);
            if let Ok(mut pending) = wake.0.lock() {
                *pending = false;
            }
        }
    }
}

/// Sleeps until something new is poked or the catch-up interval passes; true = woken.
fn wait_for_news(wake: &(Mutex<bool>, Condvar), timeout: Duration) -> bool {
    let (flag, signal) = wake;
    let Ok(pending) = flag.lock() else {
        thread::sleep(timeout);
        return false;
    };
    match signal.wait_timeout_while(pending, timeout, |pending| !*pending) {
        Ok((pending, _)) => *pending,
        Err(_) => false,
    }
}

fn report_language(persisted: &PersistedState) -> String {
    persisted
        .load_printer_config()
        .get("language")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("ru")
        .to_owned()
}
