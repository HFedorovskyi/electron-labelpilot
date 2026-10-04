//! Vendor-signed seat list: the workstations that hold a seat of a licence.
//!
//! A licence with the "seat-list" feature lets this station take server data only
//! when the data comes with a list, signed by the vendor's sales service, that names
//! this computer's hardware fingerprint. The customer's server cannot sign lists, so
//! it cannot feed more stations than the seats sold. The newest list seen for the
//! licence is kept (`seat-list.token`): an older one sent later does not replace it.
//!
//! Nothing here stops printing: without a valid list only new server data is refused.
use crate::crypto::{self, PushDecodeError};
use crate::persisted::PersistedState;
use serde::Deserialize;
use time::Date;

pub const SEAT_LIST_FEATURE: &str = "seat-list";
const SEAT_LIST_KIND: &str = "labelpilot-seats-v1";
const MAX_SEAT_LIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_STATIONS: usize = 100_000;
const FIELDS: [&str; 7] = [
    "expires",
    "issued",
    "kind",
    "license_id",
    "machine_id",
    "max_stations",
    "stations",
];

/// The licence a list must belong to.
#[derive(Clone, Copy, Debug)]
pub struct Holder<'a> {
    pub license_id: &'a str,
    pub machine_id: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SeatList {
    pub expires: String,
    pub issued: String,
    pub kind: String,
    pub license_id: String,
    pub machine_id: String,
    pub max_stations: Option<u32>,
    pub stations: Vec<String>,
}

impl SeatList {
    pub fn lists(&self, fingerprint: &str) -> bool {
        self.stations
            .binary_search_by(|station| station.as_str().cmp(fingerprint))
            .is_ok()
    }

    fn expiry(&self) -> Option<Date> {
        crypto::parse_iso_date(&self.expires).ok()
    }

    pub fn is_valid_at(&self, today: Date) -> bool {
        self.expiry().is_some_and(|expiry| today <= expiry)
    }

    fn belongs_to(&self, holder: Holder<'_>) -> bool {
        self.license_id == holder.license_id && self.machine_id == holder.machine_id
    }
}

pub fn verify(token: &str, public_key: &[u8; 32]) -> Result<SeatList, PushDecodeError> {
    let value = crypto::verify_canonical_token(token, public_key, MAX_SEAT_LIST_BYTES, &FIELDS)?;
    let list: SeatList = serde_json::from_value(value)
        .map_err(|_| invalid("Seat list payload types are invalid"))?;
    let issued_ok = valid_issued(&list.issued);
    let sorted_unique = list.stations.windows(2).all(|pair| pair[0] < pair[1]);
    if list.kind != SEAT_LIST_KIND
        || !crypto::valid_license_id(&list.license_id)
        || !crypto::valid_machine_id(&list.machine_id)
        || !issued_ok
        || list.expiry().is_none()
        || list
            .max_stations
            .is_some_and(|stations| stations == 0 || stations as usize > MAX_STATIONS)
        || list.stations.len() > MAX_STATIONS
        || !list.stations.iter().all(|station| crypto::valid_machine_id(station))
        || !sorted_unique
        || list
            .max_stations
            .is_some_and(|stations| list.stations.len() > stations as usize)
    {
        return Err(invalid("Seat list is outside the accepted contract"));
    }
    Ok(list)
}

/// `YYYY-MM-DDTHH:MM:SSZ`; newer lists compare greater as text.
fn valid_issued(value: &str) -> bool {
    let bytes = value.as_bytes();
    let field = |range: std::ops::Range<usize>, limit: u8| {
        bytes[range.clone()].iter().all(u8::is_ascii_digit)
            && value[range].parse::<u8>().is_ok_and(|number| number < limit)
    };
    bytes.len() == 20
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'Z'
        && crypto::parse_iso_date(&value[..10]).is_ok()
        && field(11..13, 24)
        && field(14..16, 60)
        && field(17..19, 60)
}

fn invalid(message: &str) -> PushDecodeError {
    PushDecodeError::Invalid(message.to_owned())
}

fn stored(persisted: &PersistedState, holder: Holder<'_>, public_key: &[u8; 32]) -> Option<SeatList> {
    verify(&persisted.load_seat_list_token()?, public_key)
        .ok()
        .filter(|list| list.belongs_to(holder))
}

