//! Hardware fingerprint of this workstation for named-seat licensing.
//!
//! The LabelPilot server binds each station identity (UUID) to the first
//! fingerprint it sees; another computer reusing a copied identity shows up as
//! a hardware conflict instead of silently taking the seat. The value is a
//! salted SHA-256 of the Windows MachineGuid, truncated to 32 hex characters:
//! it is stable across reinstalls, reveals nothing about the machine, and is
//! never equal to the server's own license machine id (which hashes the
//! MachineGuid without a salt). It only goes to the customer's own server.
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const FINGERPRINT_SALT: &str = "labelpilot-station-fingerprint|v1|";

/// The cached fingerprint, or `None` when the machine id cannot be read (the
/// server then treats the station as a legacy client without hardware binding).
pub fn station_fingerprint() -> Option<&'static str> {
    static FINGERPRINT: OnceLock<Option<String>> = OnceLock::new();
    FINGERPRINT
        .get_or_init(|| machine_guid().and_then(|guid| fingerprint_from_machine_guid(&guid)))
        .as_deref()
}

pub fn fingerprint_from_machine_guid(machine_guid: &str) -> Option<String> {
    let normalized = machine_guid.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let digest = Sha256::digest(format!("{FINGERPRINT_SALT}{normalized}").as_bytes());
    Some(
        digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

#[cfg(windows)]
fn machine_guid() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let subkey = wide(r"SOFTWARE\Microsoft\Cryptography");
    let name = wide("MachineGuid");
    let mut buffer = [0_u16; 128];
    let mut size = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    // SAFETY: both strings are NUL-terminated UTF-16 and `size` is the byte
    // length of `buffer`; RegGetValueW writes at most `size` bytes into it.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            name.as_ptr(),
            // The 64-bit view: a 32-bit build must read the same value.
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let length = (size as usize / std::mem::size_of::<u16>()).min(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..length]);
    let value = value.trim_end_matches('\0').trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(not(windows))]
fn machine_guid() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_salted_normalized_and_32_hex() {
        let fingerprint =
            fingerprint_from_machine_guid("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9").unwrap();
        assert_eq!(fingerprint.len(), 32);
        assert!(fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_eq!(
            fingerprint_from_machine_guid(" 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9 \n").as_deref(),
            Some(fingerprint.as_str())
        );
        // Never the server's unsalted license machine id for the same MachineGuid.
        let unsalted: String = Sha256::digest(b"0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9")[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_ne!(fingerprint, unsalted);
        assert_eq!(fingerprint_from_machine_guid("  "), None);
    }

    #[test]
    fn this_machine_has_a_stable_fingerprint() {
        if let Some(first) = station_fingerprint() {
            assert_eq!(first.len(), 32);
            assert_eq!(station_fingerprint(), Some(first));
        }
    }
}
