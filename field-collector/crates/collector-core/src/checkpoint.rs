//! Authenticated, generation-based checkpoint storage outside the evidence bag.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;
use zeroize::{Zeroize, Zeroizing};

use crate::normalize::{NormalizationMode, NormalizerCheckpoint};
use page_bridge::{StreamEndPayload, StreamStartPayload};

const ENVELOPE_SCHEMA: &str = "wafc-acquisition-checkpoint-envelope/1";
const PLAINTEXT_SCHEMA: &str = "wafc-acquisition-checkpoint-plaintext/1";
const AAD_DOMAIN: &[u8] = b"WAFC-ACQUISITION-CHECKPOINT-v1\0";
const MAX_CHECKPOINT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHECKPOINT_FILES: usize = 4_096;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const MIN_PASSPHRASE_CHARACTERS: usize = 8;
const MAX_PASSPHRASE_BYTES: usize = 1_024;
const ARGON2_MEMORY_KIB: u32 = 65_536;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;
const RETAINED_GENERATIONS: usize = 2;
const MAX_STAGING_FILES: usize = 200_000;

#[derive(Debug, Error)]
pub(crate) enum CheckpointError {
    #[error("checkpoint passphrase is outside the accepted length range")]
    InvalidPassphrase,
    #[error("checkpoint directory is not a fixed real directory")]
    UnsafeDirectory,
    #[error("checkpoint generation already exists")]
    GenerationExists,
    #[error("checkpoint set is too large")]
    TooManyFiles,
    #[error("checkpoint is too large")]
    FileTooLarge,
    #[error("checkpoint envelope is invalid or unsupported")]
    InvalidEnvelope,
    #[error("checkpoint authentication failed")]
    AuthenticationFailed,
    #[error("checkpoint payload identity does not match its filename")]
    IdentityMismatch,
    #[error("checkpoint entropy source failed")]
    Random,
    #[error("checkpoint key derivation failed")]
    Kdf,
    #[error("checkpoint I/O failed at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("checkpoint JSON is invalid")]
    Json,
    #[error("checkpoint staging tree differs from the last committed generation")]
    StagingMismatch,
}

trait IoPath<T> {
    fn checkpoint_at(self, path: impl Into<PathBuf>) -> Result<T, CheckpointError>;
}

