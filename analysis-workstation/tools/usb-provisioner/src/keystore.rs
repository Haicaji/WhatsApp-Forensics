use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const SCHEMA: &str = "wafc-workstation-config-key/1";
const AAD_DOMAIN: &[u8] = b"WAFC-WORKSTATION-CONFIG-KEY-v1\0";
const MAX_DOCUMENT_BYTES: u64 = 64 * 1024;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const SECRET_BYTES: usize = 32;
const MIN_PASSPHRASE_BYTES: usize = 12;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const MEMORY_KIB: u32 = 65_536;
const ITERATIONS: u32 = 3;
const PARALLELISM: u32 = 1;

#[derive(Debug, Error)]
pub(crate) enum WorkstationKeyError {
    #[error("workstation key already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("workstation key passphrase must contain 12 to 1024 UTF-8 bytes")]
    InvalidPassphrase,
    #[error("invalid or unsupported workstation key: {0}")]
    InvalidDocument(String),
    #[error("workstation key unlock failed")]
    UnlockFailed,
    #[error("operating-system random source failed")]
    Random,
    #[error("workstation key derivation failed")]
    Kdf,
    #[error("Ed25519 key encoding failed")]
    KeyEncoding,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyDocument {
    schema_version: String,
    workstation_id: String,
    key_id: String,
    kdf: KdfDocument,
    cipher: CipherDocument,
    public_key: PublicKeyDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KdfDocument {
    algorithm: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CipherDocument {
    algorithm: String,
    nonce_base64: String,
    ciphertext_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicKeyDocument {
    algorithm: String,
    encoding: String,
    spki_base64: String,
    fingerprint_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateDocument {
    schema_version: String,
    workstation_id: String,
    key_id: String,
    private_key_pkcs8_base64: String,
}

impl Drop for PrivateDocument {
    fn drop(&mut self) {
        self.private_key_pkcs8_base64.zeroize();
    }
}

pub(crate) struct CreatedWorkstationKey {
    pub signing_key: SigningKey,
    pub public_key_spki_base64: String,
    pub fingerprint_sha256: String,
}

pub(crate) fn create(
    path: &Path,
    workstation_id: &str,
    key_id: &str,
    passphrase: &str,
) -> Result<CreatedWorkstationKey, WorkstationKeyError> {
    validate_passphrase(passphrase)?;
    if path.exists() {
        return Err(WorkstationKeyError::AlreadyExists(path.to_path_buf()));
    }
    let mut secret = Zeroizing::new([0_u8; SECRET_BYTES]);
    getrandom::fill(&mut *secret).map_err(|_| WorkstationKeyError::Random)?;
    let signing_key = SigningKey::from_bytes(&secret);
    save(path, workstation_id, key_id, passphrase, signing_key)
}

#[allow(clippy::too_many_lines)]
fn save(
    path: &Path,
    workstation_id: &str,
    key_id: &str,
    passphrase: &str,
    signing_key: SigningKey,
) -> Result<CreatedWorkstationKey, WorkstationKeyError> {
    let spki = signing_key
        .verifying_key()
        .to_public_key_der()
        .map_err(|_| WorkstationKeyError::KeyEncoding)?;
    let fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(spki.as_bytes())));
    let mut salt = [0_u8; SALT_BYTES];
    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut salt).map_err(|_| WorkstationKeyError::Random)?;
    getrandom::fill(&mut nonce).map_err(|_| WorkstationKeyError::Random)?;
    let private = PrivateDocument {
        schema_version: SCHEMA.to_owned(),
        workstation_id: workstation_id.to_owned(),
        key_id: key_id.to_owned(),
        private_key_pkcs8_base64: BASE64.encode(
            signing_key
                .to_pkcs8_der()
                .map_err(|_| WorkstationKeyError::KeyEncoding)?
                .as_bytes(),
        ),
    };
    let mut plaintext = Zeroizing::new(serde_json::to_vec(&private)?);
    let aad = aad(workstation_id, key_id, &salt, &nonce, spki.as_bytes());
    let derived = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&derived[..]));
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| WorkstationKeyError::UnlockFailed)?;
    plaintext.zeroize();
    let document = KeyDocument {
        schema_version: SCHEMA.to_owned(),
        workstation_id: workstation_id.to_owned(),
        key_id: key_id.to_owned(),
        kdf: KdfDocument {
            algorithm: "argon2id".to_owned(),
            memory_kib: MEMORY_KIB,
            iterations: ITERATIONS,
            parallelism: PARALLELISM,
            salt_base64: BASE64.encode(salt),
        },
        cipher: CipherDocument {
            algorithm: "xchacha20-poly1305".to_owned(),
            nonce_base64: BASE64.encode(nonce),
            ciphertext_base64: BASE64.encode(ciphertext),
        },
        public_key: PublicKeyDocument {
            algorithm: "Ed25519".to_owned(),
            encoding: "spki-der".to_owned(),
            spki_base64: BASE64.encode(spki.as_bytes()),
            fingerprint_sha256: fingerprint.clone(),
        },
    };
    write_json_new(path, &document)?;
    Ok(CreatedWorkstationKey {
        signing_key,
        public_key_spki_base64: document.public_key.spki_base64,
        fingerprint_sha256: fingerprint,
    })
}

