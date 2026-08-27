use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsStr,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use zip::ZipArchive;

pub const DEFAULT_NATIVE_UPDATE_ENDPOINT: &str =
    "https://github.com/HFedorovskyi/electron-labelpilot/releases/latest/download/native-latest.json";
pub const UPDATE_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg1NTlEMjU2ODgwQ0M4QkMKUldTOHlBeUlWdEpaaFhUeEhpZDJpL253THkxdy8xN29hSmFTUXIrV2kyejNtWTRDQytST0x6TFkK";
const SCHEMA: u32 = 1;
const MAX_MANIFEST: u64 = 1_048_576;
const MAX_PACKAGE: u64 = 268_435_456;
const MAX_UNPACKED: u64 = 536_870_912;
const PACKAGE_METADATA: &str = ".labelpilot-update.json";
const DATA_FILES: &[&str] = &[
    "client_data.db",
    "client_data.db-wal",
    "client_data.db-shm",
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUpdateManifest {
    pub schema: u32,
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub published_at: String,
    pub platforms: BTreeMap<String, NativeUpdateArtifact>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUpdateArtifact {
    pub url: String,
    pub signature: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default = "portable_format")]
    pub format: String,
}

#[derive(Debug, Deserialize)]
struct PackageMetadata {
    schema: u32,
    version: String,
    platform: String,
}

