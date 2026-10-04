use crate::persisted::PersistedState;
use aes::Aes256;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use ed25519_dalek::{Signature, VerifyingKey};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::collections::HashSet;
use std::fmt;
use std::sync::Mutex;
use time::{Date, Month};

const LPI2_MAGIC: &[u8] = b"LPI2\n";
/// Days an expired subscription token is still accepted for server data
/// (the server's licensing/clock.py GRACE_DAYS and license guard match it).
pub const LICENSE_GRACE_DAYS: i64 = 14;
/// From this many days before expiry the station asks its server for a renewal.
#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
pub const LICENSE_RENEWAL_NOTICE_DAYS: i64 = 30;
const MAX_TOKEN_BYTES: usize = 64 * 1024;
const HKDF_SALT: &[u8] = b"labelpilot-data-key|salt|v1";
const LICENSE_PUBLIC_KEY: [u8; 32] = [
    0xbd, 0x77, 0x06, 0x82, 0xb1, 0xbe, 0xf5, 0xaa, 0x9c, 0x08, 0x13, 0x20, 0xda, 0xd2, 0x5e, 0x7e,
    0x1c, 0x81, 0x75, 0x2e, 0x35, 0x7b, 0xde, 0xb3, 0x6d, 0x90, 0x16, 0xb4, 0xaf, 0xe4, 0x5e, 0x56,
];

type Aes256CbcDecryptor = cbc::Decryptor<Aes256>;
#[allow(dead_code)]
type Aes256CbcEncryptor = cbc::Encryptor<Aes256>;

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum PushDecodeError {
    Unauthorized,
    Invalid(String),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LicenseTokenClaims {
    // Declaration order is alphabetical so serde_json emits the canonical order used by
    // the Python and Edge signers.
    customer: String,
    edition: String,
    expires: Option<String>,
    features: Vec<String>,
    issued: String,
    key_version: u32,
    license_id: String,
    machine_id: String,
    max_stations: Option<u32>,
}

impl PushDecodeError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }
}

impl fmt::Display for PushDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized => formatter.write_str("Unauthorized"),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

#[derive(Debug)]
pub struct DecodedPush {
    pub value: Value,
    token: Option<String>,
    license: Option<LicenseTokenClaims>,
}

impl DecodedPush {
    pub fn persist_verified_token(&self, persisted: &PersistedState) -> Result<bool, String> {
        let Some(token) = self.token.as_deref() else {
            return Ok(false);
        };
        let Some(incoming) = self.license.as_ref() else {
            return Err("verified LPI2 token has no license claims".to_owned());
        };
        persist_token_with_key(persisted, token, incoming, &LICENSE_PUBLIC_KEY)
    }
}

/// Stores a verified token. A token of a different license (or server machine)
/// never replaces the one the station is bound to; an unreadable or tampered
/// persisted token is replaced, so a damaged file cannot block every later sync.
fn persist_token_with_key(
    persisted: &PersistedState,
    token: &str,
    incoming: &LicenseTokenClaims,
    public_key: &[u8; 32],
) -> Result<bool, String> {
    if let Some(existing) = persisted.load_license_token() {
        if existing == token {
            return Ok(false);
        }
        if let Ok(current) = verify_license_token_allow_expired(&existing, public_key) {
            if current.license_id != incoming.license_id
                || current.machine_id != incoming.machine_id
                // ISO dates compare as text: never roll back to an older issue.
                || incoming.issued < current.issued
            {
                return Ok(false);
            }
        }
    }
    persisted.save_license_token(token)?;
    Ok(true)
}

/// The vendor license this station is bound to, from its persisted token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StationLicense {
    pub customer: String,
    pub edition: String,
    pub license_id: String,
    pub issued: String,
    pub expires: Option<String>,
}

#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LicenseTerm {
    Lifetime,
    Active,
    /// Expires within LICENSE_RENEWAL_NOTICE_DAYS.
    Expiring,
    /// Expired; server data is still accepted until `grace_until`.
    Grace,
    /// Expired and the grace period is over: no new server data. Printing
    /// with the data already on the station continues.
    Expired,
}

#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
impl LicenseTerm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lifetime => "lifetime",
            Self::Active => "active",
            Self::Expiring => "expiring",
            Self::Grace => "grace",
            Self::Expired => "expired",
        }
    }

    pub fn wants_renewal(self) -> bool {
        matches!(self, Self::Expiring | Self::Grace | Self::Expired)
    }
}