impl<T> IoPath<T> for std::io::Result<T> {
    fn checkpoint_at(self, path: impl Into<PathBuf>) -> Result<T, CheckpointError> {
        self.map_err(|source| CheckpointError::Io {
            path: path.into(),
            source,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: String,
    evidence_id: Uuid,
    generation: String,
    kdf: KdfEnvelope,
    cipher: CipherEnvelope,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KdfEnvelope {
    algorithm: String,
    version: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CipherEnvelope {
    algorithm: String,
    nonce_base64: String,
    ciphertext_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plaintext<T> {
    schema_version: String,
    evidence_id: Uuid,
    generation: String,
    payload: T,
}

pub(crate) struct CheckpointStore {
    directory: PathBuf,
    evidence_id: Uuid,
    salt: [u8; SALT_BYTES],
    key: Zeroizing<[u8; 32]>,
    next_generation: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct CheckpointCleanup {
    directory: PathBuf,
    evidence_id: Uuid,
}

pub(crate) struct LoadedCheckpoint<T> {
    pub(crate) store: CheckpointStore,
    pub(crate) generation: u64,
    pub(crate) payload: T,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CheckpointPhase {
    Initialized,
    StructuredComplete,
    MediaInProgress,
    StreamComplete,
    Cancelled,
    TransportInterrupted,
    FailedStaging,
    SealedPendingVerification,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CheckpointFile {
    pub(crate) path: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CheckpointSourceBinding {
    pub(crate) browser_family: String,
    pub(crate) browser_version: String,
    pub(crate) profile_reference_sha256: String,
    pub(crate) extension_version: String,
    pub(crate) adapter_id: String,
    pub(crate) adapter_version: String,
    pub(crate) adapter_sha256: String,
    pub(crate) injector_sha256: String,
    pub(crate) whatsapp_build: String,
    pub(crate) resume_challenge_hex: String,
    pub(crate) resume_binding_sha256: Option<String>,
    pub(crate) media_plan_sha256: Option<String>,
    pub(crate) media_start_index: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CurrentAssetCheckpoint {
    pub(crate) asset_id: String,
    pub(crate) received_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AcquisitionCheckpoint {
    pub(crate) schema_version: String,
    pub(crate) phase: CheckpointPhase,
    pub(crate) evidence_id: Uuid,
    pub(crate) acquisition_id: Uuid,
    pub(crate) source_id: Uuid,
    pub(crate) log_session_id: Uuid,
    pub(crate) created_at_utc: String,
    pub(crate) updated_at_utc: String,
    pub(crate) portable_bundle_id: Uuid,
    pub(crate) portable_manifest_sha256: String,
    pub(crate) assignment_id: String,
    pub(crate) assignment_sha256: String,
    pub(crate) operator_key_fingerprint_sha256: String,
    pub(crate) key_id: String,
    pub(crate) acquisition_mode: NormalizationMode,
    pub(crate) source_binding: CheckpointSourceBinding,
    pub(crate) snapshot_sha256: Option<String>,
    pub(crate) stream_start: Option<StreamStartPayload>,
    pub(crate) stream_end: Option<StreamEndPayload>,
    pub(crate) normalizer: Option<NormalizerCheckpoint>,
    pub(crate) completed_asset_ids: Vec<String>,
    pub(crate) remaining_asset_ids: Vec<String>,
    pub(crate) current_asset: Option<CurrentAssetCheckpoint>,
    pub(crate) total_media_bytes: u64,
    pub(crate) files: Vec<CheckpointFile>,
}

impl AcquisitionCheckpoint {
    pub(crate) fn validate(&self, evidence_id: Uuid) -> Result<(), CheckpointError> {
        let fingerprints = [
            self.portable_manifest_sha256.as_str(),
            self.assignment_sha256.as_str(),
            self.source_binding.profile_reference_sha256.as_str(),
            self.source_binding.adapter_sha256.as_str(),
            self.source_binding.injector_sha256.as_str(),
            self.source_binding.resume_challenge_hex.as_str(),
        ];
        let valid = self.schema_version == "wafc-acquisition-checkpoint/1"
            && self.evidence_id == evidence_id
            && fingerprints.into_iter().all(valid_hex_32)
            && valid_prefixed_fingerprint(&self.operator_key_fingerprint_sha256)
            && self
                .source_binding
                .resume_binding_sha256
                .as_deref()
                .is_none_or(valid_hex_32)
            && self
                .source_binding
                .media_plan_sha256
                .as_deref()
                .is_none_or(valid_hex_32)
            && usize::try_from(self.source_binding.media_start_index)
                .ok()
                .is_some_and(|index| index <= self.completed_asset_ids.len())
            && valid_identifier(&self.assignment_id)
            && valid_identifier(&self.key_id)
            && !self.source_binding.browser_family.is_empty()
            && !self.source_binding.adapter_id.is_empty()
            && !self.source_binding.adapter_version.is_empty()
            && !self.source_binding.extension_version.is_empty()
            && !self.source_binding.whatsapp_build.is_empty()
            && self.snapshot_sha256.as_deref().is_none_or(valid_hex_32)
            && sorted_unique_asset_ids(&self.completed_asset_ids)
            && sorted_unique_asset_ids(&self.remaining_asset_ids)
            && self
                .current_asset
                .as_ref()
                .is_none_or(|asset| valid_asset_id(&asset.asset_id))
            && valid_file_manifest(&self.files);
        if valid {
            Ok(())
        } else {
            Err(CheckpointError::IdentityMismatch)
        }
    }
}

impl CheckpointStore {
    pub(crate) fn create(
        directory: &Path,
        evidence_id: Uuid,
        passphrase: &str,
    ) -> Result<Self, CheckpointError> {
        validate_passphrase(passphrase)?;
        let directory = canonical_real_directory(directory)?;
        if latest_checkpoint_path(&directory, evidence_id)?.is_some() {
            return Err(CheckpointError::GenerationExists);
        }
        let mut salt = [0_u8; SALT_BYTES];
        getrandom::fill(&mut salt).map_err(|_| CheckpointError::Random)?;
        let key = derive_key(passphrase, &salt)?;
        Ok(Self {
            directory,
            evidence_id,
            salt,
            key,
            next_generation: 1,
        })
    }

    pub(crate) fn load_latest<T: DeserializeOwned>(
        directory: &Path,
        evidence_id: Uuid,
        passphrase: &str,
    ) -> Result<Option<LoadedCheckpoint<T>>, CheckpointError> {
        validate_passphrase(passphrase)?;
        let directory = canonical_real_directory(directory)?;
        let Some((path, generation)) = latest_checkpoint_path(&directory, evidence_id)? else {
            return Ok(None);
        };
        let envelope = read_envelope(&path)?;
        validate_envelope(&envelope, evidence_id, generation)?;
        let salt = decode_fixed::<SALT_BYTES>(&envelope.kdf.salt_base64)?;
        let key = derive_key(passphrase, &salt)?;
        let plaintext = decrypt::<T>(&envelope, &key, evidence_id, generation)?;
        Ok(Some(LoadedCheckpoint {
            store: Self {
                directory,
                evidence_id,
                salt,
                key,
                next_generation: generation
                    .checked_add(1)
                    .ok_or(CheckpointError::InvalidEnvelope)?,
            },
            generation,
            payload: plaintext.payload,
        }))
    }

    pub(crate) fn write<T: Serialize>(&mut self, payload: &T) -> Result<u64, CheckpointError> {
        let generation = self.next_generation;
        let final_path = checkpoint_path(&self.directory, self.evidence_id, generation);
        let temporary_path = final_path.with_extension("enc.new");
        if path_present(&final_path)? || path_present(&temporary_path)? {
            return Err(CheckpointError::GenerationExists);
        }

        let plaintext = Plaintext {
            schema_version: PLAINTEXT_SCHEMA.to_owned(),
            evidence_id: self.evidence_id,
            generation: generation_string(generation),
            payload,
        };
        let mut plaintext_bytes =
            Zeroizing::new(serde_json::to_vec(&plaintext).map_err(|_| CheckpointError::Json)?);
        let mut nonce = [0_u8; NONCE_BYTES];
        getrandom::fill(&mut nonce).map_err(|_| CheckpointError::Random)?;
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&*self.key));
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext_bytes,
                    aad: &aad(self.evidence_id, generation),
                },
            )
            .map_err(|_| CheckpointError::AuthenticationFailed)?;
        plaintext_bytes.zeroize();
        let envelope = Envelope {
            schema_version: ENVELOPE_SCHEMA.to_owned(),
            evidence_id: self.evidence_id,
            generation: generation_string(generation),
            kdf: KdfEnvelope {
                algorithm: "argon2id".to_owned(),
                version: "0x13".to_owned(),
                memory_kib: ARGON2_MEMORY_KIB,
                iterations: ARGON2_ITERATIONS,
                parallelism: ARGON2_PARALLELISM,
                salt_base64: BASE64.encode(self.salt),
            },
            cipher: CipherEnvelope {
                algorithm: "xchacha20-poly1305".to_owned(),
                nonce_base64: BASE64.encode(nonce),
                ciphertext_base64: BASE64.encode(ciphertext),
            },
        };
        let mut bytes = serde_json::to_vec(&envelope).map_err(|_| CheckpointError::Json)?;
        bytes.push(b'\n');
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_CHECKPOINT_BYTES {
            return Err(CheckpointError::FileTooLarge);
        }
        atomic_create(&temporary_path, &final_path, &bytes)?;
        self.next_generation = generation
            .checked_add(1)
            .ok_or(CheckpointError::InvalidEnvelope)?;
        self.prune_old_generations();
        Ok(generation)
    }

    pub(crate) fn cleanup_handle(&self) -> CheckpointCleanup {
        CheckpointCleanup {
            directory: self.directory.clone(),
            evidence_id: self.evidence_id,
        }
    }

    fn prune_old_generations(&self) {
        let Ok(paths) = checkpoint_paths(&self.directory, self.evidence_id) else {
            return;
        };
        let remove_count = paths.len().saturating_sub(RETAINED_GENERATIONS);
        for (path, _) in paths.into_iter().take(remove_count) {
            let _ = fs::remove_file(path);
        }
        sync_directory(&self.directory);
    }
}

impl CheckpointCleanup {
    pub(crate) fn remove_all(self) -> Result<(), CheckpointError> {
        for (path, _) in checkpoint_paths(&self.directory, self.evidence_id)? {
            fs::remove_file(&path).checkpoint_at(&path)?;
        }
        sync_directory(&self.directory);
        Ok(())
    }
}

pub(crate) fn checkpoint_evidence_ids(directory: &Path) -> Result<Vec<Uuid>, CheckpointError> {
    let directory = canonical_real_directory(directory)?;
    let mut ids = Vec::new();
    let entries = fs::read_dir(&directory)
        .checkpoint_at(&directory)?
        .collect::<Result<Vec<_>, _>>()
        .checkpoint_at(&directory)?;
    if entries.len() > MAX_CHECKPOINT_FILES {
        return Err(CheckpointError::TooManyFiles);
    }
    for entry in entries {
        let metadata = entry.metadata().checkpoint_at(entry.path())?;
        if is_reparse_or_symlink(&metadata) {
            return Err(CheckpointError::UnsafeDirectory);
        }
        if !metadata.is_file() {
            continue;
        }
        if let Some((evidence_id, _)) = parse_checkpoint_name(&entry.file_name()) {
            ids.push(evidence_id);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

pub(crate) fn capture_staging_manifest(
    staging_dir: &Path,
) -> Result<Vec<CheckpointFile>, CheckpointError> {
    let staging_dir = canonical_real_directory(staging_dir)?;
    let mut files = Vec::new();
    let walker = WalkDir::new(&staging_dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".incoming");
    for entry in walker {
        let entry = entry.map_err(|_| CheckpointError::StagingMismatch)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| CheckpointError::StagingMismatch)?;
        if is_reparse_or_symlink(&metadata) || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(CheckpointError::StagingMismatch);
        }
        if !metadata.is_file() {
            continue;
        }
        let path = package_path(&staging_dir, entry.path())?;
        files.push(CheckpointFile {
            path,
            byte_length: metadata.len(),
            sha256: hash_file_prefix(entry.path(), metadata.len())?,
        });
        if files.len() > MAX_STAGING_FILES {
            return Err(CheckpointError::TooManyFiles);
        }
    }
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    if valid_file_manifest(&files) {
        Ok(files)
    } else {
        Err(CheckpointError::StagingMismatch)
    }
}

pub(crate) fn restore_staging_manifest(
    staging_dir: &Path,
    manifest: &[CheckpointFile],
) -> Result<(), CheckpointError> {
    if !valid_file_manifest(manifest) {
        return Err(CheckpointError::StagingMismatch);
    }
    let staging_dir = canonical_real_directory(staging_dir)?;
    let expected = manifest
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut observed = BTreeSet::new();
    let mut uncommitted_cas = Vec::new();
    let incoming = staging_dir.join(".incoming");

    for entry in WalkDir::new(&staging_dir).follow_links(false) {
        let entry = entry.map_err(|_| CheckpointError::StagingMismatch)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| CheckpointError::StagingMismatch)?;
        if is_reparse_or_symlink(&metadata) || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(CheckpointError::StagingMismatch);
        }
        if entry.path() == staging_dir || entry.path().starts_with(&incoming) || !metadata.is_file()
        {
            continue;
        }
        let path = package_path(&staging_dir, entry.path())?;
        if let Some(file) = expected.get(path.as_str()) {
            if metadata.len() < file.byte_length
                || (metadata.len() > file.byte_length && !mutable_resume_path(&path))
                || hash_file_prefix(entry.path(), file.byte_length)? != file.sha256
            {
                return Err(CheckpointError::StagingMismatch);
            }
            if metadata.len() > file.byte_length {
                let handle = OpenOptions::new()
                    .write(true)
                    .open(entry.path())
                    .checkpoint_at(entry.path())?;
                handle
                    .set_len(file.byte_length)
                    .checkpoint_at(entry.path())?;
                handle.sync_all().checkpoint_at(entry.path())?;
            }
            observed.insert(path);
        } else if valid_cas_path(&path) {
            uncommitted_cas.push(entry.path().to_path_buf());
        } else {
            return Err(CheckpointError::StagingMismatch);
        }
    }
    if observed.len() != expected.len() {
        return Err(CheckpointError::StagingMismatch);
    }
    validate_incoming_tree(&incoming)?;
    for path in uncommitted_cas {
        fs::remove_file(&path).checkpoint_at(&path)?;
    }
    if incoming.exists() {
        fs::remove_dir_all(&incoming).checkpoint_at(&incoming)?;
    }
    sync_directory(&staging_dir);
    Ok(())
}

fn decrypt<T: DeserializeOwned>(
    envelope: &Envelope,
    key: &[u8; 32],
    evidence_id: Uuid,
    generation: u64,
) -> Result<Plaintext<T>, CheckpointError> {
    let nonce = decode_fixed::<NONCE_BYTES>(&envelope.cipher.nonce_base64)?;
    let ciphertext = BASE64
        .decode(&envelope.cipher.ciphertext_base64)
        .map_err(|_| CheckpointError::InvalidEnvelope)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad(evidence_id, generation),
            },
        )
        .map_err(|_| CheckpointError::AuthenticationFailed)?;
    let mut plaintext = Zeroizing::new(plaintext);
    let parsed: Plaintext<T> =
        serde_json::from_slice(&plaintext).map_err(|_| CheckpointError::AuthenticationFailed)?;
    plaintext.zeroize();
    if parsed.schema_version != PLAINTEXT_SCHEMA
        || parsed.evidence_id != evidence_id
        || parsed.generation != generation_string(generation)
    {
        return Err(CheckpointError::IdentityMismatch);
    }
    Ok(parsed)
}

fn validate_envelope(
    envelope: &Envelope,
    evidence_id: Uuid,
    generation: u64,
) -> Result<(), CheckpointError> {
    let valid = envelope.schema_version == ENVELOPE_SCHEMA
        && envelope.evidence_id == evidence_id
        && envelope.generation == generation_string(generation)
        && envelope.kdf.algorithm == "argon2id"
        && envelope.kdf.version == "0x13"
        && envelope.kdf.memory_kib == ARGON2_MEMORY_KIB
        && envelope.kdf.iterations == ARGON2_ITERATIONS
        && envelope.kdf.parallelism == ARGON2_PARALLELISM
        && envelope.cipher.algorithm == "xchacha20-poly1305";
    if valid {
        Ok(())
    } else {
        Err(CheckpointError::InvalidEnvelope)
    }
}

fn read_envelope(path: &Path) -> Result<Envelope, CheckpointError> {
    let metadata = fs::symlink_metadata(path).checkpoint_at(path)?;
    if is_reparse_or_symlink(&metadata) || !metadata.is_file() {
        return Err(CheckpointError::UnsafeDirectory);
    }
    if metadata.len() > MAX_CHECKPOINT_BYTES {
        return Err(CheckpointError::FileTooLarge);
    }
    let mut file = File::open(path).checkpoint_at(path)?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.read_to_end(&mut bytes).checkpoint_at(path)?;
    serde_json::from_slice(&bytes).map_err(|_| CheckpointError::Json)
}

fn atomic_create(temporary: &Path, final_path: &Path, bytes: &[u8]) -> Result<(), CheckpointError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .checkpoint_at(temporary)?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(source) = result {
        drop(file);
        let _ = fs::remove_file(temporary);
        return Err(CheckpointError::Io {
            path: temporary.to_path_buf(),
            source,
        });
    }
    drop(file);
    fs::rename(temporary, final_path).checkpoint_at(temporary)?;
    sync_directory(final_path.parent().unwrap_or_else(|| Path::new(".")));
    Ok(())
}

fn derive_key(
    passphrase: &str,
    salt: &[u8; SALT_BYTES],
) -> Result<Zeroizing<[u8; 32]>, CheckpointError> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(32),
    )
    .map_err(|_| CheckpointError::Kdf)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut *output)
        .map_err(|_| CheckpointError::Kdf)?;
    Ok(output)
}

fn validate_passphrase(passphrase: &str) -> Result<(), CheckpointError> {
    if passphrase.chars().count() >= MIN_PASSPHRASE_CHARACTERS
        && passphrase.len() <= MAX_PASSPHRASE_BYTES
    {
        Ok(())
    } else {
        Err(CheckpointError::InvalidPassphrase)
    }
}

fn aad(evidence_id: Uuid, generation: u64) -> Vec<u8> {
    let mut value = Vec::with_capacity(AAD_DOMAIN.len() + 16 + 8);
    value.extend_from_slice(AAD_DOMAIN);
    value.extend_from_slice(evidence_id.as_bytes());
    value.extend_from_slice(&generation.to_be_bytes());
    value
}

fn generation_string(generation: u64) -> String {
    generation.to_string()
}

fn checkpoint_path(directory: &Path, evidence_id: Uuid, generation: u64) -> PathBuf {
    directory.join(format!(
        "waeb-{evidence_id}.checkpoint-{generation:020}.enc"
    ))
}

fn checkpoint_paths(
    directory: &Path,
    evidence_id: Uuid,
) -> Result<Vec<(PathBuf, u64)>, CheckpointError> {
    let entries = fs::read_dir(directory)
        .checkpoint_at(directory)?
        .collect::<Result<Vec<_>, _>>()
        .checkpoint_at(directory)?;
    if entries.len() > MAX_CHECKPOINT_FILES {
        return Err(CheckpointError::TooManyFiles);
    }
    let mut paths = Vec::new();
    for entry in entries {
        let metadata = entry.metadata().checkpoint_at(entry.path())?;
        if is_reparse_or_symlink(&metadata) {
            return Err(CheckpointError::UnsafeDirectory);
        }
        if !metadata.is_file() {
            continue;
        }
        if let Some((parsed_id, generation)) = parse_checkpoint_name(&entry.file_name())
            && parsed_id == evidence_id
        {
            paths.push((entry.path(), generation));
        }
    }
    paths.sort_by_key(|(_, generation)| *generation);
    Ok(paths)
}

fn latest_checkpoint_path(
    directory: &Path,
    evidence_id: Uuid,
) -> Result<Option<(PathBuf, u64)>, CheckpointError> {
    Ok(checkpoint_paths(directory, evidence_id)?.pop())
}

fn parse_checkpoint_name(name: &std::ffi::OsStr) -> Option<(Uuid, u64)> {
    let name = name.to_str()?;
    let body = name.strip_prefix("waeb-")?.strip_suffix(".enc")?;
    let (id, generation) = body.split_once(".checkpoint-")?;
    if generation.len() != 20 || !generation.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((Uuid::parse_str(id).ok()?, generation.parse().ok()?))
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], CheckpointError> {
    BASE64
        .decode(value)
        .map_err(|_| CheckpointError::InvalidEnvelope)?
        .try_into()
        .map_err(|_| CheckpointError::InvalidEnvelope)
}

fn path_present(path: &Path) -> Result<bool, CheckpointError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(CheckpointError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn canonical_real_directory(path: &Path) -> Result<PathBuf, CheckpointError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| CheckpointError::UnsafeDirectory)?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(CheckpointError::UnsafeDirectory);
    }
    let canonical = fs::canonicalize(path).map_err(|_| CheckpointError::UnsafeDirectory)?;
    let canonical_metadata =
        fs::symlink_metadata(&canonical).map_err(|_| CheckpointError::UnsafeDirectory)?;
    if !canonical_metadata.is_dir() || is_reparse_or_symlink(&canonical_metadata) {
        return Err(CheckpointError::UnsafeDirectory);
    }
    Ok(canonical)
}

