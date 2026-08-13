//! Portable, password-encrypted Ed25519 signing-key storage.
//!
//! The keystore is deliberately machine-independent: unlike DPAPI it can travel
//! with the Field Collector on removable media.  Its password is never stored.

use std::fs::File;
#[cfg(any(test, feature = "provisioning"))]
use std::fs::{self, OpenOptions};
use std::io::Read;
#[cfg(any(test, feature = "provisioning"))]
use std::io::Write;
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
#[cfg(any(test, feature = "provisioning"))]
use ed25519_dalek::pkcs8::EncodePrivateKey;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const SCHEMA_VERSION: &str = "2.0.0";
const PRIVATE_SCHEMA_VERSION: &str = "wafc-operator-private-key/1";
const AAD: &[u8] = b"WAFC-PORTABLE-KEYSTORE-v2\0";
const MAX_KEYSTORE_BYTES: u64 = 64 * 1024;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
#[cfg(any(test, feature = "provisioning"))]
const SECRET_KEY_BYTES: usize = 32;
const MIN_PASSPHRASE_CHARACTERS: usize = 8;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const ARGON2_MEMORY_KIB: u32 = 65_536;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;

/// Errors returned by portable-keystore operations.
#[derive(Debug, Error)]
pub enum KeystoreError {
    /// The requested destination already exists.
    #[error("refusing to overwrite existing keystore: {0}")]
    AlreadyExists(PathBuf),
    /// The passphrase is outside the accepted length range.
    #[error(
        "passphrase must contain at least {MIN_PASSPHRASE_CHARACTERS} characters and at most {MAX_PASSPHRASE_BYTES} UTF-8 bytes"
    )]
    InvalidPassphraseLength,
    /// A newly created key passphrase does not include the required character classes.
    #[error(
        "a new key passphrase must contain an uppercase letter, a lowercase letter, a digit, and a symbol"
    )]
    WeakPassphrase,
    /// The file is larger than the defensive parser limit.
    #[error("keystore exceeds the {MAX_KEYSTORE_BYTES}-byte limit")]
    FileTooLarge,
    /// The JSON container is invalid or uses an unsupported algorithm/version.
    #[error("invalid or unsupported keystore: {0}")]
    InvalidContainer(String),
    /// Password verification or authenticated decryption failed.
    #[error("keystore unlock failed (wrong passphrase or corrupt file)")]
    UnlockFailed,
    /// Entropy acquisition failed.
    #[error("operating-system random source failed: {0}")]
    Random(String),
    /// Argon2 parameter or derivation failure.
    #[error("key derivation failed: {0}")]
    Kdf(String),
    /// PKCS#8 encoding or decoding failed.
    #[error("Ed25519 key encoding failed: {0}")]
    KeyEncoding(String),
    /// An I/O operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// JSON serialization or parsing failed.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Metadata returned after creating a portable signing key.
#[cfg(any(test, feature = "provisioning"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedKeystore {
    /// Lowercase `sha256:` fingerprint of the DER `SubjectPublicKeyInfo` bytes.
    pub public_key_fingerprint_sha256: String,
    /// Base64-encoded DER `SubjectPublicKeyInfo` public key.
    pub public_key_spki_base64: String,
}

/// Workstation and operator identity bound inside the authenticated encrypted
/// private-key payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeystoreBinding {
    /// Canonical operator identifier from `operator-profile.json`.
    pub operator_id: String,
    /// Stable evidence-signing key identifier.
    pub key_id: String,
    /// Fingerprint of the Workstation configuration-signing public key.
    pub workstation_key_fingerprint_sha256: String,
}

/// Public metadata that can be inspected without decrypting the private key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedKeystore {
    /// Lowercase `sha256:` fingerprint of the DER-SPKI public key.
    pub public_key_fingerprint_sha256: String,
    /// Base64-encoded DER-SPKI public key retained only in the configuration area.
    pub public_key_spki_base64: String,
}

