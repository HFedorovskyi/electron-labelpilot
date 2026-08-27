use semver::Version;
use serde_json::json;
use std::{
    env,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const PLATFORM: &str = "windows-x86_64";
const METADATA_NAME: &str = ".labelpilot-update.json";

fn main() {
    if let Err(error) = run() {
        eprintln!("native package builder: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let output = next_path(&mut args, "output package")?;
    let slint = next_path(&mut args, "Slint executable")?;
    let maintenance = next_path(&mut args, "maintenance executable")?;
    let version = args
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| "missing UTF-8 version".to_owned())?;
    if args.next().is_some() {
        return Err(
            "usage: build_native_update_package <output> <slint> <maintenance> <version>".into(),
        );
    }
    Version::parse(&version).map_err(|error| format!("invalid semantic version: {error}"))?;
    for input in [&slint, &maintenance] {
        if !input.is_file() {
            return Err(format!("package input is missing: {}", input.display()));
        }
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create output directory: {error}"))?;
    }

    let file = File::create(&output).map_err(|error| format!("create package: {error}"))?;
    let mut archive = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let metadata = serde_json::to_vec(&json!({
        "schema": 1,
        "version": version,
        "platform": PLATFORM,
    }))
    .map_err(|error| format!("serialize package metadata: {error}"))?;
    archive
        .start_file(METADATA_NAME, options)
        .map_err(|error| format!("start metadata entry: {error}"))?;
    archive
        .write_all(&metadata)
        .map_err(|error| format!("write metadata entry: {error}"))?;
    append_file(&mut archive, &slint, "labelpilot-slint.exe", options)?;
    append_file(
        &mut archive,
        &maintenance,
        "labelpilot-maintenance.exe",
        options,
    )?;
    let mut writer = archive
        .finish()
        .map_err(|error| format!("finish package: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("flush package: {error}"))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| format!("sync package: {error}"))?;
    let bytes = fs::metadata(&output)
        .map_err(|error| format!("inspect package: {error}"))?
        .len();
    println!(
        "STORED_PACKAGE_OK version={version} bytes={bytes} path={}",
        output.display()
    );
    Ok(())
}

fn next_path(
    args: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> Result<PathBuf, String> {
    args.next()
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing {name}"))
}

fn append_file(
    archive: &mut ZipWriter<BufWriter<File>>,
    source: &Path,
    name: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    archive
        .start_file(name, options)
        .map_err(|error| format!("start {name}: {error}"))?;
    let input =
        File::open(source).map_err(|error| format!("open {}: {error}", source.display()))?;
    io::copy(&mut BufReader::new(input), archive)
        .map_err(|error| format!("write {name}: {error}"))?;
    Ok(())
}
