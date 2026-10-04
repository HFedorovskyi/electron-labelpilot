//! Hardware fingerprint of this workstation for named-seat licensing.
//!
//! The LabelPilot server binds each station identity (UUID) to the first
//! fingerprint it sees; another computer reusing a copied identity shows up as
//! a hardware conflict instead of silently taking the seat, and a licence with a
//! vendor seat list admits data only on the listed fingerprints.
//!
//! The value is a salted SHA-256, truncated to 32 hex characters, of the Windows
//! MachineGuid (this Windows installation) and the SMBIOS system UUID (the
//! mainboard), so copying the registry value to another computer does not
//! reproduce it. It reveals nothing about the machine and is never equal to the
//! server's own license machine id (which hashes the MachineGuid without a salt).
//! It only goes to the customer's own server.
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const FINGERPRINT_SALT: &str = "labelpilot-station-fingerprint|v2|";

/// The cached fingerprint, or `None` when the machine id cannot be read (the
/// server then treats the station as a legacy client without hardware binding).
pub fn station_fingerprint() -> Option<&'static str> {
    static FINGERPRINT: OnceLock<Option<String>> = OnceLock::new();
    FINGERPRINT
        .get_or_init(|| {
            machine_guid().and_then(|guid| fingerprint_from(&guid, board_uuid().as_ref()))
        })
        .as_deref()
}