/// Successfully unlocked evidence-signing key and its authenticated binding.
pub struct UnlockedKeystore {
    /// Ed25519 signing key. Its implementation zeroizes secret material on drop.
    pub signing_key: SigningKey,
    /// Binding recovered from the encrypted payload.
    pub binding: KeystoreBinding,
    /// Lowercase `sha256:` fingerprint derived from the unlocked public key.
    pub public_key_fingerprint_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeystoreDocument {
    schema_version: String,
    kdf: KdfDocument,
    cipher: CipherDocument,
    public_key: PublicKeyDocument,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KdfDocument {
    algorithm: String,
    version: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CipherDocument {
    algorithm: String,
    nonce_base64: String,
    ciphertext_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicKeyDocument {
    algorithm: String,
    encoding: String,
    spki_base64: String,
    fingerprint_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateKeyDocument {
    schema_version: String,
    private_key_pkcs8_base64: String,
    binding: KeystoreBinding,
}

/// Generates a new Ed25519 key and stores it in a new encrypted file.
///
/// Existing files are never overwritten.
///
/// # Errors
///
/// Returns an error for an invalid passphrase, an existing destination, an
/// unavailable operating-system random source, or an I/O/cryptographic failure.
#[cfg(any(test, feature = "provisioning"))]
pub fn create(
    path: &Path,
    passphrase: &str,
    binding: &KeystoreBinding,
) -> Result<CreatedKeystore, KeystoreError> {
    validate_new_passphrase(passphrase)?;
    validate_binding(binding)?;
    let mut secret = Zeroizing::new([0_u8; SECRET_KEY_BYTES]);
    getrandom::fill(&mut *secret).map_err(|error| KeystoreError::Random(error.to_string()))?;
    let signing_key = SigningKey::from_bytes(&secret);
    save(path, passphrase, &signing_key, binding)
}

/// Encrypts and stores an existing Ed25519 signing key.
///
/// Existing files are never overwritten and the write is made atomic within
/// the destination directory.
///
/// # Errors
///
/// Returns an error for an invalid passphrase, an existing destination, an
/// unavailable operating-system random source, or an I/O/cryptographic failure.
#[cfg(any(test, feature = "provisioning"))]
pub fn save(
    path: &Path,
    passphrase: &str,
    signing_key: &SigningKey,
    binding: &KeystoreBinding,
) -> Result<CreatedKeystore, KeystoreError> {
    validate_new_passphrase(passphrase)?;
    validate_binding(binding)?;
    if path.exists() {
        return Err(KeystoreError::AlreadyExists(path.to_path_buf()));
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let mut salt = [0_u8; SALT_BYTES];
    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut salt).map_err(|error| KeystoreError::Random(error.to_string()))?;
    getrandom::fill(&mut nonce).map_err(|error| KeystoreError::Random(error.to_string()))?;

    let derived_key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&*derived_key));
    let private_key_der = signing_key
        .to_pkcs8_der()
        .map_err(|error| KeystoreError::KeyEncoding(error.to_string()))?;
    let mut private_document = PrivateKeyDocument {
        schema_version: PRIVATE_SCHEMA_VERSION.to_owned(),
        private_key_pkcs8_base64: BASE64.encode(private_key_der.as_bytes()),
        binding: binding.clone(),
    };
    let mut private_bytes = Zeroizing::new(serde_json::to_vec(&private_document)?);
    private_document.private_key_pkcs8_base64.zeroize();
    let encrypted = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &private_bytes,
                aad: AAD,
            },
        )
        .map_err(|_| KeystoreError::UnlockFailed)?;
    private_bytes.zeroize();

    let public_spki = signing_key
        .verifying_key()
        .to_public_key_der()
        .map_err(|error| KeystoreError::KeyEncoding(error.to_string()))?;
    let fingerprint = hex::encode(Sha256::digest(public_spki.as_bytes()));
    let public_spki_base64 = BASE64.encode(public_spki.as_bytes());

    let document = KeystoreDocument {
        schema_version: SCHEMA_VERSION.to_owned(),
        kdf: KdfDocument {
            algorithm: "argon2id".to_owned(),
            version: "0x13".to_owned(),
            memory_kib: ARGON2_MEMORY_KIB,
            iterations: ARGON2_ITERATIONS,
            parallelism: ARGON2_PARALLELISM,
            salt_base64: BASE64.encode(salt),
        },
        cipher: CipherDocument {
            algorithm: "xchacha20-poly1305".to_owned(),
            nonce_base64: BASE64.encode(nonce),
            ciphertext_base64: BASE64.encode(encrypted),
        },
        public_key: PublicKeyDocument {
            algorithm: "Ed25519".to_owned(),
            encoding: "spki-der".to_owned(),
            spki_base64: public_spki_base64.clone(),
            fingerprint_sha256: fingerprint.clone(),
        },
    };
    let bytes = serde_json::to_vec_pretty(&document)?;
    atomic_create(path, &bytes)?;

    Ok(CreatedKeystore {
        public_key_fingerprint_sha256: format!("sha256:{fingerprint}"),
        public_key_spki_base64: public_spki_base64,
    })
}

/// Opens and decrypts a portable keystore.
///
/// # Errors
///
/// Returns an error for an invalid/corrupt container, an incorrect passphrase,
/// an unsupported parameter set, or an I/O/cryptographic failure.
pub fn unlock(path: &Path, passphrase: &str) -> Result<UnlockedKeystore, KeystoreError> {
    validate_unlock_passphrase(passphrase)?;
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > MAX_KEYSTORE_BYTES {
        return Err(KeystoreError::FileTooLarge);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.read_to_end(&mut bytes)?;
    let document: KeystoreDocument = serde_json::from_slice(&bytes)?;
    validate_document(&document)?;

    let salt = decode_fixed::<SALT_BYTES>(&document.kdf.salt_base64, "salt")?;
    let nonce = decode_fixed::<NONCE_BYTES>(&document.cipher.nonce_base64, "nonce")?;
    let ciphertext = BASE64
        .decode(&document.cipher.ciphertext_base64)
        .map_err(|_| {
            KeystoreError::InvalidContainer("ciphertext is not valid base64".to_owned())
        })?;
    let derived_key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&*derived_key));
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: AAD,
            },
        )
        .map_err(|_| KeystoreError::UnlockFailed)?;
    let mut plaintext = Zeroizing::new(plaintext);
    let mut private_document: PrivateKeyDocument =
        serde_json::from_slice(&plaintext).map_err(|_| KeystoreError::UnlockFailed)?;
    if private_document.schema_version != PRIVATE_SCHEMA_VERSION
        || validate_binding(&private_document.binding).is_err()
    {
        return Err(KeystoreError::UnlockFailed);
    }
    let mut private_der = Zeroizing::new(
        BASE64
            .decode(&private_document.private_key_pkcs8_base64)
            .map_err(|_| KeystoreError::UnlockFailed)?,
    );
    private_document.private_key_pkcs8_base64.zeroize();
    let signing_key =
        SigningKey::from_pkcs8_der(&private_der).map_err(|_| KeystoreError::UnlockFailed)?;
    private_der.zeroize();
    plaintext.zeroize();

    let public_spki = signing_key
        .verifying_key()
        .to_public_key_der()
        .map_err(|error| KeystoreError::KeyEncoding(error.to_string()))?;
    let actual_spki = BASE64.encode(public_spki.as_bytes());
    let actual_fingerprint = hex::encode(Sha256::digest(public_spki.as_bytes()));
    if actual_spki != document.public_key.spki_base64
        || actual_fingerprint != document.public_key.fingerprint_sha256
    {
        return Err(KeystoreError::UnlockFailed);
    }
    Ok(UnlockedKeystore {
        signing_key,
        binding: private_document.binding,
        public_key_fingerprint_sha256: format!("sha256:{actual_fingerprint}"),
    })
}