fn valid_hex_32(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_prefixed_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(valid_hex_32)
}

fn valid_identifier(value: &str) -> bool {
    (3..=160).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn valid_asset_id(value: &str) -> bool {
    value.strip_prefix("ast_").is_some_and(valid_hex_32)
}

fn sorted_unique_asset_ids(values: &[String]) -> bool {
    values.iter().all(|value| valid_asset_id(value))
        && values
            .windows(2)
            .all(|pair| pair[0].as_bytes() < pair[1].as_bytes())
}

fn valid_file_manifest(files: &[CheckpointFile]) -> bool {
    files.len() <= MAX_STAGING_FILES
        && files
            .iter()
            .all(|file| valid_package_path(&file.path) && valid_hex_32(&file.sha256))
        && files
            .windows(2)
            .all(|pair| pair[0].path.as_bytes() < pair[1].path.as_bytes())
}

fn valid_package_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1_024
        && !path.contains('\\')
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn package_path(root: &Path, path: &Path) -> Result<String, CheckpointError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| CheckpointError::StagingMismatch)?;
    let value = relative
        .to_str()
        .ok_or(CheckpointError::StagingMismatch)?
        .replace('\\', "/");
    if valid_package_path(&value) {
        Ok(value)
    } else {
        Err(CheckpointError::StagingMismatch)
    }
}