fn portable_format() -> String {
    "portable-zip".into()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeUpdateSnapshot {
    pub current_version: String,
    pub state: String,
    pub available_version: String,
    pub notes: String,
    pub status: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub staged_path: String,
    pub last_checked_at: String,
    pub rollback_available: bool,
    pub last_error: String,
}

#[derive(Clone)]
pub struct NativeUpdateManager {
    data_dir: PathBuf,
    client: reqwest::blocking::Client,
    state: Arc<Mutex<(Option<NativeUpdateManifest>, NativeUpdateSnapshot)>>,
}

impl NativeUpdateManager {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(data_dir.join("updates"))
            .map_err(|error| format!("create updater directory: {error}"))?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(45))
            .pool_idle_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(1)
            .user_agent(format!("LabelPilot-Native/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("build updater HTTP client: {error}"))?;
        let snapshot = NativeUpdateSnapshot {
            current_version: env!("CARGO_PKG_VERSION").into(),
            state: "idle".into(),
            status: "Готово к проверке обновлений".into(),
            rollback_available: data_dir.join("updates/last-transaction.json").is_file(),
            ..Default::default()
        };
        Ok(Self {
            data_dir,
            client,
            state: Arc::new(Mutex::new((None, snapshot))),
        })
    }

    pub fn snapshot(&self) -> NativeUpdateSnapshot {
        self.state
            .lock()
            .map(|value| value.1.clone())
            .unwrap_or_else(|_| NativeUpdateSnapshot {
                current_version: env!("CARGO_PKG_VERSION").into(),
                state: "error".into(),
                status: "Состояние updater недоступно".into(),
                last_error: "updater state lock is poisoned".into(),
                ..Default::default()
            })
    }

    fn edit(&self, action: impl FnOnce(&mut NativeUpdateSnapshot)) -> Result<(), String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "updater state lock is poisoned".to_owned())?;
        action(&mut guard.1);
        Ok(())
    }

    pub fn check_online(&self) -> Result<NativeUpdateSnapshot, String> {
        self.edit(|value| {
            value.state = "checking".into();
            value.status = "Проверка канала обновлений…".into();
            value.last_error.clear();
        })?;
        let result = self.check_online_inner();
        if let Err(error) = &result {
            self.edit(|value| {
                value.state = "error".into();
                value.status = "Ошибка проверки обновлений".into();
                value.last_error = error.clone();
            })?;
        }
        result
    }

    fn check_online_inner(&self) -> Result<NativeUpdateSnapshot, String> {
        let endpoint = env::var("LABELPILOT_NATIVE_UPDATE_ENDPOINT")
            .unwrap_or_else(|_| DEFAULT_NATIVE_UPDATE_ENDPOINT.into());
        validate_remote_url(&endpoint)?;
        let response = self
            .client
            .get(endpoint)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| format!("request update manifest: {error}"))?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_MANIFEST)
        {
            return Err("update manifest exceeds the size limit".into());
        }
        let manifest = parse_manifest(&read_bounded(response, MAX_MANIFEST)?)?;
        let available = newer(env!("CARGO_PKG_VERSION"), &manifest.version)?;
        let size = artifact(&manifest)?.size;
        {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "updater state lock is poisoned".to_owned())?;
            guard.0 = Some(manifest.clone());
            guard.1.last_checked_at = unix_time();
            guard.1.available_version = if available {
                manifest.version.clone()
            } else {
                String::new()
            };
            guard.1.notes = manifest.notes.clone();
            guard.1.total_bytes = if available { size } else { 0 };
            guard.1.downloaded_bytes = 0;
            guard.1.staged_path.clear();
            guard.1.state = if available { "available" } else { "current" }.into();
            guard.1.status = if available {
                format!("Доступна версия {}", manifest.version)
            } else {
                "Установлена актуальная версия".into()
            };
        }
        Ok(self.snapshot())
    }

    pub fn download<F>(&self, progress: F) -> Result<NativeUpdateSnapshot, String>
    where
        F: Fn(u64, u64),
    {
        let manifest = self
            .state
            .lock()
            .map_err(|_| "updater state lock is poisoned".to_owned())?
            .0
            .clone()
            .ok_or_else(|| "Сначала выполните проверку обновлений".to_owned())?;
        let package = artifact(&manifest)?.clone();
        validate_remote_url(&package.url)?;
        self.edit(|value| {
            value.state = "downloading".into();
            value.status = "Загрузка подписанного пакета…".into();
            value.downloaded_bytes = 0;
            value.total_bytes = package.size;
        })?;
        match self.download_package(&manifest.version, &package, progress) {
            Ok(path) => {
                self.edit(|value| {
                    value.state = "ready".into();
                    value.status = "Пакет проверен и готов к установке".into();
                    value.downloaded_bytes = package.size;
                    value.staged_path = path.display().to_string();
                })?;
                Ok(self.snapshot())
            }
            Err(error) => {
                self.edit(|value| {
                    value.state = "error".into();
                    value.status = "Пакет обновления отклонён".into();
                    value.last_error = error.clone();
                })?;
                Err(error)
            }
        }
    }

    fn download_package<F>(
        &self,
        version: &str,
        package: &NativeUpdateArtifact,
        progress: F,
    ) -> Result<PathBuf, String>
    where
        F: Fn(u64, u64),
    {
        let directory = self.data_dir.join("updates/staged").join(version);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("create staging directory: {error}"))?;
        let part = directory.join("package.lpupdate.part");
        let published = directory.join("package.lpupdate");
        let mut response = self
            .client
            .get(&package.url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| format!("download update package: {error}"))?;
        if response
            .content_length()
            .is_some_and(|size| size != package.size || size > MAX_PACKAGE)
        {
            return Err("server package size does not match manifest".into());
        }
        let mut output =
            File::create(&part).map_err(|error| format!("create staged package: {error}"))?;
        let mut hasher = Sha256::new();
        let mut transferred = 0_u64;
        let mut buffer = [0_u8; 65_536];
        loop {
            let count = response
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            transferred += count as u64;
            if transferred > package.size || transferred > MAX_PACKAGE {
                let _ = fs::remove_file(&part);
                return Err("downloaded package exceeds manifest size".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| error.to_string())?;
            hasher.update(&buffer[..count]);
            progress(transferred, package.size);
            let _ = self.edit(|value| value.downloaded_bytes = transferred);
        }
        output.sync_all().map_err(|error| error.to_string())?;
        drop(output);
        if transferred != package.size
            || !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&package.sha256)
        {
            let _ = fs::remove_file(&part);
            return Err("update package size or SHA-256 mismatch".into());
        }
        verify_signature(&part, &package.signature)?;
        verify_package_metadata(&part, version)?;
        replace_file(&part, &published)?;
        Ok(published)
    }

    pub fn stage_offline_manifest(&self, path: &Path) -> Result<NativeUpdateSnapshot, String> {
        let bytes = fs::read(path)
            .map_err(|error| format!("read offline manifest {}: {error}", path.display()))?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err("offline manifest exceeds the size limit".into());
        }
        let manifest = parse_manifest(&bytes)?;
        if !newer(env!("CARGO_PKG_VERSION"), &manifest.version)? {
            return Err("offline package is not newer than this client".into());
        }
        let package = artifact(&manifest)?.clone();
        let package_name = package.url.rsplit('/').next().unwrap_or(&package.url);
        let source = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(single_file_name(package_name)?);
        verify_local_package(&source, &package, &manifest.version)?;
        let directory = self.data_dir.join("updates/staged").join(&manifest.version);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("create offline staging directory: {error}"))?;
        let target = directory.join("package.lpupdate");
        copy_file(&source, &target)?;
        {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| "updater state lock is poisoned".to_owned())?;
            guard.0 = Some(manifest.clone());
            guard.1.state = "ready".into();
            guard.1.available_version = manifest.version;
            guard.1.notes = manifest.notes;
            guard.1.status = "Офлайн-пакет проверен и готов".into();
            guard.1.downloaded_bytes = package.size;
            guard.1.total_bytes = package.size;
            guard.1.staged_path = target.display().to_string();
            guard.1.last_checked_at = unix_time();
            guard.1.last_error.clear();
        }
        Ok(self.snapshot())
    }

    pub fn queue_install(&self) -> Result<NativeUpdateSnapshot, String> {
        let snapshot = self.snapshot();
        if snapshot.state != "ready" {
            return Err("Нет проверенного пакета обновления".into());
        }
        let archive = PathBuf::from(&snapshot.staged_path);
        if !archive.is_file() {
            return Err("Подготовленный пакет обновления не найден".into());
        }
        let manifest = self
            .state
            .lock()
            .map_err(|_| "updater state lock is poisoned".to_owned())?
            .0
            .clone()
            .ok_or_else(|| "Манифест подготовленного обновления отсутствует".to_owned())?;
        if manifest.version != snapshot.available_version {
            return Err("Версия подготовленного пакета изменилась".into());
        }
        let package = artifact(&manifest)?.clone();
        verify_local_package(&archive, &package, &manifest.version)?;
        let current =
            env::current_exe().map_err(|error| format!("resolve current executable: {error}"))?;
        let install_root = current
            .parent()
            .ok_or_else(|| "current executable has no parent".to_owned())?
            .to_path_buf();
        let launch_executable = current
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| "current executable name is invalid".to_owned())?
            .to_owned();
        let helper = maintenance_helper(&install_root)?;
        let transaction_root = self.data_dir.join("updates/transactions").join(format!(
            "{}-{}",
            snapshot.available_version,
            Uuid::new_v4()
        ));
        fs::create_dir_all(&transaction_root)
            .map_err(|error| format!("create update transaction: {error}"))?;
        let data_backup = transaction_root.join("data-backup");
        backup_data(&self.data_dir, &data_backup)?;
        let plan = ApplyPlan {
            schema: SCHEMA,
            package_version: snapshot.available_version,
            package_signature: package.signature,
            package_sha256: package.sha256,
            package_size: package.size,
            archive_path: archive,
            install_root,
            launch_executable,
            health_marker: transaction_root.join("health.ok"),
            health_token: Uuid::new_v4().to_string(),
            status_path: transaction_root.join("status.json"),
            transaction_root: transaction_root.clone(),
            data_root: self.data_dir.clone(),
            data_backup,
            parent_pid: std::process::id(),
            startup_timeout_seconds: 30,
        };
        let plan_path = transaction_root.join("apply-plan.json");
        write_json(&plan_path, &plan)?;
        let runner = transaction_root.join(format!(
            "labelpilot-maintenance-runner{}",
            env::consts::EXE_SUFFIX
        ));
        copy_file(&helper, &runner)?;
        Command::new(runner)
            .arg("apply")
            .arg("--plan")
            .arg(plan_path)
            .spawn()
            .map_err(|error| format!("start maintenance helper: {error}"))?;
        self.edit(|value| {
            value.state = "installing".into();
            value.status = "Установка подготовлена; приложение перезапускается".into();
        })?;
        Ok(self.snapshot())
    }
}

