use crate::operational::{OperationalState, OperatorAttribution};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use subtle::ConstantTimeEq;

const LAST_OPERATOR_FILE: &str = "last-operator.json";

pub struct SessionState {
    current: Mutex<Option<CurrentOperator>>,
    last_operator_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
pub struct CurrentOperator {
    pub uuid: String,
    pub full_name: String,
    pub short_code: String,
}

impl SessionState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            current: Mutex::new(None),
            last_operator_path: data_dir.join(LAST_OPERATOR_FILE),
        }
    }

    pub fn current(&self) -> Option<CurrentOperator> {
        self.current.lock().ok().and_then(|current| current.clone())
    }

    pub fn attribution(&self) -> Option<OperatorAttribution> {
        self.current().map(|operator| OperatorAttribution {
            uuid: operator.uuid,
            full_name: operator.full_name,
        })
    }

    pub fn set(
        &self,
        operational: &OperationalState,
        uuid: &str,
        pin: &str,
    ) -> Result<Value, String> {
        let Some(credentials) = operational.operator_credentials(uuid)? else {
            return Ok(json!({ "ok": false, "reason": "not_found" }));
        };
        if !verify_pin(pin, credentials.pin_hash.as_deref()) {
            return Ok(json!({ "ok": false, "reason": "bad_pin" }));
        }
        let operator = CurrentOperator {
            uuid: credentials.uuid,
            full_name: credentials.full_name,
            short_code: credentials.short_code,
        };
        *self
            .current
            .lock()
            .map_err(|_| "operator session lock is poisoned".to_owned())? = Some(operator.clone());
        self.save_last_operator(&operator.uuid);
        Ok(json!({ "ok": true, "operator": operator }))
    }

    pub fn clear(&self) -> Result<(), String> {
        *self
            .current
            .lock()
            .map_err(|_| "operator session lock is poisoned".to_owned())? = None;
        Ok(())
    }

    pub fn last_operator_uuid(&self) -> Option<String> {
        let value: Value =
            serde_json::from_slice(&fs::read(&self.last_operator_path).ok()?).ok()?;
        value.get("uuid").and_then(Value::as_str).map(str::to_owned)
    }

    fn save_last_operator(&self, uuid: &str) {
        let Some(parent) = self.last_operator_path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let temporary = self.last_operator_path.with_extension("json.tmp");
        let bytes = match serde_json::to_vec(&json!({ "uuid": uuid })) {
            Ok(bytes) => bytes,
            Err(_) => return,
        };
        if fs::write(&temporary, bytes).is_ok() {
            if self.last_operator_path.exists() {
                let _ = fs::remove_file(&self.last_operator_path);
            }
            let _ = fs::rename(temporary, &self.last_operator_path);
        }
    }
}

fn verify_pin(pin: &str, pin_hash: Option<&str>) -> bool {
    let Some(pin_hash) = pin_hash.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let mut parts = pin_hash.split('$');
    if parts.next() != Some("pbkdf2_sha256") {
        return false;
    }
    let Some(iterations) = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
    else {
        return false;
    };
    let Some(salt) = parts.next().filter(|value| !value.is_empty()) else {
        return false;
    };
    let Some(expected) = parts
        .next()
        .and_then(|value| STANDARD.decode(value).ok())
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let mut computed = vec![0_u8; expected.len()];
    derive_pbkdf2_sha256(pin.as_bytes(), salt.as_bytes(), iterations, &mut computed);
    bool::from(computed.as_slice().ct_eq(expected.as_slice()))
}

fn derive_pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32, output: &mut [u8]) {
    #[cfg(target_os = "windows")]
    if derive_pbkdf2_sha256_windows(password, salt, iterations, output) {
        return;
    }

    pbkdf2_hmac::<Sha256>(password, salt, iterations, output);
}

#[cfg(target_os = "windows")]
fn derive_pbkdf2_sha256_windows(
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    output: &mut [u8],
) -> bool {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{
        BCryptCloseAlgorithmProvider, BCryptDeriveKeyPBKDF2, BCryptOpenAlgorithmProvider,
        BCRYPT_ALG_HANDLE, BCRYPT_ALG_HANDLE_HMAC_FLAG, BCRYPT_SHA256_ALGORITHM,
    };

    let (Ok(password_len), Ok(salt_len), Ok(output_len)) = (
        u32::try_from(password.len()),
        u32::try_from(salt.len()),
        u32::try_from(output.len()),
    ) else {
        return false;
    };
    let mut algorithm: BCRYPT_ALG_HANDLE = null_mut();
    let open_status = unsafe {
        BCryptOpenAlgorithmProvider(
            &mut algorithm,
            BCRYPT_SHA256_ALGORITHM,
            null(),
            BCRYPT_ALG_HANDLE_HMAC_FLAG,
        )
    };
    if open_status < 0 || algorithm.is_null() {
        return false;
    }
    let derive_status = unsafe {
        BCryptDeriveKeyPBKDF2(
            algorithm,
            password.as_ptr(),
            password_len,
            salt.as_ptr(),
            salt_len,
            u64::from(iterations),
            output.as_mut_ptr(),
            output_len,
            0,
        )
    };
    let _ = unsafe { BCryptCloseAlgorithmProvider(algorithm, 0) };
    derive_status >= 0
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_django_pbkdf2_and_fail_open_no_pin_contract() {
        assert!(verify_pin("anything", None));
        assert!(verify_pin("", Some("")));
        assert!(
            verify_pin(
                "1234",
                Some("pbkdf2_sha256$1000$salt$NQ8V4yzZ7llJt9F3V7mDqW+OIEup3FQ1V5M9qzrB7N8=")
            ) == {
                let expected = STANDARD
                    .decode("NQ8V4yzZ7llJt9F3V7mDqW+OIEup3FQ1V5M9qzrB7N8=")
                    .unwrap();
                let mut computed = vec![0_u8; expected.len()];
                pbkdf2_hmac::<Sha256>(b"1234", b"salt", 1000, &mut computed);
                computed == expected
            }
        );
        assert!(!verify_pin("1234", Some("unknown$1$salt$AA==")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_cng_handles_deployed_iteration_cost() {
        let started = std::time::Instant::now();
        assert!(!verify_pin(
            "0000",
            Some("pbkdf2_sha256$1000000$labelpilot-test$elnfK0B19+/j3z1ZRAqrW0zpFDrkI245e24wd/JU+Eo=")
        ));
        let elapsed = started.elapsed();
        eprintln!("Windows CNG PBKDF2 1,000,000 iterations: {elapsed:?}");
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "deployed PIN verification took {elapsed:?}"
        );
    }
}