/// Reads and validates only the public keystore container metadata.
///
/// This does not authenticate the Workstation trust anchor. Callers must still
/// unlock the encrypted payload and compare its binding before acquisition.
///
/// # Errors
///
/// Returns an error for oversized, malformed, unsafe, or unsupported containers.
pub fn inspect(path: &Path) -> Result<InspectedKeystore, KeystoreError> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > MAX_KEYSTORE_BYTES {
        return Err(KeystoreError::FileTooLarge);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.read_to_end(&mut bytes)?;
    let document: KeystoreDocument = serde_json::from_slice(&bytes)?;
    validate_document(&document)?;
    Ok(InspectedKeystore {
        public_key_fingerprint_sha256: format!("sha256:{}", document.public_key.fingerprint_sha256),
        public_key_spki_base64: document.public_key.spki_base64,
    })
}

fn validate_unlock_passphrase(passphrase: &str) -> Result<(), KeystoreError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARACTERS
        || passphrase.len() > MAX_PASSPHRASE_BYTES
    {
        return Err(KeystoreError::InvalidPassphraseLength);
    }
    Ok(())
}

#[cfg(any(test, feature = "provisioning"))]
fn validate_new_passphrase(passphrase: &str) -> Result<(), KeystoreError> {
    validate_unlock_passphrase(passphrase)?;
    if passphrase.chars().any(char::is_control)
        || !passphrase
            .chars()
            .any(|character| character.is_ascii_uppercase())
        || !passphrase
            .chars()
            .any(|character| character.is_ascii_lowercase())
        || !passphrase
            .chars()
            .any(|character| character.is_ascii_digit())
        || !passphrase
            .chars()
            .any(|character| character.is_ascii_punctuation())
    {
        return Err(KeystoreError::WeakPassphrase);
    }
    Ok(())
}

