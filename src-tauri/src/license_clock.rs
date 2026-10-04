//! Trusted date for licence expiry on the station.
//!
//! An expired subscription token is accepted for server data only during the
//! grace period. The date it is judged at is never earlier than the latest date
//! this station has already seen (a small mark file in the data directory), so
//! turning the Windows clock back does not reopen the grace period. Nothing here
//! stops printing: it only decides whether new server data is accepted.
use crate::persisted::PersistedState;
use std::fs;
use time::{Date, OffsetDateTime};

const MARK_FILE: &str = "license-clock";
/// Daylight-saving and time-zone corrections are not a rollback.
const ROLLBACK_TOLERANCE_DAYS: i64 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TrustedDate {
    /// The date expiry is judged at.
    pub today: Date,
    /// The Windows clock is more than a day behind a date this station saw.
    pub rollback: bool,
    pub mark: Date,
}

pub fn trusted_today(persisted: &PersistedState) -> TrustedDate {
    trusted_today_at(persisted, OffsetDateTime::now_utc().date())
}

pub fn trusted_today_at(persisted: &PersistedState, now: Date) -> TrustedDate {
    let path = persisted.data_dir().join(MARK_FILE);
    let stored = fs::read_to_string(&path)
        .ok()
        .and_then(|text| parse_date(text.trim()));
    if stored.is_none_or(|mark| now > mark) {
        // Date granularity: at most one small write per day.
        let _ = fs::write(&path, format_date(now));
    }
    let mark = stored.map_or(now, |mark| mark.max(now));
    let rollback = (mark - now).whole_days() > ROLLBACK_TOLERANCE_DAYS;
    TrustedDate {
        today: if rollback { mark } else { now },
        rollback,
        mark,
    }
}

fn parse_date(value: &str) -> Option<Date> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    let month = time::Month::try_from(value[5..7].parse::<u8>().ok()?).ok()?;
    let day = value[8..10].parse::<u8>().ok()?;
    Date::from_calendar_date(year, month, day).ok()
}

pub fn format_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Month;

    fn day(year: i32, month: Month, day: u8) -> Date {
        Date::from_calendar_date(year, month, day).unwrap()
    }

    fn directory(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "labelpilot-license-clock-{name}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn turning_the_clock_back_is_judged_at_the_mark() {
        let path = directory("rollback");
        let persisted = PersistedState::for_data_dir(path.clone());
        let first = trusted_today_at(&persisted, day(2027, Month::February, 1));
        assert_eq!(first.today, day(2027, Month::February, 1));
        assert!(!first.rollback);
        let rolled_back = trusted_today_at(&persisted, day(2026, Month::December, 1));
        assert!(rolled_back.rollback);
        assert_eq!(rolled_back.today, day(2027, Month::February, 1));
        // The mark never moves back.
        assert_eq!(
            fs::read_to_string(path.join(MARK_FILE)).unwrap(),
            "2027-02-01"
        );
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn a_one_day_correction_is_not_a_rollback() {
        let path = directory("tolerance");
        let persisted = PersistedState::for_data_dir(path.clone());
        trusted_today_at(&persisted, day(2026, Month::December, 10));
        let corrected = trusted_today_at(&persisted, day(2026, Month::December, 9));
        assert!(!corrected.rollback);
        assert_eq!(corrected.today, day(2026, Month::December, 9));
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn an_unreadable_mark_starts_over() {
        let path = directory("garbage");
        fs::write(path.join(MARK_FILE), "not a date").unwrap();
        let persisted = PersistedState::for_data_dir(path.clone());
        let reading = trusted_today_at(&persisted, day(2026, Month::October, 3));
        assert_eq!(reading.today, day(2026, Month::October, 3));
        assert!(!reading.rollback);
        let _ = fs::remove_dir_all(path);
    }
}
