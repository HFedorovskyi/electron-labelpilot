use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub const MAX_DIAGNOSTIC_REPORT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_DIAGNOSTIC_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportReceipt {
    pub success: bool,
    pub path: String,
    pub format: String,
    pub bytes: usize,
    pub sha256: String,
    pub report_sha256: String,
}

pub fn export_report(path: &Path, report: &Value) -> Result<DiagnosticExportReceipt, String> {
    validate_report(report)?;
    let report_bytes = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("failed to serialize diagnostic report: {error}"))?;
    if report_bytes.len() > MAX_DIAGNOSTIC_REPORT_BYTES {
        return Err(format!(
            "diagnostic report exceeds {} bytes",
            MAX_DIAGNOSTIC_REPORT_BYTES
        ));
    }
    let report_sha256 = sha256_hex(&report_bytes);
    let format = extension(path)?;
    let output = match format.as_str() {
        "json" => report_bytes.clone(),
        "zip" => build_zip(&report_bytes, &report_sha256)?,
        _ => unreachable!(),
    };
    if output.len() > MAX_DIAGNOSTIC_BUNDLE_BYTES {
        return Err(format!(
            "diagnostic bundle exceeds {} bytes",
            MAX_DIAGNOSTIC_BUNDLE_BYTES
        ));
    }
    atomic_write(path, &output)?;
    Ok(DiagnosticExportReceipt {
        success: true,
        path: path.display().to_string(),
        format,
        bytes: output.len(),
        sha256: sha256_hex(&output),
        report_sha256,
    })
}

fn validate_report(report: &Value) -> Result<(), String> {
    let object = report
        .as_object()
        .ok_or_else(|| "diagnostic report must be an object".to_owned())?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("diagnostic report schemaVersion must be 1".to_owned());
    }
    if object.get("kind").and_then(Value::as_str) != Some("labelpilot-printer-diagnostic") {
        return Err("diagnostic report kind is invalid".to_owned());
    }
    Ok(())
}

fn extension(path: &Path) -> Result<String, String> {
    let value = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(value.as_str(), "json" | "zip") {
        Ok(value)
    } else {
        Err("diagnostic export path must end with .json or .zip".to_owned())
    }
}

fn build_zip(report: &[u8], report_sha256: &str) -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(Vec::with_capacity(report.len() + 1024));
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    writer
        .start_file("diagnostic-report.json", options)
        .map_err(|error| format!("failed to start diagnostic ZIP report entry: {error}"))?;
    writer
        .write_all(report)
        .map_err(|error| format!("failed to write diagnostic ZIP report entry: {error}"))?;
    let manifest = serde_json::to_vec_pretty(&json!({
        "schemaVersion": 1,
        "reportFile": "diagnostic-report.json",
        "reportSha256": report_sha256,
        "reportBytes": report.len(),
    }))
    .map_err(|error| format!("failed to serialize diagnostic ZIP manifest: {error}"))?;
    writer
        .start_file("manifest.json", options)
        .map_err(|error| format!("failed to start diagnostic ZIP manifest entry: {error}"))?;
    writer
        .write_all(&manifest)
        .map_err(|error| format!("failed to write diagnostic ZIP manifest entry: {error}"))?;
    let cursor = writer
        .finish()
        .map_err(|error| format!("failed to finalize diagnostic ZIP: {error}"))?;
    Ok(cursor.into_inner())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let temp = temporary_path(path);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("failed to create {}: {error}", temp.display()))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("failed to flush {}: {error}", temp.display()))?;
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("diagnostic.zip");
    path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), sequence))
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "failed to replace diagnostic export atomically: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| {
        format!(
            "failed to replace {} atomically from {}: {error}",
            destination.display(),
            source.display()
        )
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use uuid::Uuid;
    use zip::ZipArchive;

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("labelpilot-diagnostic-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn report() -> Value {
        json!({
            "schemaVersion": 1,
            "kind": "labelpilot-printer-diagnostic",
            "generatedAt": "2026-08-21T00:00:00Z",
            "printers": [],
        })
    }

    #[test]
    fn exports_atomic_json_with_exact_hash() {
        let directory = TempDirectory::new();
        let path = directory.0.join("report.json");
        let receipt = export_report(&path, &report()).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(receipt.format, "json");
        assert_eq!(receipt.bytes, bytes.len());
        assert_eq!(receipt.sha256, sha256_hex(&bytes));
        assert!(!fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn zip_contains_report_and_hash_manifest() {
        let directory = TempDirectory::new();
        let path = directory.0.join("report.zip");
        let receipt = export_report(&path, &report()).unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut report_bytes = Vec::new();
        archive
            .by_name("diagnostic-report.json")
            .unwrap()
            .read_to_end(&mut report_bytes)
            .unwrap();
        assert_eq!(receipt.report_sha256, sha256_hex(&report_bytes));
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        assert!(manifest.contains(&receipt.report_sha256));
    }

    #[test]
    fn rejects_unknown_extension_and_invalid_schema() {
        let directory = TempDirectory::new();
        assert!(export_report(&directory.0.join("report.txt"), &report())
            .unwrap_err()
            .contains(".json or .zip"));
        assert!(export_report(
            &directory.0.join("report.json"),
            &json!({"schemaVersion": 2})
        )
        .unwrap_err()
        .contains("schemaVersion"));
    }

    #[test]
    fn bounds_report_before_writing() {
        let directory = TempDirectory::new();
        let oversized = json!({
            "schemaVersion": 1,
            "kind": "labelpilot-printer-diagnostic",
            "data": "X".repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1),
        });
        let path = directory.0.join("oversized.json");
        assert!(export_report(&path, &oversized)
            .unwrap_err()
            .contains("exceeds"));
        assert!(!path.exists());
    }
}