fn parse_manifest(bytes: &[u8]) -> Result<NativeUpdateManifest, String> {
    let manifest: NativeUpdateManifest =
        serde_json::from_slice(bytes).map_err(|error| format!("parse manifest: {error}"))?;
    if manifest.schema != SCHEMA {
        return Err(format!("unsupported manifest schema {}", manifest.schema));
    }
    Version::parse(&manifest.version)
        .map_err(|error| format!("invalid update version: {error}"))?;
    let package = artifact(&manifest)?;
    if package.format != "portable-zip"
        || package.size == 0
        || package.size > MAX_PACKAGE
        || package.sha256.len() != 64
        || !package
            .sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || package.signature.trim().is_empty()
    {
        return Err("invalid windows update artifact".into());
    }
    Ok(manifest)
}

fn artifact(manifest: &NativeUpdateManifest) -> Result<&NativeUpdateArtifact, String> {
    manifest
        .platforms
        .get("windows-x86_64")
        .ok_or_else(|| "manifest has no windows-x86_64 package".into())
}

fn newer(current: &str, candidate: &str) -> Result<bool, String> {
    let current = Version::parse(current).map_err(|error| error.to_string())?;
    let candidate = Version::parse(candidate).map_err(|error| error.to_string())?;
    Ok(candidate > current)
}