fn mutable_resume_path(path: &str) -> bool {
    matches!(
        path,
        "data/logs/acquisition.ndjson" | "data/indexes/media.ndjson"
    )
}

fn valid_cas_path(path: &str) -> bool {
    let Some(value) = path.strip_prefix("data/media/sha256/") else {
        return false;
    };
    let Some((shard, digest)) = value.split_once('/') else {
        return false;
    };
    shard.len() == 2 && valid_hex_32(digest) && digest.starts_with(shard)
}

fn hash_file_prefix(path: &Path, byte_length: u64) -> Result<String, CheckpointError> {
    let mut file = File::open(path).checkpoint_at(path)?;
    let mut hasher = Sha256::new();
    let mut remaining = byte_length;
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    while remaining > 0 {
        let requested = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| CheckpointError::StagingMismatch)?;
        let count = file.read(&mut buffer[..requested]).checkpoint_at(path)?;
        if count == 0 {
            return Err(CheckpointError::StagingMismatch);
        }
        hasher.update(&buffer[..count]);
        remaining = remaining
            .checked_sub(u64::try_from(count).map_err(|_| CheckpointError::StagingMismatch)?)
            .ok_or(CheckpointError::StagingMismatch)?;
    }
    Ok(hex::encode(hasher.finalize()))
}