#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LicenseTermInfo {
    pub term: LicenseTerm,
    pub grace_until: Option<Date>,
    /// Days to the expiry date, or in grace to the end of the grace period.
    pub days_left: Option<i64>,
}

#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
impl StationLicense {
    pub fn term(&self, today: Date) -> LicenseTermInfo {
        let Some(expiry) = self
            .expires
            .as_deref()
            .and_then(|value| parse_iso_date(value).ok())
        else {
            return LicenseTermInfo {
                term: LicenseTerm::Lifetime,
                grace_until: None,
                days_left: None,
            };
        };
        let grace_until = expiry + time::Duration::days(LICENSE_GRACE_DAYS);
        let (term, target) = if today > grace_until {
            (LicenseTerm::Expired, today)
        } else if today > expiry {
            (LicenseTerm::Grace, grace_until)
        } else if (expiry - today).whole_days() <= LICENSE_RENEWAL_NOTICE_DAYS {
            (LicenseTerm::Expiring, expiry)
        } else {
            (LicenseTerm::Active, expiry)
        };
        LicenseTermInfo {
            term,
            grace_until: Some(grace_until),
            days_left: Some((target - today).whole_days().max(0)),
        }
    }
}

/// `None` = no vendor-signed license token on this station: a trial or an
/// unlicensed copy. Labels printed then carry a DEMO mark. An expired token
/// still counts here; subscription grace is decided separately.
pub fn station_license(persisted: &PersistedState) -> Option<StationLicense> {
    station_license_with_key(persisted.load_license_token()?, &LICENSE_PUBLIC_KEY)
}

fn station_license_with_key(token: String, public_key: &[u8; 32]) -> Option<StationLicense> {
    type Verified = ([u8; 32], String, Option<StationLicense>);
    // Asked for every printed label: verify each distinct token only once.
    static LAST: Mutex<Option<Verified>> = Mutex::new(None);
    if let Ok(cache) = LAST.lock() {
        if let Some((key, cached, license)) = cache.as_ref() {
            if key == public_key && *cached == token {
                return license.clone();
            }
        }
    }
    let license = verify_license_token_allow_expired(&token, public_key)
        .ok()
        .map(|claims| StationLicense {
            customer: claims.customer,
            edition: claims.edition,
            license_id: claims.license_id,
            issued: claims.issued,
            expires: claims.expires,
        });
    if let Ok(mut cache) = LAST.lock() {
        *cache = Some((*public_key, token, license.clone()));
    }
    license
}

/// Adopts the license token the station's own server returns in its ping reply
/// (the same public, vendor-signed token every LPI2 push carries) — so a station
/// whose token file was lost leaves DEMO mode without waiting for a data push,
/// and a renewed subscription reaches the station within a minute.
/// Same rules as a push: it must verify, be within its grace period at the
/// trusted date, match the binding and not be an older issue.
#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
pub fn adopt_server_token(persisted: &PersistedState, token: &str) -> Result<bool, String> {
    adopt_server_token_with_key(persisted, token, &LICENSE_PUBLIC_KEY)
}

#[cfg_attr(not(feature = "native-ui"), allow(dead_code))]
fn adopt_server_token_with_key(
    persisted: &PersistedState,
    token: &str,
    public_key: &[u8; 32],
) -> Result<bool, String> {
    let today = crate::license_clock::trusted_today(persisted).today;
    let incoming = verify_license_token_at(token, public_key, today)
        .map_err(|error| format!("server license token rejected: {error}"))?;
    persist_token_with_key(persisted, token, &incoming, public_key)
}

#[allow(dead_code)]
pub fn encrypt_report(persisted: &PersistedState, value: &Value) -> Result<Vec<u8>, String> {
    let token = persisted.load_license_token().ok_or_else(|| {
        "Станция не активирована: нет лицензии. Импортируйте файл идентификации (.lpi).".to_owned()
    })?;
    encode_lpi2_with_key(&token, value, &LICENSE_PUBLIC_KEY).map_err(|error| error.to_string())
}