fn validate_remote_url(url: &str) -> Result<(), String> {
    let value = url.trim().to_ascii_lowercase();
    if value.starts_with("https://") {
        return Ok(());
    }
    let test_http = env::var("LABELPILOT_UPDATE_ALLOW_INSECURE")
        .ok()
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"));
    if test_http
        && (value.starts_with("http://127.0.0.1")
            || value.starts_with("http://localhost")
            || value.starts_with("http://[::1]"))
    {
        return Ok(());
    }
    Err("update URL must use HTTPS".into())
}

fn read_bounded(mut input: impl Read, max: u64) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    input
        .by_ref()
        .take(max + 1)
        .read_to_end(&mut result)
        .map_err(|error| format!("read update manifest: {error}"))?;
    if result.len() as u64 > max {
        return Err("update manifest exceeds size limit".into());
    }
    Ok(result)
}

fn verify_local_package(
    path: &Path,
    package: &NativeUpdateArtifact,
    expected_version: &str,
) -> Result<(), String> {
    let size = fs::metadata(path)
        .map_err(|error| format!("inspect package {}: {error}", path.display()))?
        .len();
    if size != package.size || !sha256(path)?.eq_ignore_ascii_case(&package.sha256) {
        return Err("offline package size or SHA-256 mismatch".into());
    }
    verify_signature(path, &package.signature)?;
    verify_package_metadata(path, expected_version)
}