fn validate_incoming_tree(incoming: &Path) -> Result<(), CheckpointError> {
    if !incoming.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(incoming).checkpoint_at(incoming)?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(CheckpointError::StagingMismatch);
    }
    for entry in WalkDir::new(incoming).follow_links(false) {
        let entry = entry.map_err(|_| CheckpointError::StagingMismatch)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| CheckpointError::StagingMismatch)?;
        if is_reparse_or_symlink(&metadata) || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(CheckpointError::StagingMismatch);
        }
        if metadata.is_file()
            && entry.path().extension().and_then(|value| value.to_str()) != Some("partial")
        {
            return Err(CheckpointError::StagingMismatch);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_or_symlink(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_or_symlink(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn sync_directory(directory: &Path) {
    if let Ok(file) = File::open(directory) {
        let _ = file.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("wafc-checkpoint-{label}-{}", Uuid::new_v4()));
            assert!(fs::create_dir(&path).is_ok());
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn generations_round_trip_and_keep_only_the_latest_two() {
        let directory = TempDirectory::new("roundtrip");
        let evidence_id = Uuid::new_v4();
        let passphrase = "correct horse battery staple";
        let mut store = CheckpointStore::create(&directory.0, evidence_id, passphrase)
            .unwrap_or_else(|error| panic!("create: {error}"));
        for value in 1..=3 {
            assert!(matches!(store.write(&json!({"value": value})), Ok(actual) if actual == value));
        }
        let paths = checkpoint_paths(&directory.0, evidence_id)
            .unwrap_or_else(|error| panic!("paths: {error}"));
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].1, 2);
        assert_eq!(paths[1].1, 3);

        let loaded = CheckpointStore::load_latest::<Value>(&directory.0, evidence_id, passphrase)
            .unwrap_or_else(|error| panic!("load: {error}"))
            .unwrap_or_else(|| panic!("missing checkpoint"));
        assert_eq!(loaded.generation, 3);
        assert_eq!(loaded.payload, json!({"value": 3}));
    }

    #[test]
    fn wrong_passphrase_and_one_byte_tamper_fail_authentication() {
        let directory = TempDirectory::new("tamper");
        let evidence_id = Uuid::new_v4();
        let passphrase = "correct horse battery staple";
        let mut store = CheckpointStore::create(&directory.0, evidence_id, passphrase)
            .unwrap_or_else(|error| panic!("create: {error}"));
        assert!(matches!(
            store.write(&json!({"secret": "native-id"})),
            Ok(1)
        ));
        assert!(matches!(
            CheckpointStore::load_latest::<Value>(
                &directory.0,
                evidence_id,
                "wrong password but long enough"
            ),
            Err(CheckpointError::AuthenticationFailed)
        ));

        let path = checkpoint_path(&directory.0, evidence_id, 1);
        let mut bytes = fs::read(&path).unwrap_or_else(|error| panic!("read: {error}"));
        let index = bytes.len() / 2;
        bytes[index] ^= 1;
        assert!(fs::write(&path, bytes).is_ok());
        assert!(
            CheckpointStore::load_latest::<Value>(&directory.0, evidence_id, passphrase).is_err()
        );
    }

    #[test]
    fn discovery_exposes_only_evidence_ids_and_remove_all_is_exact() {
        let directory = TempDirectory::new("discover");
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        for evidence_id in [first, second] {
            let mut store =
                CheckpointStore::create(&directory.0, evidence_id, "correct horse battery staple")
                    .unwrap_or_else(|error| panic!("create: {error}"));
            assert!(
                store
                    .write(&json!({"phase": "structured_complete"}))
                    .is_ok()
            );
        }
        let unrelated = directory.0.join("unrelated.txt");
        assert!(fs::write(&unrelated, b"keep").is_ok());
        let ids = checkpoint_evidence_ids(&directory.0)
            .unwrap_or_else(|error| panic!("discover: {error}"));
        assert_eq!(ids.len(), 2);
        let loaded = CheckpointStore::load_latest::<Value>(
            &directory.0,
            first,
            "correct horse battery staple",
        )
        .unwrap_or_else(|error| panic!("load: {error}"))
        .unwrap_or_else(|| panic!("missing"));
        assert!(loaded.store.cleanup_handle().remove_all().is_ok());
        assert!(unrelated.exists());
        assert_eq!(
            checkpoint_evidence_ids(&directory.0).unwrap_or_default(),
            vec![second]
        );
    }

    #[test]
    fn staging_restore_truncates_append_only_files_and_removes_only_uncommitted_media() {
        let directory = TempDirectory::new("manifest-rollback");
        let staging = directory.0.join("waeb-test");
        let log = staging.join("data/logs/acquisition.ndjson");
        let index = staging.join("data/indexes/media.ndjson");
        let committed_digest = "ab".repeat(32);
        let committed = staging.join(format!(
            "data/media/sha256/{}/{}",
            &committed_digest[..2],
            committed_digest
        ));
        for path in [&log, &index, &committed] {
            assert!(fs::create_dir_all(path.parent().unwrap_or(&staging)).is_ok());
        }
        assert!(fs::write(&log, b"first\n").is_ok());
        assert!(fs::write(&index, b"index\n").is_ok());
        assert!(fs::write(&committed, b"committed").is_ok());
        let manifest =
            capture_staging_manifest(&staging).unwrap_or_else(|error| panic!("capture: {error}"));

        assert!(
            OpenOptions::new()
                .append(true)
                .open(&log)
                .and_then(|mut file| file.write_all(b"after-checkpoint\n"))
                .is_ok()
        );
        assert!(
            OpenOptions::new()
                .append(true)
                .open(&index)
                .and_then(|mut file| file.write_all(b"after-checkpoint\n"))
                .is_ok()
        );
        let uncommitted_digest = "cd".repeat(32);
        let uncommitted = staging.join(format!(
            "data/media/sha256/{}/{}",
            &uncommitted_digest[..2],
            uncommitted_digest
        ));
        assert!(fs::create_dir_all(uncommitted.parent().unwrap_or(&staging)).is_ok());
        assert!(fs::write(&uncommitted, b"uncommitted").is_ok());
        let incoming = staging.join(".incoming/one.partial");
        assert!(fs::create_dir_all(incoming.parent().unwrap_or(&staging)).is_ok());
        assert!(fs::write(&incoming, b"partial bytes").is_ok());

        assert!(restore_staging_manifest(&staging, &manifest).is_ok());
        assert_eq!(fs::read(&log).unwrap_or_default(), b"first\n");
        assert_eq!(fs::read(&index).unwrap_or_default(), b"index\n");
        assert!(committed.exists());
        assert!(!uncommitted.exists());
        assert!(!incoming.parent().unwrap_or(&staging).exists());
    }

    #[test]
    fn staging_restore_rejects_tampered_committed_prefix() {
        let directory = TempDirectory::new("manifest-tamper");
        let staging = directory.0.join("waeb-test");
        let log = staging.join("data/logs/acquisition.ndjson");
        assert!(fs::create_dir_all(log.parent().unwrap_or(&staging)).is_ok());
        assert!(fs::write(&log, b"first\n").is_ok());
        let manifest =
            capture_staging_manifest(&staging).unwrap_or_else(|error| panic!("capture: {error}"));
        assert!(fs::write(&log, b"other\nextra\n").is_ok());
        assert!(matches!(
            restore_staging_manifest(&staging, &manifest),
            Err(CheckpointError::StagingMismatch)
        ));
    }
}
