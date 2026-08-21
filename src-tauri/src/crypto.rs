use crate::persisted::PersistedState;
use aes::Aes256;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use ed25519_dalek::{Signature, VerifyingKey};
use hkdf::Hkdf;
use serde_json::Value;
use sha2::Sha256;
use std::fmt;

const LPI2_MAGIC: &[u8] = b"LPI2\n";
const MAX_TOKEN_BYTES: usize = 16 * 1024;
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
    license_id: Option<String>,
}

impl DecodedPush {
    pub fn persist_verified_token(&self, persisted: &PersistedState) -> Result<bool, String> {
        let Some(token) = self.token.as_deref() else {
            return Ok(false);
        };
        let Some(incoming_id) = self.license_id.as_deref() else {
            return Err("verified LPI2 token has no license_id".to_owned());
        };
        match persisted.load_license_token() {
            None => {
                persisted.save_license_token(token)?;
                Ok(true)
            }
            Some(existing)
                if license_id_without_verification(&existing).as_deref() == Some(incoming_id) =>
            {
                persisted.save_license_token(token)?;
                Ok(true)
            }
            Some(_) => Ok(false),
        }
    }
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
    let (license_id, key_version) = verify_license_token(token, public_key)?;
    let key = derive_data_key(&license_id, key_version)?;
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
        return decode_lpi2_with_key(body, &LICENSE_PUBLIC_KEY);
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
        license_id: None,
    })
}

fn decode_lpi2_with_key(
    blob: &[u8],
    public_key: &[u8; 32],
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
    if encrypted.len() < 32 || (encrypted.len() - 16) % 16 != 0 {
        return Err(PushDecodeError::Invalid(
            "Malformed LPI2 encrypted body length".to_owned(),
        ));
    }

    let (license_id, key_version) = verify_license_token(token, public_key)?;
    let key = derive_data_key(&license_id, key_version)?;

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
        license_id: Some(license_id),
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

fn verify_license_token(
    token: &str,
    public_key: &[u8; 32],
) -> Result<(String, i64), PushDecodeError> {
    let (payload_part, signature_part) = token
        .split_once('.')
        .ok_or_else(|| PushDecodeError::Invalid("Malformed license token".to_owned()))?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_part)
        .map_err(|_| PushDecodeError::Invalid("Malformed license payload encoding".to_owned()))?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_part)
        .map_err(|_| PushDecodeError::Invalid("Malformed license signature encoding".to_owned()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| PushDecodeError::Invalid("Malformed Ed25519 signature length".to_owned()))?;
    let verifying_key = VerifyingKey::from_bytes(public_key)
        .map_err(|_| PushDecodeError::Invalid("Invalid Ed25519 public key".to_owned()))?;
    verifying_key
        .verify_strict(&payload, &signature)
        .map_err(|_| PushDecodeError::Invalid("Invalid license signature".to_owned()))?;

    let license: Value = serde_json::from_slice(&payload)
        .map_err(|_| PushDecodeError::Invalid("License payload is not valid JSON".to_owned()))?;
    let object = license
        .as_object()
        .ok_or_else(|| PushDecodeError::Invalid("License payload must be an object".to_owned()))?;
    let license_id = object
        .get("license_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PushDecodeError::Invalid("License has no license_id".to_owned()))?
        .to_owned();
    let key_version = integer_value(object.get("key_version").unwrap_or(&Value::from(1)))
        .ok_or_else(|| PushDecodeError::Invalid("License has malformed key_version".to_owned()))?;
    Ok((license_id, key_version))
}

fn integer_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok())),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn license_id_without_verification(token: &str) -> Option<String> {
    let (payload, _) = token.split_once('.')?;
    let payload = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice::<Value>(&payload)
        .ok()?
        .get("license_id")?
        .as_str()
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

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
            decode_lpi2_with_key(&blob, &public_key).unwrap().value,
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
        let decoded = decode_lpi2_with_key(&blob, &public_key).expect("decode fixture");
        assert_eq!(decoded.value, fixture["plaintext"]);
        assert_eq!(decoded.license_id.as_deref(), Some("fixture-license-2026"));
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
        assert!(decode_lpi2_with_key(&blob, &public_key).is_err());

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