fn verify_package_metadata(path: &Path, expected_version: &str) -> Result<(), String> {
    let file = File::open(path).map_err(|error| format!("open package metadata: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("open package ZIP: {error}"))?;
    let mut entry = archive
        .by_name(PACKAGE_METADATA)
        .map_err(|error| format!("read signed package metadata entry: {error}"))?;
    if entry.size() > 4_096 {
        return Err("signed package metadata exceeds size limit".into());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read signed package metadata: {error}"))?;
    let metadata: PackageMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse signed package metadata: {error}"))?;
    if metadata.schema != SCHEMA
        || metadata.platform != "windows-x86_64"
        || metadata.version != expected_version
    {
        return Err("signed package metadata does not match the update manifest".into());
    }
    Ok(())
}

fn verify_signature(path: &Path, signature: &str) -> Result<(), String> {
    let public = String::from_utf8(
        STANDARD
            .decode(UPDATE_PUBLIC_KEY)
            .map_err(|error| format!("decode public key: {error}"))?,
    )
    .map_err(|error| format!("public key encoding: {error}"))?;
    let signature = String::from_utf8(
        STANDARD
            .decode(signature.trim())
            .map_err(|error| format!("decode signature: {error}"))?,
    )
    .map_err(|error| format!("signature encoding: {error}"))?;
    let public = PublicKey::decode(&public).map_err(|error| format!("public key: {error}"))?;
    let signature = Signature::decode(&signature).map_err(|error| format!("signature: {error}"))?;
    let bytes = fs::read(path).map_err(|error| format!("read package: {error}"))?;
    if bytes.len() as u64 > MAX_PACKAGE {
        return Err("package exceeds verification limit".into());
    }
    public
        .verify(&bytes, &signature, false)
        .map_err(|error| format!("signature verification failed: {error}"))
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut input = File::open(path).map_err(|error| format!("open file for hash: {error}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn single_file_name(value: &str) -> Result<&OsStr, String> {
    let path = Path::new(value);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err("expected a single file name".into());
    }
    Ok(path.as_os_str())
}

fn maintenance_helper(root: &Path) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("LABELPILOT_MAINTENANCE_EXECUTABLE").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let path = root.join(format!("labelpilot-maintenance{}", env::consts::EXE_SUFFIX));
    path.is_file()
        .then_some(path)
        .ok_or_else(|| "labelpilot-maintenance helper is missing".into())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPlan {
    schema: u32,
    package_version: String,
    package_signature: String,
    package_sha256: String,
    package_size: u64,
    archive_path: PathBuf,
    install_root: PathBuf,
    launch_executable: String,
    health_marker: PathBuf,
    health_token: String,
    status_path: PathBuf,
    transaction_root: PathBuf,
    data_root: PathBuf,
    data_backup: PathBuf,
    parent_pid: u32,
    startup_timeout_seconds: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Rollback {
    schema: u32,
    version: String,
    transaction_root: PathBuf,
    entries: Vec<RollbackEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RollbackEntry {
    relative_path: PathBuf,
    existed: bool,
}

pub fn run_maintenance_cli() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new("apply"))
        || args.next().as_deref() != Some(OsStr::new("--plan"))
    {
        return Err("usage: labelpilot-maintenance apply --plan <path>".into());
    }
    let path = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "missing plan".to_owned())?;
    if args.next().is_some() {
        return Err("unexpected maintenance arguments".into());
    }
    apply_plan(&read_json(&path)?)
}

fn apply_plan(plan: &ApplyPlan) -> Result<(), String> {
    validate_plan(plan)?;
    status(plan, "waiting", "Ожидание завершения приложения")?;
    wait_for_exit(plan.parent_pid, Duration::from_secs(45))?;
    status(plan, "verifying", "Повторная проверка подписи пакета")?;
    if let Err(error) = verify_plan_package(plan) {
        let _ = restore_data(&plan.data_backup, &plan.data_root);
        let _ = status(plan, "rejected", "Подготовленный пакет не прошёл проверку");
        let _ = restart_restored_application(plan);
        return Err(error);
    }
    status(plan, "applying", "Применение обновления")?;
    let rollback = match apply_archive(plan) {
        Ok(rollback) => rollback,
        Err(error) => {
            let _ = restore_data(&plan.data_backup, &plan.data_root);
            let _ = status(
                plan,
                "apply-failed",
                "Замена файлов прервана; версия восстановлена",
            );
            let _ = restart_restored_application(plan);
            return Err(error);
        }
    };
    let executable = plan.install_root.join(&plan.launch_executable);
    let mut child = match Command::new(&executable)
        .arg(format!("--update-health-token={}", plan.health_token))
        .env("LABELPILOT_UPDATE_HEALTH_FILE", &plan.health_marker)
        .env("LABELPILOT_UPDATE_HEALTH_TOKEN", &plan.health_token)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            rollback_files(plan, &rollback)?;
            restore_data(&plan.data_backup, &plan.data_root)?;
            status(plan, "rolling-back", "Новая версия не запустилась")?;
            restart_restored_application(plan)?;
            status(plan, "rolled-back", "Предыдущая версия восстановлена")?;
            return Err(format!("start updated application: {error}"));
        }
    };
    match wait_for_health(plan, &mut child) {
        Ok(true) => {
            status(plan, "confirmed", "Обновление запущено и подтверждено")?;
            write_json(
                &plan.data_root.join("updates/last-transaction.json"),
                &rollback,
            )?;
            Ok(())
        }
        health => {
            let _ = child.kill();
            let _ = child.wait();
            status(plan, "rolling-back", "Новая версия не подтвердила запуск")?;
            rollback_files(plan, &rollback)?;
            restore_data(&plan.data_backup, &plan.data_root)?;
            restart_restored_application(plan)?;
            status(plan, "rolled-back", "Предыдущая версия восстановлена")?;
            match health {
                Ok(false) => Ok(()),
                Err(error) => Err(format!(
                    "health check failed after successful rollback: {error}"
                )),
                Ok(true) => unreachable!(),
            }
        }
    }
}

fn restart_restored_application(plan: &ApplyPlan) -> Result<(), String> {
    Command::new(plan.install_root.join(&plan.launch_executable))
        .arg("--update-rollback-restart")
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("restart restored application: {error}"))
}

