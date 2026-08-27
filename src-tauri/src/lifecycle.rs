use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const BACKUP_DIRECTORY: &str = "backups";
const BACKUP_METADATA: &str = "backup-meta.json";
const PENDING_ROLLBACK: &str = "pending-rollback.json";
const MAX_BACKUPS: usize = 3;
const FILES_TO_BACKUP: &[&str] = &[
    "client_data.db",
    "identity.json",
    "license.token",
    "report_state.json",
    "printer-config.json",
    "scale-config.json",
    "numbering-config.json",
    "sequence-store.json",
    "demo.flag",
    "identity_pre_demo.json",
];
const DIRECTORIES_TO_BACKUP: &[&str] = &["outbox"];

pub struct UpdateRuntimeState {
    pending: Mutex<Option<PendingUpdate>>,
    last_server_version: Mutex<Option<String>>,
}

struct PendingUpdate {
    update: Update,
    bytes: Option<Vec<u8>>,
}

impl Default for UpdateRuntimeState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(None),
            last_server_version: Mutex::new(None),
        }
    }
}

impl UpdateRuntimeState {
    pub fn set_server_version(&self, version: Option<String>) -> Result<(), String> {
        *self
            .last_server_version
            .lock()
            .map_err(|_| "updater server-version lock is poisoned".to_owned())? = version;
        Ok(())
    }

