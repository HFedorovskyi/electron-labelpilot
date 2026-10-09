//! Delivers the production report of the Slint station: errors and finished jobs a moment
//! after they happen, new labels and job steps together within half a minute (a busy line
//! prints a pack every few seconds; one report per pack would flood the server), and every
//! 5 minutes to catch up. While the server is unreachable reports wait in the outbox
//! (station_report).

use crate::operational::OperationalState;
use crate::persisted::PersistedState;
use crate::station_report;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

const STARTUP_DELAY: Duration = Duration::from_secs(8);
const BATCH_PAUSE: Duration = Duration::from_millis(1_500);
const LABEL_BATCH: Duration = Duration::from_secs(30);
const CATCH_UP_INTERVAL: Duration = Duration::from_secs(5 * 60);

static STARTED: AtomicBool = AtomicBool::new(false);

type Resolver = Box<dyn Fn(&PersistedState) -> Option<String> + Send>;

/// What has happened since the last delivery.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct News {
    /// An error or a finished job: send in a moment.
    urgent: bool,
    /// New labels or job steps: send together, a little later.
    labels: bool,
}

type Wake = Arc<(Mutex<News>, Condvar)>;

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
    let wake: Wake = Arc::new((Mutex::new(News::default()), Condvar::new()));
    {
        let wake = Arc::clone(&wake);
        station_report::set_wake_hook(move |urgent| {
            let (news, signal) = &*wake;
            if let Ok(mut news) = news.lock() {
                if urgent {
                    news.urgent = true;
                } else {
                    news.labels = true;
                }
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
    wake: Wake,
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
        wait_for_delivery(&wake, CATCH_UP_INTERVAL, LABEL_BATCH, BATCH_PAUSE);
    }
}

/// Waits until the next delivery is due: the catch-up interval with nothing new, a short
/// pause after urgent news (to batch a burst), or the label batch after new labels — cut
/// short by urgent news. Clears the news it consumed.
fn wait_for_delivery(wake: &(Mutex<News>, Condvar), catch_up: Duration, label_batch: Duration, pause: Duration) {
    let (news, signal) = wake;
    let Ok(guard) = news.lock() else {
        thread::sleep(catch_up);
        return;
    };
    let Ok((guard, _)) = signal.wait_timeout_while(guard, catch_up, |news| !news.urgent && !news.labels) else {
        return;
    };
    let guard = if guard.urgent {
        guard
    } else if guard.labels {
        match signal.wait_timeout_while(guard, label_batch, |news| !news.urgent) {
            Ok((guard, _)) => guard,
            Err(_) => return,
        }
    } else {
        return; // catch-up interval passed with nothing new
    };
    let urgent = guard.urgent;
    drop(guard);
    if urgent {
        thread::sleep(pause);
    }
    if let Ok(mut news) = news.lock() {
        *news = News::default();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn wake_with(news: News) -> Arc<(Mutex<News>, Condvar)> {
        Arc::new((Mutex::new(news), Condvar::new()))
    }

    const LONG: Duration = Duration::from_secs(30);
    const BATCH: Duration = Duration::from_millis(400);
    const PAUSE: Duration = Duration::from_millis(50);

    #[test]
    fn urgent_news_goes_out_after_a_short_pause() {
        let wake = wake_with(News { urgent: true, labels: false });
        let started = Instant::now();
        wait_for_delivery(&wake, LONG, LONG, PAUSE);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(*wake.0.lock().unwrap(), News::default());
    }

    #[test]
    fn labels_wait_for_the_batch() {
        let wake = wake_with(News { urgent: false, labels: true });
        let started = Instant::now();
        wait_for_delivery(&wake, LONG, BATCH, PAUSE);
        assert!(started.elapsed() >= BATCH);
        assert_eq!(*wake.0.lock().unwrap(), News::default());
    }

    #[test]
    fn urgent_news_cuts_the_label_batch_short() {
        let wake = wake_with(News { urgent: false, labels: true });
        let poker = Arc::clone(&wake);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            let (news, signal) = &*poker;
            news.lock().unwrap().urgent = true;
            signal.notify_one();
        });
        let started = Instant::now();
        wait_for_delivery(&wake, LONG, LONG, PAUSE);
        handle.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn nothing_new_waits_for_the_catch_up() {
        let wake = wake_with(News::default());
        let started = Instant::now();
        wait_for_delivery(&wake, BATCH, LONG, PAUSE);
        assert!(started.elapsed() >= BATCH);
    }
}