fn verify_plan_package(plan: &ApplyPlan) -> Result<(), String> {
    verify_local_package(
        &plan.archive_path,
        &NativeUpdateArtifact {
            url: String::new(),
            signature: plan.package_signature.clone(),
            sha256: plan.package_sha256.clone(),
            size: plan.package_size,
            format: portable_format(),
        },
        &plan.package_version,
    )
}
fn validate_plan(plan: &ApplyPlan) -> Result<(), String> {
    if plan.schema != SCHEMA
        || !plan.archive_path.is_absolute()
        || !plan.install_root.is_absolute()
        || !plan.transaction_root.is_absolute()
        || !plan.data_root.is_absolute()
        || !plan.archive_path.is_file()
        || !plan.install_root.is_dir()
        || plan.package_size == 0
        || plan.package_size > MAX_PACKAGE
        || plan.package_sha256.len() != 64
        || !plan
            .package_sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || plan.package_signature.trim().is_empty()
    {
        return Err("invalid maintenance plan".into());
    }
    single_file_name(&plan.launch_executable)?;
    if plan.health_token.len() < 16 || plan.health_token.len() > 128 {
        return Err("invalid health token".into());
    }
    let transaction = fs::canonicalize(&plan.transaction_root)
        .map_err(|error| format!("canonicalize transaction: {error}"))?;
    let data = fs::canonicalize(&plan.data_root)
        .map_err(|error| format!("canonicalize data root: {error}"))?;
    if !transaction.starts_with(data) {
        return Err("transaction escapes data root".into());
    }
    Ok(())
}

fn apply_archive(plan: &ApplyPlan) -> Result<Rollback, String> {
    verify_package_metadata(&plan.archive_path, &plan.package_version)?;
    let unpacked = plan.transaction_root.join("unpacked");
    if unpacked.exists() {
        fs::remove_dir_all(&unpacked).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&unpacked).map_err(|error| error.to_string())?;
    let files = extract(&plan.archive_path, &unpacked)?;
    if !files
        .iter()
        .any(|path| path == Path::new(&plan.launch_executable))
    {
        return Err("package does not contain launch executable".into());
    }
    let backup = plan.transaction_root.join("binary-backup");
    fs::create_dir_all(&backup).map_err(|error| error.to_string())?;
    let mut rollback = Rollback {
        schema: SCHEMA,
        version: plan.package_version.clone(),
        transaction_root: plan.transaction_root.clone(),
        entries: Vec::new(),
    };
    for relative in &files {
        let target = plan.install_root.join(relative);
        let existed = target.is_file();
        if existed {
            copy_file(&target, &backup.join(relative))?;
        }
        rollback.entries.push(RollbackEntry {
            relative_path: relative.clone(),
            existed,
        });
    }
    write_json(&plan.transaction_root.join("rollback.json"), &rollback)?;
    for relative in files {
        if let Err(error) =
            replace_file(&unpacked.join(&relative), &plan.install_root.join(relative))
        {
            let _ = rollback_files(plan, &rollback);
            return Err(error);
        }
    }
    Ok(rollback)
}

fn extract(archive_path: &Path, target: &Path) -> Result<Vec<PathBuf>, String> {
    let file = File::open(archive_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("open ZIP: {error}"))?;
    if archive.is_empty() || archive.len() > 512 {
        return Err("invalid archive entry count".into());
    }
    let mut total = 0_u64;
    let mut files = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("unsafe ZIP path {}", entry.name()))?;
        if relative == Path::new(PACKAGE_METADATA) {
            continue;
        }
        if entry.is_dir() {
            fs::create_dir_all(target.join(relative)).map_err(|error| error.to_string())?;
            continue;
        }
        total += entry.size();
        if total > MAX_UNPACKED || relative.components().count() > 8 {
            return Err("unpacked archive exceeds limits".into());
        }
        let output_path = target.join(&relative);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(output_path).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        files.push(relative);
    }
    Ok(files)
}