#[allow(dead_code)]
fn encode_lpi2_with_key(
    token: &str,
    value: &Value,
    public_key: &[u8; 32],
) -> Result<Vec<u8>, PushDecodeError> {
    if !token.is_ascii() || token.len() > MAX_TOKEN_BYTES {
        return Err(PushDecodeError::Invalid(
            "LPI2 token length is outside the accepted range".to_owned(),
        ));
    }
    // Production records always reach the server (traceability), even after the
    // subscription has expired: only incoming data is gated by the licence term.
    let license = verify_license_token_allow_expired(token, public_key)?;
    let key = derive_data_key(&license.license_id, i64::from(license.key_version))?;
    let mut iv = [0_u8; 16];
    getrandom::fill(&mut iv).map_err(|error| {
        PushDecodeError::Invalid(format!("failed to generate LPI2 IV: {error}"))
    })?;
    let plaintext = serde_json::to_vec(value).map_err(|error| {
        PushDecodeError::Invalid(format!("failed to serialize report JSON: {error}"))
    })?;
    let ciphertext = Aes256CbcEncryptor::new_from_slices(&key, &iv)
        .map_err(|_| PushDecodeError::Invalid("Invalid LPI2 AES key or IV".to_owned()))?
        .encrypt_padded_vec_mut::<Pkcs7>(&plaintext);
    let mut output =
        Vec::with_capacity(LPI2_MAGIC.len() + token.len() + 1 + iv.len() + ciphertext.len());
    output.extend_from_slice(LPI2_MAGIC);
    output.extend_from_slice(token.as_bytes());
    output.push(b'\n');
    output.extend_from_slice(&iv);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

pub fn decode_push_body(
    persisted: &PersistedState,
    body: &[u8],
) -> Result<DecodedPush, PushDecodeError> {
    if body.starts_with(LPI2_MAGIC) {
        let today = crate::license_clock::trusted_today(persisted).today;
        return decode_lpi2_with_key(body, &LICENSE_PUBLIC_KEY, today);
    }
    if persisted.load_license_token().is_some() {
        return Err(PushDecodeError::Unauthorized);
    }
    let body = body.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(body);
    let value = serde_json::from_slice(body)
        .map_err(|error| PushDecodeError::Invalid(format!("Malformed JSON: {error}")))?;
    Ok(DecodedPush {
        value,
        token: None,
        license: None,
    })
}

fn decode_lpi2_with_key(
    blob: &[u8],
    public_key: &[u8; 32],
    today: Date,
) -> Result<DecodedPush, PushDecodeError> {
    if !blob.starts_with(LPI2_MAGIC) {
        return Err(PushDecodeError::Invalid("Missing LPI2 magic".to_owned()));
    }
    let rest = &blob[LPI2_MAGIC.len()..];
    let token_end = rest
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| PushDecodeError::Invalid("Malformed LPI2 token framing".to_owned()))?;
    if token_end == 0 || token_end > MAX_TOKEN_BYTES {
        return Err(PushDecodeError::Invalid(
            "LPI2 token length is outside the accepted range".to_owned(),
        ));
    }
    let token = std::str::from_utf8(&rest[..token_end])
        .map_err(|_| PushDecodeError::Invalid("LPI2 token must be ASCII".to_owned()))?;
    let encrypted = &rest[token_end + 1..];
    if encrypted.len() < 32 || !(encrypted.len() - 16).is_multiple_of(16) {
        return Err(PushDecodeError::Invalid(
            "Malformed LPI2 encrypted body length".to_owned(),
        ));
    }

    let license = verify_license_token_at(token, public_key, today)?;
    let key = derive_data_key(&license.license_id, i64::from(license.key_version))?;

    let (iv, ciphertext) = encrypted.split_at(16);
    let plaintext = Aes256CbcDecryptor::new_from_slices(&key, iv)
        .map_err(|_| PushDecodeError::Invalid("Invalid LPI2 AES key or IV".to_owned()))?
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|_| {
            PushDecodeError::Invalid("LPI2 ciphertext or padding is invalid".to_owned())
        })?;
    let value = serde_json::from_slice(&plaintext).map_err(|error| {
        PushDecodeError::Invalid(format!("LPI2 plaintext is not valid JSON: {error}"))
    })?;
    Ok(DecodedPush {
        value,
        token: Some(token.to_owned()),
        license: Some(license),
    })
}