/// `board_uuid` = the SMBIOS system UUID; all-zero and all-FF values mean
/// "not set" on some boards and are left out.
pub fn fingerprint_from(machine_guid: &str, board_uuid: Option<&[u8; 16]>) -> Option<String> {
    let normalized = machine_guid.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let board: String = board_uuid
        .filter(|uuid| !uuid.iter().all(|byte| *byte == 0) && !uuid.iter().all(|byte| *byte == 0xff))
        .map(|uuid| uuid.iter().map(|byte| format!("{byte:02x}")).collect())
        .unwrap_or_default();
    let digest = Sha256::digest(format!("{FINGERPRINT_SALT}{normalized}|{board}").as_bytes());
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

#[cfg(windows)]
fn board_uuid() -> Option<[u8; 16]> {
    use windows_sys::Win32::System::SystemInformation::GetSystemFirmwareTable;

    const RAW_SMBIOS: u32 = u32::from_be_bytes(*b"RSMB");
    // SAFETY: a null buffer with size 0 only asks for the required size.
    let size = unsafe { GetSystemFirmwareTable(RAW_SMBIOS, 0, std::ptr::null_mut(), 0) };
    if size == 0 || size > 1 << 20 {
        return None;
    }
    let mut buffer = vec![0_u8; size as usize];
    // SAFETY: `buffer` is `size` bytes long; the call writes at most `size` bytes.
    let written =
        unsafe { GetSystemFirmwareTable(RAW_SMBIOS, 0, buffer.as_mut_ptr().cast(), size) };
    if written == 0 || written > size {
        return None;
    }
    smbios_system_uuid(&buffer[..written as usize])
}

#[cfg(not(windows))]
fn board_uuid() -> Option<[u8; 16]> {
    None
}

/// The UUID of the SMBIOS System Information structure (type 1) in a Windows
/// `RawSMBIOSData` blob: 4 version bytes, the table length (u32 LE), the table.
#[cfg_attr(not(windows), allow(dead_code))]
fn smbios_system_uuid(raw: &[u8]) -> Option<[u8; 16]> {
    let length = u32::from_le_bytes(raw.get(4..8)?.try_into().ok()?) as usize;
    let table = &raw[8..raw.len().min(8usize.saturating_add(length))];
    let mut offset = 0;
    while offset + 4 <= table.len() {
        let kind = table[offset];
        let formatted = usize::from(table[offset + 1]);
        if formatted < 4 || offset + formatted > table.len() {
            return None;
        }
        if kind == 1 && formatted >= 0x19 {
            return table[offset + 8..offset + 24].try_into().ok();
        }
        if kind == 127 {
            return None;
        }
        // The string set after the formatted area ends with two NUL bytes.
        let mut next = offset + formatted;
        loop {
            if next + 1 >= table.len() {
                return None;
            }
            if table[next] == 0 && table[next + 1] == 0 {
                next += 2;
                break;
            }
            next += 1;
        }
        offset = next;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUID: &str = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9";
    const BOARD: [u8; 16] = [
        0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd,
        0xef,
    ];

    #[test]
    fn fingerprint_is_salted_normalized_and_32_hex() {
        let fingerprint = fingerprint_from(GUID, Some(&BOARD)).unwrap();
        assert_eq!(fingerprint.len(), 32);
        assert!(fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_eq!(
            fingerprint_from(" 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9 \n", Some(&BOARD)).as_deref(),
            Some(fingerprint.as_str())
        );
        // Never the server's unsalted license machine id for the same MachineGuid.
        let unsalted: String = Sha256::digest(b"0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9")[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_ne!(fingerprint, unsalted);
        assert_eq!(fingerprint_from("  ", Some(&BOARD)), None);
    }

    #[test]
    fn a_copied_machine_guid_on_another_board_is_another_fingerprint() {
        let mut other = BOARD;
        other[15] ^= 1;
        assert_ne!(fingerprint_from(GUID, Some(&BOARD)), fingerprint_from(GUID, Some(&other)));
        assert_ne!(fingerprint_from(GUID, Some(&BOARD)), fingerprint_from(GUID, None));
        // Unset board UUIDs count as absent.
        assert_eq!(fingerprint_from(GUID, Some(&[0; 16])), fingerprint_from(GUID, None));
        assert_eq!(fingerprint_from(GUID, Some(&[0xff; 16])), fingerprint_from(GUID, None));
    }

    fn structure(kind: u8, formatted: &[u8], strings: &[&str]) -> Vec<u8> {
        let mut bytes = vec![kind, (formatted.len() + 4) as u8, 0x00, 0x01];
        bytes.extend_from_slice(formatted);
        if strings.is_empty() {
            bytes.extend_from_slice(&[0, 0]);
        } else {
            for value in strings {
                bytes.extend_from_slice(value.as_bytes());
                bytes.push(0);
            }
            bytes.push(0);
        }
        bytes
    }

    #[test]
    fn the_system_uuid_is_read_from_the_raw_smbios_table() {
        let mut system = vec![1, 2, 3, 4]; // manufacturer, product, version, serial
        system.extend_from_slice(&BOARD);
        system.extend_from_slice(&[6, 5, 6]); // wake-up type, SKU, family
        let mut table = structure(0, &[1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], &["Vendor", "1.0"]);
        table.extend(structure(1, &system, &["Maker", "Board", "", "SN"]));
        table.extend(structure(127, &[], &[]));
        let mut raw = vec![0, 3, 4, 0];
        raw.extend_from_slice(&(table.len() as u32).to_le_bytes());
        raw.extend_from_slice(&table);
        assert_eq!(smbios_system_uuid(&raw), Some(BOARD));

        // No type-1 structure, or a truncated table: no UUID.
        let mut without = vec![0, 3, 4, 0];
        let only_end = structure(127, &[], &[]);
        without.extend_from_slice(&(only_end.len() as u32).to_le_bytes());
        without.extend_from_slice(&only_end);
        assert_eq!(smbios_system_uuid(&without), None);
        assert_eq!(smbios_system_uuid(&raw[..20]), None);
        assert_eq!(smbios_system_uuid(&[]), None);
    }

    #[test]
    fn this_machine_has_a_stable_fingerprint() {
        if let Some(first) = station_fingerprint() {
            assert_eq!(first.len(), 32);
            assert_eq!(station_fingerprint(), Some(first));
        }
    }
}