fn rollback_files(plan: &ApplyPlan, rollback: &Rollback) -> Result<(), String> {
    let backup = rollback.transaction_root.join("binary-backup");
    for entry in rollback.entries.iter().rev() {
        let target = plan.install_root.join(&entry.relative_path);
        if entry.existed {
            replace_file(&backup.join(&entry.relative_path), &target)?;
        } else if target.is_file() {
            fs::remove_file(target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn wait_for_health(plan: &ApplyPlan, child: &mut Child) -> Result<bool, String> {
    let deadline = Instant::now() + Duration::from_secs(plan.startup_timeout_seconds.clamp(5, 180));
    while Instant::now() < deadline {
        if fs::read_to_string(&plan.health_marker)
            .is_ok_and(|value| value.trim() == plan.health_token)
        {
            return Ok(true);
        }
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(false)
}

pub fn confirm_startup_health() -> Result<bool, String> {
    let marker = env::var_os("LABELPILOT_UPDATE_HEALTH_FILE").map(PathBuf::from);
    let token = env::var("LABELPILOT_UPDATE_HEALTH_TOKEN").ok().or_else(|| {
        env::args().find_map(|value| {
            value
                .strip_prefix("--update-health-token=")
                .map(str::to_owned)
        })
    });
    let (Some(marker), Some(token)) = (marker, token) else {
        return Ok(false);
    };
    if token.len() < 16 || token.len() > 128 {
        return Err("invalid update health token".into());
    }
    let temporary = marker.with_extension("tmp");
    fs::write(&temporary, token).map_err(|error| error.to_string())?;
    replace_file(&temporary, &marker)?;
    Ok(true)
}

fn backup_data(data: &Path, backup: &Path) -> Result<(), String> {
    fs::create_dir_all(backup).map_err(|error| error.to_string())?;
    for name in DATA_FILES {
        let source = data.join(name);
        if source.is_file() {
            copy_file(&source, &backup.join(name))?;
        }
    }
    if data.join("outbox").is_dir() {
        copy_directory(&data.join("outbox"), &backup.join("outbox"))?;
    }
    Ok(())
}

fn restore_data(backup: &Path, data: &Path) -> Result<(), String> {
    if !backup.is_dir() {
        return Ok(());
    }
    for name in DATA_FILES {
        let source = backup.join(name);
        if source.is_file() {
            replace_file(&source, &data.join(name))?;
        }
    }
    if backup.join("outbox").is_dir() {
        copy_directory(&backup.join("outbox"), &data.join("outbox"))?;
    }
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_directory(&entry.path(), &destination)?;
        } else {
            copy_file(&entry.path(), &destination)?;
        }
    }
    Ok(())
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    let mut output = File::create(target).map_err(|error| error.to_string())?;
    std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    let name = target
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "invalid target name".to_owned())?;
    let temporary = target.with_file_name(format!("{name}.update-new"));
    copy_file(source, &temporary)?;
    publish_file(&temporary, target)
}

#[cfg(windows)]
fn publish_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "atomically publish update file: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn publish_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| error.to_string())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    replace_file(&temporary, path)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn status(plan: &ApplyPlan, state: &str, message: &str) -> Result<(), String> {
    write_json(
        &plan.status_path,
        &serde_json::json!({
            "state": state,
            "version": plan.package_version,
            "message": message,
            "timestamp": unix_time(),
        }),
    )
}

fn unix_time() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_secs())
        .to_string()
}

#[cfg(windows)]
fn wait_for_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject},
    };
    let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
    if handle.is_null() {
        return Ok(());
    }
    let result =
        unsafe { WaitForSingleObject(handle, timeout.as_millis().min(u32::MAX as u128) as u32) };
    unsafe { CloseHandle(handle) };
    match result {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err("application exit timed out".into()),
        value => Err(format!("wait failed with code {value}")),
    }
}