/// The newest valid list of `holder` among the one kept and `incoming`; a newer
/// incoming list is kept.
fn newest(
    persisted: &PersistedState,
    holder: Holder<'_>,
    incoming: Option<&str>,
    public_key: &[u8; 32],
) -> Option<SeatList> {
    let kept = stored(persisted, holder, public_key);
    let fresh = incoming.and_then(|token| {
        verify(token, public_key)
            .ok()
            .filter(|list| list.belongs_to(holder))
            .map(|list| (token, list))
    });
    match (kept, fresh) {
        (Some(kept), Some((token, fresh))) if fresh.issued > kept.issued => {
            let _ = persisted.save_seat_list_token(token);
            Some(fresh)
        }
        (Some(kept), _) => Some(kept),
        (None, Some((token, fresh))) => {
            let _ = persisted.save_seat_list_token(token);
            Some(fresh)
        }
        (None, None) => None,
    }
}

/// Admits a push of `holder`'s licence when the newest list names this station.
pub fn admit(
    persisted: &PersistedState,
    holder: Holder<'_>,
    embedded: Option<&str>,
    today: Date,
    fingerprint: Option<&str>,
    public_key: &[u8; 32],
) -> Result<(), PushDecodeError> {
    let refuse = |reason: &str| {
        Err(PushDecodeError::Forbidden(format!(
            "{reason} Новые данные с сервера не приняты; печать по имеющимся данным продолжается."
        )))
    };
    let Some(list) = newest(persisted, holder, embedded, public_key) else {
        return refuse("Лицензия требует список мест поставщика, а сервер его не передал.");
    };
    if !list.is_valid_at(today) {
        return refuse(&format!(
            "Список мест поставщика истёк {}. Обновите его на сервере.",
            list.expires
        ));
    }
    match fingerprint {
        Some(fingerprint) if list.lists(fingerprint) => Ok(()),
        _ => refuse("Этой станции нет в списке мест, подписанном поставщиком."),
    }
}

/// Keeps a list from the server's ping reply when it is newer than the kept one.
#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
pub fn keep_newer(
    persisted: &PersistedState,
    holder: Holder<'_>,
    token: &str,
    public_key: &[u8; 32],
) -> Result<bool, String> {
    let incoming = verify(token, public_key).map_err(|error| format!("seat list rejected: {error}"))?;
    if !incoming.belongs_to(holder) {
        return Err("seat list belongs to another licence".to_owned());
    }
    if stored(persisted, holder, public_key).is_some_and(|kept| kept.issued >= incoming.issued) {
        return Ok(false);
    }
    persisted.save_seat_list_token(token)?;
    Ok(true)
}

/// What the operator sees about the seat list of this station's licence.
#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StationSeatList {
    /// A valid list names this station.
    pub listed: bool,
    /// No list from the server yet.
    pub missing: bool,
    pub expired: bool,
    pub expires: Option<String>,
    pub days_left: Option<i64>,
}