fn derive_key(
    passphrase: &str,
    salt: &[u8; SALT_BYTES],
) -> Result<Zeroizing<[u8; 32]>, KeystoreError> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(32),
    )
    .map_err(|error| KeystoreError::Kdf(error.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut *output)
        .map_err(|error| KeystoreError::Kdf(error.to_string()))?;
    Ok(output)
}

fn validate_document(document: &KeystoreDocument) -> Result<(), KeystoreError> {
    let valid = document.schema_version == SCHEMA_VERSION
        && document.kdf.algorithm == "argon2id"
        && document.kdf.version == "0x13"
        && document.kdf.memory_kib == ARGON2_MEMORY_KIB
        && document.kdf.iterations == ARGON2_ITERATIONS
        && document.kdf.parallelism == ARGON2_PARALLELISM
        && document.cipher.algorithm == "xchacha20-poly1305"
        && document.public_key.algorithm == "Ed25519"
        && document.public_key.encoding == "spki-der";
    if !valid {
        return Err(KeystoreError::InvalidContainer(
            "algorithm, parameters, or schema version differ from WAFC v1".to_owned(),
        ));
    }
    Ok(())
}

fn validate_binding(binding: &KeystoreBinding) -> Result<(), KeystoreError> {
    let valid_identifier = |value: &str| {
        (3..=120).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    };
    let fingerprint = binding
        .workstation_key_fingerprint_sha256
        .strip_prefix("sha256:")
        .unwrap_or_default();
    if !valid_identifier(&binding.operator_id)
        || !valid_identifier(&binding.key_id)
        || fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(KeystoreError::InvalidContainer(
            "encrypted operator/workstation binding is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn decode_fixed<const N: usize>(value: &str, field: &str) -> Result<[u8; N], KeystoreError> {
    let decoded = BASE64
        .decode(value)
        .map_err(|_| KeystoreError::InvalidContainer(format!("{field} is not valid base64")))?;
    decoded
        .try_into()
        .map_err(|_| KeystoreError::InvalidContainer(format!("{field} has the wrong byte length")))
}

#[cfg(any(test, feature = "provisioning"))]
fn atomic_create(path: &Path, bytes: &[u8]) -> Result<(), KeystoreError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            KeystoreError::InvalidContainer("invalid destination filename".to_owned())
        })?;
    let temporary = path.with_file_name(format!(".{file_name}.new"));
    if temporary.exists() {
        return Err(KeystoreError::AlreadyExists(temporary));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let write_result = (|| -> Result<(), std::io::Error> {
        file.write_all(bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    drop(file);
    if path.exists() {
        let _ = fs::remove_file(&temporary);
        return Err(KeystoreError::AlreadyExists(path.to_path_buf()));
    }
    fs::rename(&temporary, path)?;
    if let Some(parent) = path.parent()
        && let Ok(directory) = File::open(parent)
    {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        let mut random = [0_u8; 8];
        assert!(getrandom::fill(&mut random).is_ok());
        std::env::temp_dir().join(format!("wafc-{label}-{}.json", hex::encode(random)))
    }

    fn binding() -> KeystoreBinding {
        KeystoreBinding {
            operator_id: "operator_001".to_owned(),
            key_id: "operator-key-001".to_owned(),
            workstation_key_fingerprint_sha256: format!("sha256:{}", "a".repeat(64)),
        }
    }

    #[test]
    fn round_trip_and_wrong_password() {
        let path = temp_path("keystore-roundtrip");
        let passphrase = "Correct!HorseBatteryStaple1";
        let created = create(&path, passphrase, &binding());
        assert!(created.is_ok());
        let created = match created {
            Ok(value) => value,
            Err(error) => panic!("create failed: {error}"),
        };
        let unlocked = unlock(&path, passphrase);
        assert!(unlocked.is_ok());
        let unlocked = match unlocked {
            Ok(value) => value,
            Err(error) => panic!("unlock failed: {error}"),
        };
        assert_eq!(unlocked.binding, binding());
        let public = unlocked.signing_key.verifying_key().to_public_key_der();
        assert!(public.is_ok());
        let public = match public {
            Ok(value) => value,
            Err(error) => panic!("public key encoding failed: {error}"),
        };
        assert_eq!(
            created.public_key_fingerprint_sha256,
            format!("sha256:{}", hex::encode(Sha256::digest(public.as_bytes())))
        );
        assert!(matches!(
            unlock(&path, "wrong password is long enough"),
            Err(KeystoreError::UnlockFailed)
        ));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn refuses_overwrite() {
        let path = temp_path("keystore-overwrite");
        let first = create(&path, "A!sufficiently-long-passphrase1", &binding());
        assert!(first.is_ok());
        assert!(matches!(
            create(&path, "Another!sufficiently-long-passphrase1", &binding()),
            Err(KeystoreError::AlreadyExists(_))
        ));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_short_passphrase() {
        let path = temp_path("keystore-short");
        assert!(matches!(
            create(&path, "Aa!bcde", &binding()),
            Err(KeystoreError::InvalidPassphraseLength)
        ));
        assert!(!path.exists());
    }

    #[test]
    fn enforces_new_key_character_classes_without_rejecting_legacy_unlock_shape() {
        assert!(validate_new_passphrase("Aa!bcde1").is_ok());
        for value in ["aa!bcde1", "AA!BCDE1", "Aa1bcdef", "Aa!bcdef"] {
            assert!(matches!(
                validate_new_passphrase(value),
                Err(KeystoreError::WeakPassphrase)
            ));
        }
        assert!(validate_unlock_passphrase("legacy-passphrase").is_ok());
    }

    #[test]
    fn encrypted_binding_tamper_is_rejected() {
        let path = temp_path("keystore-binding");
        let passphrase = "A!sufficiently-long-passphrase1";
        assert!(create(&path, passphrase, &binding()).is_ok());
        let mut document: serde_json::Value = serde_json::from_slice(
            &fs::read(&path).unwrap_or_else(|error| panic!("read: {error}")),
        )
        .unwrap_or_else(|error| panic!("parse: {error}"));
        document["publicKey"]["fingerprintSha256"] = serde_json::Value::String("b".repeat(64));
        assert!(fs::write(&path, serde_json::to_vec(&document).unwrap_or_default()).is_ok());
        assert!(matches!(
            unlock(&path, passphrase),
            Err(KeystoreError::UnlockFailed)
        ));
        let _ = fs::remove_file(path);
    }
}