fn derive_data_key(license_id: &str, key_version: i64) -> Result<[u8; 32], PushDecodeError> {
    let seed = format!("{license_id}|kv{key_version}");
    let info = format!("lpi-data-key|{license_id}|kv{key_version}");
    let hkdf = Hkdf::<Sha256>::new(Some(HKDF_SALT), seed.as_bytes());
    let mut key = [0_u8; 32];
    hkdf.expand(info.as_bytes(), &mut key)
        .map_err(|_| PushDecodeError::Invalid("LPI2 HKDF expansion failed".to_owned()))?;
    Ok(key)
}

#[cfg(test)]
fn verify_license_token(
    token: &str,
    public_key: &[u8; 32],
) -> Result<LicenseTokenClaims, PushDecodeError> {
    verify_license_token_at(token, public_key, time::OffsetDateTime::now_utc().date())
}

/// Rejects a token past its expiry date plus the grace period at `today`.
fn verify_license_token_at(
    token: &str,
    public_key: &[u8; 32],
    today: Date,
) -> Result<LicenseTokenClaims, PushDecodeError> {
    verify_license_token_with_policy(token, public_key, Some(today))
}

fn verify_license_token_allow_expired(
    token: &str,
    public_key: &[u8; 32],
) -> Result<LicenseTokenClaims, PushDecodeError> {
    verify_license_token_with_policy(token, public_key, None)
}

fn verify_license_token_with_policy(
    token: &str,
    public_key: &[u8; 32],
    judged_at: Option<Date>,
) -> Result<LicenseTokenClaims, PushDecodeError> {
    if !token.is_ascii()
        || token.trim() != token
        || token.is_empty()
        || token.len() > MAX_TOKEN_BYTES
    {
        return Err(PushDecodeError::Invalid(
            "License token size or encoding is invalid".to_owned(),
        ));
    }
    let mut parts = token.split('.');
    let payload_part = parts
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PushDecodeError::Invalid("Malformed license token".to_owned()))?;
    let signature_part = parts
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PushDecodeError::Invalid("Malformed license token".to_owned()))?;
    if parts.next().is_some() {
        return Err(PushDecodeError::Invalid(
            "Malformed license token".to_owned(),
        ));
    }
    let payload = URL_SAFE_NO_PAD
        .decode(payload_part)
        .map_err(|_| PushDecodeError::Invalid("Malformed license payload encoding".to_owned()))?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_part)
        .map_err(|_| PushDecodeError::Invalid("Malformed license signature encoding".to_owned()))?;
    if payload.len() > MAX_TOKEN_BYTES
        || URL_SAFE_NO_PAD.encode(&payload) != payload_part
        || URL_SAFE_NO_PAD.encode(&signature_bytes) != signature_part
    {
        return Err(PushDecodeError::Invalid(
            "License token is not canonical base64url".to_owned(),
        ));
    }
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| PushDecodeError::Invalid("Malformed Ed25519 signature length".to_owned()))?;
    let verifying_key = VerifyingKey::from_bytes(public_key)
        .map_err(|_| PushDecodeError::Invalid("Invalid Ed25519 public key".to_owned()))?;
    verifying_key
        .verify_strict(&payload, &signature)
        .map_err(|_| PushDecodeError::Invalid("Invalid license signature".to_owned()))?;

    let value: Value = serde_json::from_slice(&payload)
        .map_err(|_| PushDecodeError::Invalid("License payload is not valid JSON".to_owned()))?;
    let object = value
        .as_object()
        .ok_or_else(|| PushDecodeError::Invalid("License payload must be an object".to_owned()))?;
    const FIELDS: [&str; 9] = [
        "customer",
        "edition",
        "expires",
        "features",
        "issued",
        "key_version",
        "license_id",
        "machine_id",
        "max_stations",
    ];
    if object.len() != FIELDS.len() || !FIELDS.iter().all(|field| object.contains_key(*field)) {
        return Err(PushDecodeError::Invalid(
            "License fields do not match the supported contract".to_owned(),
        ));
    }
    let canonical = serde_json::to_vec(&value).map_err(|_| {
        PushDecodeError::Invalid("License payload cannot be canonicalized".to_owned())
    })?;
    if canonical != payload {
        return Err(PushDecodeError::Invalid(
            "License payload is not canonical JSON".to_owned(),
        ));
    }
    let license: LicenseTokenClaims = serde_json::from_value(value)
        .map_err(|_| PushDecodeError::Invalid("License payload types are invalid".to_owned()))?;
    if !bounded_text(&license.customer, 160)
        || !bounded_text(&license.edition, 120)
        || !valid_license_id(&license.license_id)
        || !valid_machine_id(&license.machine_id)
        || license.key_version == 0
        || license.key_version > 1_000_000
        || license
            .max_stations
            .is_some_and(|stations| stations == 0 || stations > 100_000)
        || license.features.len() > 64
        || license
            .features
            .iter()
            .any(|feature| !valid_feature(feature))
        || license.features.iter().collect::<HashSet<_>>().len() != license.features.len()
    {
        return Err(PushDecodeError::Invalid(
            "License claims are outside the accepted contract".to_owned(),
        ));
    }
    let issued = parse_iso_date(&license.issued)?;
    if let Some(expires) = license.expires.as_deref() {
        let expiry = parse_iso_date(expires)?;
        if expiry < issued {
            return Err(PushDecodeError::Invalid(
                "License expiry precedes its issue date".to_owned(),
            ));
        }
        if judged_at.is_some_and(|today| today > expiry + time::Duration::days(LICENSE_GRACE_DAYS))
        {
            return Err(PushDecodeError::Unauthorized);
        }
    }
    Ok(license)
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.chars().count() <= maximum
        && !value.chars().any(char::is_control)
}