#[cfg(not(windows))]
fn wait_for_exit(_pid: u32, _timeout: Duration) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let path = env::temp_dir().join(format!("labelpilot-update-{name}-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn manifest(format: &str, hash: &str) -> NativeUpdateManifest {
        NativeUpdateManifest {
            schema: SCHEMA,
            version: "2.1.0".into(),
            notes: "fixture".into(),
            published_at: "fixture".into(),
            platforms: BTreeMap::from([(
                "windows-x86_64".into(),
                NativeUpdateArtifact {
                    url: "package.lpupdate".into(),
                    signature: "signed".into(),
                    sha256: hash.into(),
                    size: 3,
                    format: format.into(),
                },
            )]),
        }
    }

    #[test]
    fn semantic_versions_and_paths_are_bounded() {
        assert!(newer("2.0.0", "2.1.0").unwrap());
        assert!(!newer("2.0.0", "2.0.0").unwrap());
        assert!(single_file_name("package.lpupdate").is_ok());
        assert!(single_file_name("../package.lpupdate").is_err());
        assert!(single_file_name("C:\\package.lpupdate").is_err());
        assert!(validate_remote_url("https://example.invalid/update").is_ok());
        assert!(validate_remote_url("http://example.invalid/update").is_err());
    }

    #[test]
    fn manifest_requires_portable_signed_bounded_windows_artifact() {
        assert!(parse_manifest(
            &serde_json::to_vec(&manifest("portable-zip", &"a".repeat(64))).unwrap()
        )
        .is_ok());
        assert!(
            parse_manifest(&serde_json::to_vec(&manifest("exe", &"a".repeat(64))).unwrap())
                .is_err()
        );
        assert!(
            parse_manifest(&serde_json::to_vec(&manifest("portable-zip", "bad")).unwrap()).is_err()
        );
    }

    #[test]
    fn archive_traversal_is_rejected() {
        let root = Temp::new("traversal");
        let path = root.0.join("bad.zip");
        let mut writer = ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file("../outside.exe", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"bad").unwrap();
        writer.finish().unwrap();
        let output = root.0.join("output");
        fs::create_dir_all(&output).unwrap();
        assert!(extract(&path, &output).is_err());
        assert!(!root.0.join("outside.exe").exists());
    }

    #[test]
    fn apply_and_rollback_restore_all_binaries() {
        let root = Temp::new("rollback");
        let install = root.0.join("install");
        let data = root.0.join("data");
        let transaction = data.join("updates/transaction");
        fs::create_dir_all(&install).unwrap();
        fs::create_dir_all(&transaction).unwrap();
        fs::write(install.join("labelpilot-slint.exe"), b"old").unwrap();
        let archive = root.0.join("update.zip");
        let mut writer = ZipWriter::new(File::create(&archive).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file(PACKAGE_METADATA, options).unwrap();
        writer
            .write_all(br#"{"schema":1,"version":"2.1.0","platform":"windows-x86_64"}"#)
            .unwrap();
        writer.start_file("labelpilot-slint.exe", options).unwrap();
        writer.write_all(b"new").unwrap();
        writer
            .start_file("labelpilot-maintenance.exe", options)
            .unwrap();
        writer.write_all(b"helper").unwrap();
        writer.finish().unwrap();
        let plan = ApplyPlan {
            schema: SCHEMA,
            package_version: "2.1.0".into(),
            package_signature: "unit-test-signature".into(),
            package_sha256: sha256(&archive).unwrap(),
            package_size: fs::metadata(&archive).unwrap().len(),
            archive_path: archive,
            install_root: install.clone(),
            launch_executable: "labelpilot-slint.exe".into(),
            health_marker: transaction.join("health.ok"),
            health_token: Uuid::new_v4().to_string(),
            status_path: transaction.join("status.json"),
            transaction_root: transaction.clone(),
            data_root: data,
            data_backup: transaction.join("data-backup"),
            parent_pid: 0,
            startup_timeout_seconds: 5,
        };
        let mut tampered_plan = plan.clone();
        tampered_plan.package_sha256 = "0".repeat(64);
        assert!(verify_plan_package(&tampered_plan).is_err());
        let rollback = apply_archive(&plan).unwrap();
        assert_eq!(
            fs::read(install.join("labelpilot-slint.exe")).unwrap(),
            b"new"
        );
        assert!(install.join("labelpilot-maintenance.exe").is_file());
        rollback_files(&plan, &rollback).unwrap();
        assert_eq!(
            fs::read(install.join("labelpilot-slint.exe")).unwrap(),
            b"old"
        );
        assert!(!install.join("labelpilot-maintenance.exe").exists());
    }

    #[test]
    fn signed_package_metadata_binds_the_manifest_version() {
        let root = Temp::new("metadata");
        let archive = root.0.join("update.zip");
        let mut writer = ZipWriter::new(File::create(&archive).unwrap());
        writer
            .start_file(PACKAGE_METADATA, SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(br#"{"schema":1,"version":"2.1.0","platform":"windows-x86_64"}"#)
            .unwrap();
        writer.finish().unwrap();
        assert!(verify_package_metadata(&archive, "2.1.0").is_ok());
        assert!(verify_package_metadata(&archive, "2.2.0").is_err());
    }

    #[test]
    fn data_snapshot_restores_database_and_queue() {
        let root = Temp::new("data");
        let data = root.0.join("data");
        let backup = root.0.join("backup");
        fs::create_dir_all(data.join("outbox")).unwrap();
        fs::write(data.join("client_data.db"), b"before").unwrap();
        fs::write(data.join("outbox/job.lpr"), b"queued").unwrap();
        backup_data(&data, &backup).unwrap();
        fs::write(data.join("client_data.db"), b"after").unwrap();
        restore_data(&backup, &data).unwrap();
        assert_eq!(fs::read(data.join("client_data.db")).unwrap(), b"before");
        assert_eq!(fs::read(data.join("outbox/job.lpr")).unwrap(), b"queued");
    }
}