#[allow(clippy::too_many_lines)]
pub(crate) fn unlock(
    path: &Path,
    passphrase: &str,
) -> Result<CreatedWorkstationKey, WorkstationKeyError> {
    validate_passphrase(passphrase)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_DOCUMENT_BYTES
    {
        return Err(WorkstationKeyError::InvalidDocument(
            "key path is not a bounded regular file".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    fs::File::open(path)?
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let document: KeyDocument = serde_json::from_slice(&bytes)?;
    validate_document(&document)?;
    let salt = decode_exact::<SALT_BYTES>(&document.kdf.salt_base64)?;
    let nonce = decode_exact::<NONCE_BYTES>(&document.cipher.nonce_base64)?;
    let spki = BASE64
        .decode(&document.public_key.spki_base64)
        .map_err(|_| WorkstationKeyError::InvalidDocument("invalid public key".to_owned()))?;
    let expected_fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(&spki)));
    if expected_fingerprint != document.public_key.fingerprint_sha256 {
        return Err(WorkstationKeyError::InvalidDocument(
            "public-key fingerprint mismatch".to_owned(),
        ));
    }
    let ciphertext = BASE64
        .decode(&document.cipher.ciphertext_base64)
        .map_err(|_| WorkstationKeyError::InvalidDocument("invalid ciphertext".to_owned()))?;
    let aad = aad(
        &document.workstation_id,
        &document.key_id,
        &salt,
        &nonce,
        &spki,
    );
    let derived = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&derived[..]));
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| WorkstationKeyError::UnlockFailed)?;
    let plaintext = Zeroizing::new(plaintext);
    let private: PrivateDocument =
        serde_json::from_slice(&plaintext).map_err(|_| WorkstationKeyError::UnlockFailed)?;
    if private.schema_version != SCHEMA
        || private.workstation_id != document.workstation_id
        || private.key_id != document.key_id
    {
        return Err(WorkstationKeyError::UnlockFailed);
    }
    let pkcs8 = Zeroizing::new(
        BASE64
            .decode(&private.private_key_pkcs8_base64)
            .map_err(|_| WorkstationKeyError::UnlockFailed)?,
    );
    let signing_key =
        SigningKey::from_pkcs8_der(&pkcs8).map_err(|_| WorkstationKeyError::UnlockFailed)?;
    let actual_spki = signing_key
        .verifying_key()
        .to_public_key_der()
        .map_err(|_| WorkstationKeyError::KeyEncoding)?;
    if actual_spki.as_bytes() != spki {
        return Err(WorkstationKeyError::UnlockFailed);
    }
    Ok(CreatedWorkstationKey {
        signing_key,
        public_key_spki_base64: document.public_key.spki_base64,
        fingerprint_sha256: expected_fingerprint,
    })
}

fn validate_document(document: &KeyDocument) -> Result<(), WorkstationKeyError> {
    if document.schema_version != SCHEMA
        || document.workstation_id.is_empty()
        || document.workstation_id.len() > 120
        || document.key_id.is_empty()
        || document.key_id.len() > 120
        || document.workstation_id.chars().any(char::is_control)
        || document.key_id.chars().any(char::is_control)
        || document.kdf.algorithm != "argon2id"
        || document.kdf.memory_kib != MEMORY_KIB
        || document.kdf.iterations != ITERATIONS
        || document.kdf.parallelism != PARALLELISM
        || document.cipher.algorithm != "xchacha20-poly1305"
        || document.public_key.algorithm != "Ed25519"
        || document.public_key.encoding != "spki-der"
    {
        return Err(WorkstationKeyError::InvalidDocument(
            "metadata or algorithms differ from v1".to_owned(),
        ));
    }
    Ok(())
}

fn derive_key(
    passphrase: &str,
    salt: &[u8; SALT_BYTES],
) -> Result<Zeroizing<[u8; 32]>, WorkstationKeyError> {
    let params = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, Some(32))
        .map_err(|_| WorkstationKeyError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut derived = Zeroizing::new([0_u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut *derived)
        .map_err(|_| WorkstationKeyError::Kdf)?;
    Ok(derived)
}

fn aad(
    workstation_id: &str,
    key_id: &str,
    salt: &[u8; SALT_BYTES],
    nonce: &[u8; NONCE_BYTES],
    spki: &[u8],
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        AAD_DOMAIN.len()
            + workstation_id.len()
            + key_id.len()
            + salt.len()
            + nonce.len()
            + spki.len()
            + 2,
    );
    aad.extend_from_slice(AAD_DOMAIN);
    aad.extend_from_slice(workstation_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(key_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(salt);
    aad.extend_from_slice(nonce);
    aad.extend_from_slice(spki);
    aad
}

fn decode_exact<const N: usize>(value: &str) -> Result<[u8; N], WorkstationKeyError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| WorkstationKeyError::InvalidDocument("invalid Base64".to_owned()))?;
    bytes
        .try_into()
        .map_err(|_| WorkstationKeyError::InvalidDocument("invalid field length".to_owned()))
}

fn validate_passphrase(passphrase: &str) -> Result<(), WorkstationKeyError> {
    if (MIN_PASSPHRASE_BYTES..=MAX_PASSPHRASE_BYTES).contains(&passphrase.len()) {
        Ok(())
    } else {
        Err(WorkstationKeyError::InvalidPassphrase)
    }
}

fn write_json_new<T: Serialize>(path: &Path, value: &T) -> Result<(), WorkstationKeyError> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}