#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
pub fn station_status(
    persisted: &PersistedState,
    holder: Holder<'_>,
    today: Date,
    fingerprint: Option<&str>,
    public_key: &[u8; 32],
) -> StationSeatList {
    let Some(list) = stored(persisted, holder, public_key) else {
        return StationSeatList {
            listed: false,
            missing: true,
            expired: false,
            expires: None,
            days_left: None,
        };
    };
    let expired = !list.is_valid_at(today);
    StationSeatList {
        listed: !expired && fingerprint.is_some_and(|fingerprint| list.lists(fingerprint)),
        missing: false,
        expired,
        days_left: list.expiry().map(|expiry| (expiry - today).whole_days().max(0)),
        expires: Some(list.expires),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;

    const FIXTURE: &str = include_str!("../../tests/fixtures/seat-list-contract.json");

    struct Fixture {
        public_key: [u8; 32],
        token: String,
        listed: String,
        unlisted: String,
        license_id: String,
        machine_id: String,
    }

    fn fixture() -> Fixture {
        let value: Value = serde_json::from_str(FIXTURE).unwrap();
        let hex = value["public_key_hex"].as_str().unwrap();
        let mut public_key = [0_u8; 32];
        for (index, byte) in public_key.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap();
        }
        Fixture {
            public_key,
            token: value["token"].as_str().unwrap().to_owned(),
            listed: value["listed_fingerprint"].as_str().unwrap().to_owned(),
            unlisted: value["unlisted_fingerprint"].as_str().unwrap().to_owned(),
            license_id: value["payload"]["license_id"].as_str().unwrap().to_owned(),
            machine_id: value["payload"]["machine_id"].as_str().unwrap().to_owned(),
        }
    }

    fn state(name: &str) -> (PersistedState, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "labelpilot-seat-list-{name}-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        (PersistedState::for_data_dir(path.clone()), path)
    }

    fn day(value: &str) -> Date {
        crypto::parse_iso_date(value).unwrap()
    }

    #[test]
    fn the_cross_language_fixture_verifies() {
        let fixture = fixture();
        let list = verify(&fixture.token, &fixture.public_key).unwrap();
        assert_eq!(list.license_id, fixture.license_id);
        assert_eq!(list.expires, "2027-01-03");
        assert!(list.lists(&fixture.listed));
        assert!(!list.lists(&fixture.unlisted));
        let (body, signature) = fixture.token.split_once('.').unwrap();
        let tampered = format!(
            "{body}.{}{}",
            &signature[..signature.len() - 2],
            if signature.ends_with("AA") { "BA" } else { "AA" }
        );
        assert!(verify(&tampered, &fixture.public_key).is_err());
        assert!(verify(&fixture.token, &[7_u8; 32]).is_err());
    }

    #[test]
    fn only_a_listed_station_takes_data_while_the_list_is_valid() {
        let fixture = fixture();
        let (persisted, path) = state("admit");
        let holder = Holder {
            license_id: &fixture.license_id,
            machine_id: &fixture.machine_id,
        };
        let admit_at = |embedded: Option<&str>, today: &str, fingerprint: &str| {
            admit(&persisted, holder, embedded, day(today), Some(fingerprint), &fixture.public_key)
        };
        // No list at all.
        assert!(admit_at(None, "2026-10-06", &fixture.listed).unwrap_err().is_forbidden());
        // The list arrives with the push and is kept.
        assert!(admit_at(Some(&fixture.token), "2026-10-06", &fixture.listed).is_ok());
        assert_eq!(persisted.load_seat_list_token().as_deref(), Some(fixture.token.as_str()));
        assert!(admit_at(None, "2027-01-03", &fixture.listed).is_ok());
        assert!(admit_at(None, "2026-10-06", &fixture.unlisted).unwrap_err().is_forbidden());
        assert!(admit_at(None, "2027-01-04", &fixture.listed).unwrap_err().is_forbidden());
        // Unknown hardware is never listed.
        assert!(admit(&persisted, holder, None, day("2026-10-06"), None, &fixture.public_key).is_err());
        // A list of another licence does not count.
        let other = Holder {
            license_id: "another-licence",
            machine_id: &fixture.machine_id,
        };
        assert!(admit(&persisted, other, Some(&fixture.token), day("2026-10-06"), Some(&fixture.listed), &fixture.public_key).is_err());
        std::fs::remove_dir_all(path).ok();
    }

    #[test]
    fn a_ping_list_is_kept_only_when_newer_and_ours() {
        let fixture = fixture();
        let (persisted, path) = state("keep");
        let holder = Holder {
            license_id: &fixture.license_id,
            machine_id: &fixture.machine_id,
        };
        assert_eq!(keep_newer(&persisted, holder, &fixture.token, &fixture.public_key), Ok(true));
        assert_eq!(keep_newer(&persisted, holder, &fixture.token, &fixture.public_key), Ok(false));
        let other = Holder {
            license_id: &fixture.license_id,
            machine_id: "ffffffffffffffffffffffffffffffff",
        };
        assert!(keep_newer(&persisted, other, &fixture.token, &fixture.public_key).is_err());
        let status = station_status(&persisted, holder, day("2026-12-24"), Some(&fixture.listed), &fixture.public_key);
        assert_eq!(
            status,
            StationSeatList {
                listed: true,
                missing: false,
                expired: false,
                expires: Some("2027-01-03".to_owned()),
                days_left: Some(10),
            }
        );
        assert!(!station_status(&persisted, holder, day("2026-12-24"), Some(&fixture.unlisted), &fixture.public_key).listed);
        std::fs::remove_dir_all(path).ok();
    }
}