    fn server_version(&self) -> Option<String> {
        self.last_server_version
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub version: String,
    pub created_at: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupMetadata {
    id: String,
    version: String,
    created_at: String,
    files: Vec<String>,
    directories: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRollback {
    backup_id: String,
    requested_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_reason: Option<String>,
}

pub async fn check_for_update(
    app: AppHandle,
    state: &UpdateRuntimeState,
) -> Result<UpdateCheckResult, String> {
    let update = app
        .updater()
        .map_err(|error| format!("failed to initialize updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("failed to check for updates: {error}"))?;

    let Some(update) = update else {
        clear_pending(state)?;
        let _ = app.emit("updater:no-update", ());
        return Ok(UpdateCheckResult {
            available: false,
            version: None,
            release_notes: None,
            compatible: None,
            compatibility_reason: None,
        });
    };

    let version = update.version.clone();
    let release_notes = update.body.clone();
    let (compatible, compatibility_reason) =
        pre_update_compatibility(&version, state.server_version().as_deref());

    *state
        .pending
        .lock()
        .map_err(|_| "updater pending-state lock is poisoned".to_owned())? = Some(PendingUpdate {
        update,
        bytes: None,
    });

    let payload = json!({
        "version": version,
        "releaseNotes": release_notes,
        "compatible": compatible,
        "compatibilityReason": compatibility_reason,
    });
    let _ = app.emit("updater:update-available", payload);

    Ok(UpdateCheckResult {
        available: true,
        version: Some(version),
        release_notes,
        compatible: Some(compatible),
        compatibility_reason,
    })
}

pub async fn download_update(app: AppHandle, state: &UpdateRuntimeState) -> Result<Value, String> {
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "updater pending-state lock is poisoned".to_owned())?
        .take()
        .ok_or_else(|| "Нет подготовленного обновления. Сначала выполните проверку.".to_owned())?;

    if pending.bytes.is_some() {
        let version = pending.update.version.clone();
        *state
            .pending
            .lock()
            .map_err(|_| "updater pending-state lock is poisoned".to_owned())? = Some(pending);
        return Ok(json!({ "success": true, "version": version, "alreadyDownloaded": true }));
    }

    let started = Instant::now();
    let mut transferred = 0_u64;
    let progress_app = app.clone();
    let version = pending.update.version.clone();
    let result = pending
        .update
        .download(
            move |chunk_length, content_length| {
                transferred = transferred.saturating_add(chunk_length as u64);
                let total = content_length.unwrap_or(0);
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let percent = if total == 0 {
                    0.0
                } else {
                    transferred as f64 * 100.0 / total as f64
                };
                let _ = progress_app.emit(
                    "updater:progress",
                    json!({
                        "percent": percent.clamp(0.0, 100.0),
                        "transferred": transferred,
                        "total": total,
                        "bytesPerSecond": (transferred as f64 / elapsed) as u64,
                    }),
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            let byte_count = bytes.len();
            pending.bytes = Some(bytes);
            *state
                .pending
                .lock()
                .map_err(|_| "updater pending-state lock is poisoned".to_owned())? = Some(pending);
            let _ = app.emit("updater:downloaded", json!({ "version": version }));
            Ok(json!({ "success": true, "version": version, "bytes": byte_count }))
        }
        Err(error) => {
            *state
                .pending
                .lock()
                .map_err(|_| "updater pending-state lock is poisoned".to_owned())? = Some(pending);
            let message = format!("Не удалось скачать обновление: {error}");
            let _ = app.emit("updater:error", json!({ "message": message }));
            Err(message)
        }
    }
}

pub fn install_downloaded_update(
    app: &AppHandle,
    state: &UpdateRuntimeState,
    data_dir: &Path,
) -> Result<Value, String> {
    let pending = state
        .pending
        .lock()
        .map_err(|_| "updater pending-state lock is poisoned".to_owned())?
        .take()
        .ok_or_else(|| "Нет подготовленного обновления.".to_owned())?;
    let bytes = pending
        .bytes
        .as_deref()
        .ok_or_else(|| "Обновление ещё не загружено.".to_owned())?;

    let version = app.package_info().version.to_string();
    let backup = create_backup(data_dir, &version)?;
    pending
        .update
        .install(bytes)
        .map_err(|error| format!("Не удалось установить обновление: {error}"))?;
    Ok(json!({ "success": true, "backupId": backup.id }))
}

fn clear_pending(state: &UpdateRuntimeState) -> Result<(), String> {
    *state
        .pending
        .lock()
        .map_err(|_| "updater pending-state lock is poisoned".to_owned())? = None;
    Ok(())
}

pub fn install_offline_update(
    app: AppHandle,
    data_dir: &Path,
    installer_path: &Path,
) -> Result<Value, String> {
    if !installer_path.is_file() {
        return Err(format!("Файл не найден: {}", installer_path.display()));
    }
    let extension = installer_path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "exe" && extension != "msi" {
        return Err("Ожидается установщик .exe или .msi".to_owned());
    }

    let backup = create_backup(data_dir, &app.package_info().version.to_string())?;
    launch_installer(installer_path, &extension)?;

    let exit_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        exit_app.exit(0);
    });

    Ok(json!({
        "success": true,
        "message": "Установщик запущен. Приложение закроется.",
        "backupId": backup.id,
    }))
}

#[cfg(windows)]
fn launch_installer(path: &Path, extension: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = if extension == "msi" {
        let mut command = Command::new("msiexec.exe");
        command.arg("/i").arg(path).args(["/passive", "/norestart"]);
        command
    } else {
        let mut command = Command::new(path);
        command.arg("/S");
        command
    };
    command
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Не удалось запустить установщик: {error}"))
}

#[cfg(not(windows))]
fn launch_installer(path: &Path, _extension: &str) -> Result<(), String> {
    Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Не удалось запустить установщик: {error}"))
}

pub fn create_backup(data_dir: &Path, version: &str) -> Result<BackupInfo, String> {
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("failed to create data directory: {error}"))?;
    let backup_root = data_dir.join(BACKUP_DIRECTORY);
    fs::create_dir_all(&backup_root)
        .map_err(|error| format!("failed to create backup directory: {error}"))?;

    let now = OffsetDateTime::now_utc();
    let created_at = now
        .format(&Rfc3339)
        .map_err(|error| format!("failed to format backup timestamp: {error}"))?;
    let epoch = now.unix_timestamp_nanos();
    let id = format!("v{}_{}", sanitize_version(version), epoch);
    let temporary = backup_root.join(format!(".{id}.tmp"));
    let target = backup_root.join(&id);
    if temporary.exists() {
        fs::remove_dir_all(&temporary)
            .map_err(|error| format!("failed to clear backup staging directory: {error}"))?;
    }
    fs::create_dir_all(&temporary)
        .map_err(|error| format!("failed to create backup staging directory: {error}"))?;

    let mut files = Vec::new();
    for name in FILES_TO_BACKUP {
        let source = data_dir.join(name);
        if source.is_file() {
            copy_file_synced(&source, &temporary.join(name))?;
            files.push((*name).to_owned());
        }
    }

    let mut directories = Vec::new();
    for name in DIRECTORIES_TO_BACKUP {
        let source = data_dir.join(name);
        if source.is_dir() {
            copy_directory(&source, &temporary.join(name))?;
            directories.push((*name).to_owned());
        }
    }

    let metadata = BackupMetadata {
        id: id.clone(),
        version: version.to_owned(),
        created_at: created_at.clone(),
        files,
        directories,
    };
    write_json_atomic(&temporary.join(BACKUP_METADATA), &metadata)?;
    fs::rename(&temporary, &target)
        .map_err(|error| format!("failed to publish backup {}: {error}", target.display()))?;
    cleanup_old_backups(data_dir, MAX_BACKUPS)?;

    Ok(BackupInfo {
        id,
        version: version.to_owned(),
        created_at,
        path: target.display().to_string(),
        size_bytes: folder_size(&target)?,
    })
}

pub fn list_backups(data_dir: &Path) -> Result<Vec<BackupInfo>, String> {
    let root = data_dir.join(BACKUP_DIRECTORY);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in
        fs::read_dir(&root).map_err(|error| format!("failed to read backup directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read backup entry: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("failed to inspect backup entry: {error}"))?
            .is_dir()
        {
            continue;
        }
        let path = entry.path();
        let metadata_path = path.join(BACKUP_METADATA);
        if !metadata_path.is_file() {
            continue;
        }
        let metadata: BackupMetadata = match read_json(&metadata_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if validate_backup_id(&metadata.id).is_err()
            || path.file_name() != Some(OsStr::new(&metadata.id))
        {
            continue;
        }
        result.push(BackupInfo {
            id: metadata.id,
            version: metadata.version,
            created_at: metadata.created_at,
            path: path.display().to_string(),
            size_bytes: folder_size(&path)?,
        });
    }
    result.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(result)
}

pub fn queue_rollback(data_dir: &Path, backup_id: &str) -> Result<Value, String> {
    let backup = checked_backup_path(data_dir, backup_id)?;
    if !backup.join(BACKUP_METADATA).is_file() {
        return Err(format!("Backup not found: {backup_id}"));
    }
    let pending = PendingRollback {
        backup_id: backup_id.to_owned(),
        requested_at: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| unix_timestamp().to_string()),
    };
    write_json_atomic(&data_dir.join(PENDING_ROLLBACK), &pending)?;
    Ok(json!({
        "success": true,
        "message": format!("Откат на бэкап \"{backup_id}\" подготовлен. Перезапустите приложение."),
        "restartRequired": true,
    }))
}

pub fn apply_pending_rollback(data_dir: &Path) -> Result<Option<String>, String> {
    let marker = data_dir.join(PENDING_ROLLBACK);
    if !marker.is_file() {
        return Ok(None);
    }
    let pending: PendingRollback = read_json(&marker)?;
    let backup_path = checked_backup_path(data_dir, &pending.backup_id)?;
    let metadata: BackupMetadata = read_json(&backup_path.join(BACKUP_METADATA))?;
    if metadata.id != pending.backup_id {
        return Err("backup metadata identity mismatch".to_owned());
    }

    for file in metadata.files {
        validate_relative_name(&file)?;
        let source = backup_path.join(&file);
        if source.is_file() {
            copy_file_atomic(&source, &data_dir.join(&file))?;
        }
    }
    for directory in metadata.directories {
        validate_relative_name(&directory)?;
        let source = backup_path.join(&directory);
        if source.is_dir() {
            copy_directory_atomic_merge(&source, &data_dir.join(&directory))?;
        }
    }
    fs::remove_file(&marker)
        .map_err(|error| format!("failed to clear pending rollback marker: {error}"))?;
    Ok(Some(pending.backup_id))
}

fn cleanup_old_backups(data_dir: &Path, keep: usize) -> Result<(), String> {
    let backups = list_backups(data_dir)?;
    for backup in backups.into_iter().skip(keep) {
        let path = checked_backup_path(data_dir, &backup.id)?;
        fs::remove_dir_all(&path)
            .map_err(|error| format!("failed to remove old backup {}: {error}", path.display()))?;
    }
    Ok(())
}

fn checked_backup_path(data_dir: &Path, backup_id: &str) -> Result<PathBuf, String> {
    validate_backup_id(backup_id)?;
    Ok(data_dir.join(BACKUP_DIRECTORY).join(backup_id))
}

fn validate_backup_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || Path::new(value).components().count() != 1
        || !matches!(
            Path::new(value).components().next(),
            Some(Component::Normal(_))
        )
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("invalid backup id".to_owned());
    }
    Ok(())
}

fn validate_relative_name(value: &str) -> Result<(), String> {
    if !FILES_TO_BACKUP.contains(&value) && !DIRECTORIES_TO_BACKUP.contains(&value) {
        return Err(format!("backup contains unsupported path: {value}"));
    }
    Ok(())
}

fn copy_file_synced(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let mut input = File::open(source)
        .map_err(|error| format!("failed to open {}: {error}", source.display()))?;
    let mut output = File::create(target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    std::io::copy(&mut input, &mut output)
        .map_err(|error| format!("failed to copy {}: {error}", source.display()))?;
    output
        .sync_all()
        .map_err(|error| format!("failed to flush {}: {error}", target.display()))
}

fn copy_file_atomic(source: &Path, target: &Path) -> Result<(), String> {
    let temporary = target.with_extension(format!("restore-{}.tmp", unix_timestamp()));
    copy_file_synced(source, &temporary)?;
    if target.exists() {
        fs::remove_file(target)
            .map_err(|error| format!("failed to replace {}: {error}", target.display()))?;
    }
    fs::rename(&temporary, target).map_err(|error| {
        format!(
            "failed to publish restored file {}: {error}",
            target.display()
        )
    })
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target.join(entry.file_name()))?;
        } else if file_type.is_file() {
            copy_file_synced(&entry.path(), &target.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn copy_directory_atomic_merge(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory_atomic_merge(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            copy_file_atomic(&entry.path(), &destination)?;
        }
    }
    Ok(())
}

fn folder_size(path: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    for entry in
        fs::read_dir(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total = total.saturating_add(folder_size(&entry.path())?);
        } else if file_type.is_file() {
            total = total.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| format!("failed to stat {}: {error}", entry.path().display()))?
                    .len(),
            );
        }
    }
    Ok(total)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize {}: {error}", path.display()))?;
    let temporary = path.with_extension(format!("{}.tmp", unix_timestamp()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let mut file = File::create(&temporary)
        .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish {}: {error}", path.display()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

fn sanitize_version(version: &str) -> String {
    version
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
        .take(48)
        .collect::<String>()
}

fn unix_timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn pre_update_compatibility(
    new_client_version: &str,
    server_version: Option<&str>,
) -> (bool, Option<String>) {
    let required = match new_client_version.trim_start_matches('v') {
        "1.3.0" => Some("1.1.0"),
        "1.3.7" | "1.3.8" | "1.3.9" | "1.3.10" | "1.3.11" => Some("1.1.13"),
        "1.3.12" | "1.3.13" | "1.3.14" | "1.3.15" | "1.3.16" | "2.0.0" | "2.0.1" => Some("1.1.23"),
        _ => None,
    };
    let Some(server) = server_version else {
        return (
            true,
            Some(
                "Сервер недоступен. Совместимость будет проверена при следующем подключении."
                    .to_owned(),
            ),
        );
    };
    let Some(required) = required else {
        return (true, None);
    };
    if semver_lt(server, required) {
        return (
            false,
            Some(format!(
                "Обновление до v{new_client_version} требует сервер v{required}+. Текущая версия сервера: {server}. Сначала обновите сервер."
            )),
        );
    }
    (true, None)
}

fn semver_lt(left: &str, right: &str) -> bool {
    fn parse(value: &str) -> [u64; 3] {
        let mut result = [0_u64; 3];
        for (index, part) in value.trim_start_matches('v').split('.').take(3).enumerate() {
            result[index] = part
                .split(|character: char| !character.is_ascii_digit())
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
        }
        result
    }
    parse(left) < parse(right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "labelpilot-lifecycle-{name}-{}-{}",
                std::process::id(),
                unix_timestamp()
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

    #[test]
    fn backup_and_pending_rollback_restore_files_and_merge_outbox() {
        let directory = TestDirectory::new("rollback");
        fs::write(directory.0.join("identity.json"), b"before").unwrap();
        fs::create_dir_all(directory.0.join("outbox")).unwrap();
        fs::write(directory.0.join("outbox/original.lpr"), b"original").unwrap();
        let backup = create_backup(&directory.0, "1.3.16").unwrap();

        fs::write(directory.0.join("identity.json"), b"after").unwrap();
        fs::write(directory.0.join("outbox/live.lpr"), b"live").unwrap();
        queue_rollback(&directory.0, &backup.id).unwrap();
        assert_eq!(
            apply_pending_rollback(&directory.0).unwrap().as_deref(),
            Some(backup.id.as_str())
        );
        assert_eq!(
            fs::read(directory.0.join("identity.json")).unwrap(),
            b"before"
        );
        assert!(directory.0.join("outbox/original.lpr").is_file());
        assert!(directory.0.join("outbox/live.lpr").is_file());
    }

    #[test]
    fn backup_retention_keeps_three_newest_snapshots() {
        let directory = TestDirectory::new("retention");
        fs::write(directory.0.join("identity.json"), b"identity").unwrap();
        for index in 0..5 {
            create_backup(&directory.0, &format!("1.3.{index}")).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(list_backups(&directory.0).unwrap().len(), MAX_BACKUPS);
    }

    #[test]
    fn rollback_rejects_path_traversal() {
        let directory = TestDirectory::new("traversal");
        assert!(queue_rollback(&directory.0, "../outside").is_err());
        assert!(queue_rollback(&directory.0, "C:\\outside").is_err());
    }

    #[test]
    fn update_compatibility_preserves_the_client_matrix() {
        assert!(!pre_update_compatibility("1.3.16", Some("1.1.22")).0);
        assert!(pre_update_compatibility("1.3.16", Some("1.1.23")).0);
        assert!(!pre_update_compatibility("2.0.0", Some("1.1.22")).0);
        assert!(pre_update_compatibility("2.0.0", Some("1.1.23")).0);
        assert!(pre_update_compatibility("1.3.17", Some("1.0.0")).0);
        assert!(pre_update_compatibility("1.3.17", None).0);
    }
}
