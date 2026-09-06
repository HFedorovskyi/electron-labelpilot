use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs;
use std::path::Path;

fn decode_outer_file(path: &Path, label: &str) -> Result<String, String> {
    let encoded = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {label} {}: {error}", path.display()))?;
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("failed to decode outer {label} base64: {error}"))?;
    String::from_utf8(decoded).map_err(|error| format!("{label} is not UTF-8: {error}"))
}

fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let artifact = args.next().ok_or_else(|| {
        "usage: verify_update_signature <artifact> <public-key> <signature>".to_owned()
    })?;
    let public_key = args
        .next()
        .ok_or_else(|| "missing public-key path".to_owned())?;
    let signature = args
        .next()
        .ok_or_else(|| "missing signature path".to_owned())?;
    if args.next().is_some() {
        return Err("too many arguments".to_owned());
    }

    let public_text = decode_outer_file(Path::new(&public_key), "public key")?;
    let signature_text = decode_outer_file(Path::new(&signature), "signature")?;
    let public_key =
        PublicKey::decode(&public_text).map_err(|error| format!("invalid public key: {error}"))?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("invalid signature: {error}"))?;
    let bytes = fs::read(&artifact).map_err(|error| {
        format!(
            "failed to read artifact {}: {error}",
            Path::new(&artifact).display()
        )
    })?;
    public_key
        .verify(&bytes, &signature, false)
        .map_err(|error| format!("signature verification failed: {error}"))?;
    println!("SIGNATURE_VALID bytes={}", bytes.len());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