fn valid_license_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=80).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_machine_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_feature(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn parse_iso_date(value: &str) -> Result<Date, PushDecodeError> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return Err(PushDecodeError::Invalid(
            "License date must be canonical YYYY-MM-DD".to_owned(),
        ));
    }
    let year = value[0..4]
        .parse::<i32>()
        .map_err(|_| PushDecodeError::Invalid("License date year is invalid".to_owned()))?;
    let month = value[5..7]
        .parse::<u8>()
        .ok()
        .and_then(|month| Month::try_from(month).ok())
        .ok_or_else(|| PushDecodeError::Invalid("License date month is invalid".to_owned()))?;
    let day = value[8..10]
        .parse::<u8>()
        .map_err(|_| PushDecodeError::Invalid("License date day is invalid".to_owned()))?;
    Date::from_calendar_date(year, month, day).map_err(|_| {
        PushDecodeError::Invalid("License date is not a real calendar date".to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use time::{Month, OffsetDateTime};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "labelpilot-crypto-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/lpi2-contract.json"))
            .expect("parse LPI2 fixture")
    }
    fn valid_license_payload() -> Value {
        json!({
            "customer": "Fixture Factory",
            "edition": "test",
            "expires": "2099-12-31",
            "features": ["sync", "printing"],
            "issued": "2026-01-01",
            "key_version": 3,
            "license_id": "fixture-license-2026",
            "machine_id": "0123456789abcdef0123456789abcdef",
            "max_stations": 1
        })
    }

    fn signed_test_token(value: &Value) -> (String, [u8; 32]) {
        let mut seed = [0_u8; 32];
        for (index, byte) in seed.iter_mut().enumerate() {
            *byte = index as u8;
        }
        let key = SigningKey::from_bytes(&seed);
        let payload = serde_json::to_vec(value).expect("serialize test payload");
        let signature = key.sign(&payload);
        (
            format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(payload),
                URL_SAFE_NO_PAD.encode(signature.to_bytes())
            ),
            key.verifying_key().to_bytes(),
        )
    }

    #[test]
    fn station_license_reads_the_verified_persisted_token() {
        let directory = TestDirectory::new("station-license");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let (token, public_key) = signed_test_token(&valid_license_payload());
        assert_eq!(
            persisted
                .load_license_token()
                .and_then(|token| station_license_with_key(token, &public_key)),
            None
        );
        persisted.save_license_token(&token).unwrap();
        let license =
            station_license_with_key(persisted.load_license_token().unwrap(), &public_key)
                .expect("verified licence");
        assert_eq!(license.customer, "Fixture Factory");
        assert_eq!(license.license_id, "fixture-license-2026");
        // A token that does not verify is no licence (DEMO), even if cached before.
        let mut tampered = token.clone();
        tampered.pop();
        tampered.push(if token.ends_with('A') { 'B' } else { 'A' });
        assert_eq!(station_license_with_key(tampered, &public_key), None);
        assert!(station_license_with_key(token, &public_key).is_some());
    }

    #[test]
    fn adopts_a_server_token_only_within_the_existing_binding() {
        let directory = TestDirectory::new("adopt-token");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let (token, public_key) = signed_test_token(&valid_license_payload());
        assert!(adopt_server_token_with_key(&persisted, &token, &public_key).unwrap());
        // The same token again writes nothing (pings repeat every minute).
        assert!(!adopt_server_token_with_key(&persisted, &token, &public_key).unwrap());

        let mut other = valid_license_payload();
        other["license_id"] = json!("other-license-2026");
        let (other_token, _) = signed_test_token(&other);
        assert!(!adopt_server_token_with_key(&persisted, &other_token, &public_key).unwrap());
        assert_eq!(
            persisted.load_license_token().as_deref(),
            Some(token.as_str())
        );

        let mut renewed = valid_license_payload();
        renewed["issued"] = json!("2026-06-01");
        let (renewed_token, _) = signed_test_token(&renewed);
        assert!(adopt_server_token_with_key(&persisted, &renewed_token, &public_key).unwrap());

        let mut expired = valid_license_payload();
        expired["expires"] = json!("2000-01-01");
        expired["issued"] = json!("1999-01-01");
        let (expired_token, _) = signed_test_token(&expired);
        assert!(adopt_server_token_with_key(&persisted, &expired_token, &public_key).is_err());
        assert!(adopt_server_token_with_key(&persisted, "garbage", &public_key).is_err());
    }

    #[test]
    fn expired_tokens_are_accepted_only_during_the_grace_period() {
        let mut payload = valid_license_payload();
        payload["expires"] = json!("2026-12-31");
        let (token, public_key) = signed_test_token(&payload);
        let on = |month: Month, day: u8, year: i32| {
            verify_license_token_at(
                &token,
                &public_key,
                Date::from_calendar_date(year, month, day).unwrap(),
            )
        };
        assert!(on(Month::December, 31, 2026).is_ok());
        assert!(on(Month::January, 14, 2027).is_ok());
        assert_eq!(
            on(Month::January, 15, 2027).unwrap_err(),
            PushDecodeError::Unauthorized
        );
        assert!(verify_license_token_allow_expired(&token, &public_key).is_ok());
    }

    #[test]
    fn licence_terms_follow_the_expiry_date() {
        let license = |expires: Option<&str>| StationLicense {
            customer: "Fixture Factory".to_owned(),
            edition: "test".to_owned(),
            license_id: "fixture-license-2026".to_owned(),
            issued: "2026-01-01".to_owned(),
            expires: expires.map(str::to_owned),
        };
        let date =
            |month: Month, day: u8, year: i32| Date::from_calendar_date(year, month, day).unwrap();
        let subscription = license(Some("2026-12-31"));
        let term = |today: Date| subscription.term(today);
        assert_eq!(
            term(date(Month::October, 3, 2026)).term,
            LicenseTerm::Active
        );
        let expiring = term(date(Month::December, 1, 2026));
        assert_eq!(
            (expiring.term, expiring.days_left),
            (LicenseTerm::Expiring, Some(30))
        );
        let grace = term(date(Month::January, 4, 2027));
        assert_eq!(
            (grace.term, grace.days_left),
            (LicenseTerm::Grace, Some(10))
        );
        assert_eq!(grace.grace_until, Some(date(Month::January, 14, 2027)));
        assert_eq!(
            term(date(Month::January, 15, 2027)).term,
            LicenseTerm::Expired
        );
        assert!(LicenseTerm::Grace.wants_renewal() && !LicenseTerm::Active.wants_renewal());
        let lifetime = license(None).term(date(Month::January, 1, 2099));
        assert_eq!(
            (lifetime.term, lifetime.days_left),
            (LicenseTerm::Lifetime, None)
        );
    }

    #[test]
    fn an_older_issue_never_replaces_the_persisted_token() {
        let directory = TestDirectory::new("older-issue");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let mut renewed = valid_license_payload();
        renewed["issued"] = json!("2026-06-01");
        let (renewed_token, public_key) = signed_test_token(&renewed);
        assert!(adopt_server_token_with_key(&persisted, &renewed_token, &public_key).unwrap());
        let (older_token, _) = signed_test_token(&valid_license_payload());
        assert!(!adopt_server_token_with_key(&persisted, &older_token, &public_key).unwrap());
        assert_eq!(
            persisted.load_license_token().as_deref(),
            Some(renewed_token.as_str())
        );
    }

    #[test]
    fn a_damaged_persisted_token_is_replaced_by_a_verified_one() {
        let directory = TestDirectory::new("damaged-token");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        persisted.save_license_token("damaged.token").unwrap();
        let (token, public_key) = signed_test_token(&valid_license_payload());
        assert!(adopt_server_token_with_key(&persisted, &token, &public_key).unwrap());
        assert_eq!(
            persisted.load_license_token().as_deref(),
            Some(token.as_str())
        );
    }

    #[test]
    fn rejects_signed_payloads_outside_the_license_contract() {
        let mut missing = valid_license_payload();
        missing
            .as_object_mut()
            .expect("object")
            .remove("machine_id");
        let (missing_token, public_key) = signed_test_token(&missing);
        assert!(matches!(
            verify_license_token(&missing_token, &public_key),
            Err(PushDecodeError::Invalid(_))
        ));

        let mut wrong_type = valid_license_payload();
        wrong_type["key_version"] = json!("3");
        let (wrong_type_token, public_key) = signed_test_token(&wrong_type);
        assert!(matches!(
            verify_license_token(&wrong_type_token, &public_key),
            Err(PushDecodeError::Invalid(_))
        ));

        let mut invalid_date = valid_license_payload();
        invalid_date["issued"] = json!("2026-02-30");
        let (invalid_date_token, public_key) = signed_test_token(&invalid_date);
        assert!(matches!(
            verify_license_token(&invalid_date_token, &public_key),
            Err(PushDecodeError::Invalid(_))
        ));

        let mut expired = valid_license_payload();
        expired["expires"] = json!("2000-01-01");
        expired["issued"] = json!("1999-01-01");
        let (expired_token, public_key) = signed_test_token(&expired);
        assert_eq!(
            verify_license_token(&expired_token, &public_key).unwrap_err(),
            PushDecodeError::Unauthorized
        );
        assert!(verify_license_token_allow_expired(&expired_token, &public_key).is_ok());
    }

    #[test]
    fn encrypts_and_decrypts_report_with_the_shared_lpi2_contract() {
        let fixture = fixture();
        let public_key_vec = hex_bytes(fixture["public_key_hex"].as_str().unwrap());
        let public_key: [u8; 32] = public_key_vec.try_into().expect("32-byte public key");
        let token = fixture["token"].as_str().unwrap();
        let value = json!({"station_uuid":"fixture", "printed_labels":[{"id":1}]});
        let blob = encode_lpi2_with_key(token, &value, &public_key).expect("encrypt report");
        assert!(blob.starts_with(LPI2_MAGIC));
        assert_eq!(
            decode_lpi2_with_key(&blob, &public_key, OffsetDateTime::now_utc().date())
                .unwrap()
                .value,
            value
        );
    }

    #[test]
    fn decrypts_the_node_lpi2_fixture_byte_for_byte() {
        let fixture = fixture();
        let public_key_vec = hex_bytes(fixture["public_key_hex"].as_str().unwrap());
        let public_key: [u8; 32] = public_key_vec.try_into().expect("32-byte public key");
        let blob = STANDARD
            .decode(fixture["blob_base64"].as_str().unwrap())
            .expect("decode fixture blob");
        let decoded = decode_lpi2_with_key(&blob, &public_key, OffsetDateTime::now_utc().date())
            .expect("decode fixture");
        assert_eq!(decoded.value, fixture["plaintext"]);
        assert_eq!(
            decoded
                .license
                .as_ref()
                .map(|license| license.license_id.as_str()),
            Some("fixture-license-2026")
        );
    }

    #[test]
    fn rejects_tampered_lpi2_and_plaintext_after_binding() {
        let fixture = fixture();
        let public_key_vec = hex_bytes(fixture["public_key_hex"].as_str().unwrap());
        let public_key: [u8; 32] = public_key_vec.try_into().expect("32-byte public key");
        let mut blob = STANDARD
            .decode(fixture["blob_base64"].as_str().unwrap())
            .expect("decode fixture blob");
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert!(
            decode_lpi2_with_key(&blob, &public_key, OffsetDateTime::now_utc().date()).is_err()
        );

        let directory = TestDirectory::new("plaintext-bound");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        persisted
            .save_license_token("bound-token")
            .expect("save bound token");
        assert_eq!(
            decode_push_body(&persisted, br#"{"ok":true}"#).unwrap_err(),
            PushDecodeError::Unauthorized
        );
    }

    fn hex_bytes(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }
}
