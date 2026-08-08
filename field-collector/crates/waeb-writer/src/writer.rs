#![allow(missing_docs)]
#![allow(clippy::missing_errors_doc, clippy::struct_excessive_bools)]

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256, Sha512};
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    AcquisitionDto, CAPABILITY_NAMES, CapabilitiesDto, CompletenessDto, DATASETS,
    DatasetCapability, DatasetDisposition, DatasetInventoryDto, DatasetInventoryItemDto,
    DatasetResult, EMBEDDED_SCHEMAS, LogEventType, ObservationWindowDto, RawPhase, RawProvider,
    RawStream, RequestState, SCHEMA_VERSION, WAEB_VERSION,
    jcs::{canonicalize_evidence, canonicalize_evidence_line},
    sha256_hex,
};

const LOG_DOMAIN: &[u8] = b"WAEB-LOG-v1\0";
const LOG_PATH: &str = "data/logs/acquisition.ndjson";
const CHAT_COMPLETENESS_PATH: &str = "data/completeness/chats.ndjson";
const MEDIA_INDEX_PATH: &str = "data/indexes/media.ndjson";

/// Errors returned by the fail-closed writer.
#[derive(Debug, Error)]
pub enum WaebError {
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("JSON serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsafe or non-interoperable JSON number: {0}")]
    UnsafeJsonNumber(String),
    #[error("staging directory already exists: {0}")]
    StagingExists(PathBuf),
    #[error("final evidence bag already exists: {0}")]
    FinalExists(PathBuf),
    #[error("symlink/reparse-style filesystem entry is forbidden: {0}")]
    SymlinkForbidden(PathBuf),
    #[error("unsupported filesystem entry: {0}")]
    UnsupportedEntry(PathBuf),
    #[error("unknown normalized dataset: {0}")]
    UnknownDataset(String),
    #[error("record envelope for {dataset} has recordType {actual:?}, expected {expected}")]
    RecordTypeMismatch {
        dataset: String,
        actual: Option<String>,
        expected: String,
    },
    #[error("invalid {field}: {reason}")]
    InvalidMetadata { field: &'static str, reason: String },
    #[error("required payload metadata has not been written: {0}")]
    MissingPayload(&'static str),
    #[error("payload is finalized after dataset inventory is written")]
    PayloadFinalized,
    #[error("dataset dispositions must contain exactly 18 ordered items")]
    InvalidDatasetDispositions,
    #[error("capabilities must contain exactly the fixed 19 ordered names")]
    InvalidCapabilities,
    #[error("acquisition log must contain at least one event")]
    EmptyLog,
    #[error("media stream has already been committed")]
    MediaAlreadyCommitted,
    #[error("existing CAS object does not match its digest: {0}")]
    CasCollision(PathBuf),
    #[error("manifest path cannot be represented as a safe UTF-8 package path: {0}")]
    UnsafeManifestPath(PathBuf),
    #[error("cryptographic operation failed: {0}")]
    Crypto(String),
}

trait IoPath<T> {
    fn at(self, path: impl Into<PathBuf>) -> Result<T, WaebError>;
}

impl<T> IoPath<T> for std::io::Result<T> {
    fn at(self, path: impl Into<PathBuf>) -> Result<T, WaebError> {
        self.map_err(|source| WaebError::Io {
            path: path.into(),
            source,
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct DatasetStats {
    records: u64,
    bytes: u64,
}

/// Current append-only acquisition-log state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogChainState {
    /// Number of events written.
    pub event_count: u64,
    /// Terminal event hash, absent before the first event.
    pub terminal_event_hash: Option<String>,
}

/// Result of committing one streamed media object into CAS.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaAsset {
    /// Package-relative content-addressed path.
    pub relative_path: String,
    /// Lowercase SHA-256 content digest.
    pub sha256: String,
    /// Lowercase SHA-512 content digest.
    pub sha512: String,
    /// Total byte length.
    pub byte_length: u64,
    /// Whether an identical object was already present.
    pub deduplicated: bool,
}

/// Metadata needed to construct `BagIt` tags and the required signature.
#[derive(Clone, Debug)]
pub struct SealOptions {
    /// RFC 3339 timestamp written into `seal.json`.
    pub created_at_utc: String,
    /// `YYYY-MM-DD` date used by `BagIt`.
    pub bagging_date: String,
    /// Human-readable collector agent and version.
    pub software_agent: String,
    /// Source organization label for the hand-off.
    pub source_organization: String,
    /// Public key identifier; no private material is accepted here.
    pub key_id: String,
    /// Marks fixture-only keys. Production callers should pass `false`.
    pub synthetic_key: bool,
}

/// A successfully signed evidence bag that is still held below a `.partial`
/// staging wrapper until an independent verifier accepts it.
#[derive(Debug)]
pub struct SealedBag {
    /// Verifiable package directory. Its own leaf is `waeb-<evidence-id>`,
    /// while its parent is the explicit `.partial` staging wrapper.
    pub path: PathBuf,
    /// Evidence identifier.
    pub evidence_id: Uuid,
    /// SHA-256 root binding the manifests and core tags.
    pub manifest_root_sha256: String,
    /// `sha256:` fingerprint of the included DER-SPKI public key.
    pub signer_fingerprint: String,
    staging_base: PathBuf,
    final_base: PathBuf,
    staging_root: PathBuf,
    final_dir: PathBuf,
}

/// A sealed bag promoted to its formal hand-off name after independent
/// verification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromotedBag {
    /// Final `waeb-<evidence-id>` directory below the original output root.
    pub path: PathBuf,
    /// Evidence identifier bound into the directory and signed seal.
    pub evidence_id: Uuid,
}

/// Streaming WAEB v1 staging writer.
pub struct WaebWriter {
    staging_base: PathBuf,
    final_base: PathBuf,
    staging_root: PathBuf,
    staging_dir: PathBuf,
    final_dir: PathBuf,
    evidence_id: Uuid,
    source_id: Option<Uuid>,
    dataset_stats: [DatasetStats; 18],
    log_state: LogChainState,
    acquisition_written: bool,
    inventory_written: bool,
    completeness_written: bool,
    capabilities_written: bool,
}

impl WaebWriter {
    /// Creates an exclusive `.partial` wrapper and exact-name bag directory
    /// under an existing, non-symlink base.
    pub fn create(base_dir: impl AsRef<Path>, evidence_id: Uuid) -> Result<Self, WaebError> {
        let base = base_dir.as_ref();
        Self::create_with_roots(base, base, evidence_id)
    }

    /// Creates staging below one fixed directory and promotes verified bags to
    /// a second fixed directory on the same filesystem.
    ///
    /// This supports the portable layout `evidence/staging` →
    /// `evidence/sealed`. Both roots must already exist as real non-reparse
    /// directories; neither can be supplied by page data.
    ///
    /// # Errors
    ///
    /// Returns an error for unsafe roots, an existing staging/final identity,
    /// or an I/O failure. A cross-volume promotion later fails closed because
    /// the implementation uses only an atomic rename.
    pub fn create_with_roots(
        staging_base: impl AsRef<Path>,
        final_base: impl AsRef<Path>,
        evidence_id: Uuid,
    ) -> Result<Self, WaebError> {
        let staging_base = canonical_real_directory(staging_base.as_ref(), "stagingBase")?;
        let final_base = canonical_real_directory(final_base.as_ref(), "finalBase")?;

        let leaf = format!("waeb-{evidence_id}");
        let staging_root = staging_base.join(format!("{leaf}.partial"));
        let staging_dir = staging_root.join(&leaf);
        let final_dir = final_base.join(leaf);
        if path_is_present(&final_dir)? {
            return Err(WaebError::FinalExists(final_dir));
        }
        match fs::create_dir(&staging_root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(WaebError::StagingExists(staging_root));
            }
            Err(source) => {
                return Err(WaebError::Io {
                    path: staging_root,
                    source,
                });
            }
        }
        if let Err(source) = fs::create_dir(&staging_dir) {
            let _ = fs::remove_dir(&staging_root);
            return Err(WaebError::Io {
                path: staging_dir,
                source,
            });
        }

        let mut writer = Self {
            staging_base,
            final_base,
            staging_root,
            staging_dir,
            final_dir,
            evidence_id,
            source_id: None,
            dataset_stats: [DatasetStats::default(); 18],
            log_state: LogChainState {
                event_count: 0,
                terminal_event_hash: None,
            },
            acquisition_written: false,
            inventory_written: false,
            completeness_written: false,
            capabilities_written: false,
        };
        writer.initialize_payload()?;
        Ok(writer)
    }

    /// Returns the current staging directory.
    #[must_use]
    pub fn staging_path(&self) -> &Path {
        &self.staging_dir
    }

    /// Returns the evidence identifier bound into the directory name and seal.
    #[must_use]
    pub const fn evidence_id(&self) -> Uuid {
        self.evidence_id
    }

    /// Appends one canonical NDJSON record to a fixed normalized dataset.
    pub fn append_normalized(
        &mut self,
        dataset_name: &str,
        record: &Value,
    ) -> Result<(), WaebError> {
        self.ensure_payload_open()?;
        let index = DATASETS
            .iter()
            .position(|item| item.name == dataset_name)
            .ok_or_else(|| WaebError::UnknownDataset(dataset_name.to_owned()))?;
        let actual = record
            .get("recordType")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if actual.as_deref() != Some(DATASETS[index].record_type) {
            return Err(WaebError::RecordTypeMismatch {
                dataset: dataset_name.to_owned(),
                actual,
                expected: DATASETS[index].record_type.to_owned(),
            });
        }
        let bytes = canonicalize_evidence_line(record)?;
        append_bytes(&self.staging_dir.join(DATASETS[index].path), &bytes)?;
        self.dataset_stats[index].records += 1;
        self.dataset_stats[index].bytes +=
            u64::try_from(bytes.len()).map_err(|error| WaebError::InvalidMetadata {
                field: "record length",
                reason: error.to_string(),
            })?;
        Ok(())
    }

    /// Appends one canonical NDJSON object to a path selected exclusively by enums.
    pub fn append_raw(
        &mut self,
        phase: RawPhase,
        provider: RawProvider,
        stream: RawStream,
        record: &Value,
    ) -> Result<(), WaebError> {
        self.ensure_payload_open()?;
        let relative = format!(
            "data/raw/{}/{}/{}",
            phase.path(),
            provider.path(),
            stream.path()
        );
        let bytes = canonicalize_evidence_line(record)?;
        append_bytes_create(&self.staging_dir.join(relative), &bytes)
    }

    /// Appends one chat completeness record.
    pub fn append_chat_completeness(&mut self, record: &Value) -> Result<(), WaebError> {
        self.ensure_payload_open()?;
        let bytes = canonicalize_evidence_line(record)?;
        append_bytes(&self.staging_dir.join(CHAT_COMPLETENESS_PATH), &bytes)
    }

    /// Appends one media index record. CAS bytes must be committed separately.
    pub fn append_media_index(&mut self, record: &Value) -> Result<(), WaebError> {
        self.ensure_payload_open()?;
        let bytes = canonicalize_evidence_line(record)?;
        append_bytes(&self.staging_dir.join(MEDIA_INDEX_PATH), &bytes)
    }

    /// Starts a media stream in a private incoming directory.
    pub fn start_media(&mut self) -> Result<MediaStream<'_>, WaebError> {
        self.ensure_payload_open()?;
        let incoming = self.staging_dir.join(".incoming");
        create_dir_checked(&incoming)?;
        let temp_path = incoming.join(format!("{}.partial", Uuid::new_v4()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .at(&temp_path)?;
        Ok(MediaStream {
            writer: self,
            file: Some(file),
            temp_path,
            sha256: Sha256::new(),
            sha512: Sha512::new(),
            byte_length: 0,
        })
    }

    /// Appends one hash-chained log event and returns its digest.
    pub fn append_log_event(
        &mut self,
        session_id: Uuid,
        wall_clock_utc: &str,
        monotonic_offset_ns: u64,
        event_type: LogEventType,
        summary: &Value,
    ) -> Result<String, WaebError> {
        self.ensure_payload_open()?;
        validate_timestamp(wall_clock_utc, "wallClockUtc")?;
        validate_summary(summary)?;
        let sequence = self.log_state.event_count + 1;
        let previous = self.log_state.terminal_event_hash.clone();
        let without_hash = json!({
            "schemaVersion": SCHEMA_VERSION,
            "sequence": sequence.to_string(),
            "sessionId": session_id,
            "wallClockUtc": wall_clock_utc,
            "monotonicOffsetNs": monotonic_offset_ns.to_string(),
            "previousEventHash": previous,
            "event": {"type": event_type, "summary": summary}
        });
        let canonical = canonicalize_evidence(&without_hash)?;
        let mut hasher = Sha256::new();
        hasher.update(LOG_DOMAIN);
        match &self.log_state.terminal_event_hash {
            Some(hash) => {
                let bytes =
                    hex::decode(hash).map_err(|error| WaebError::Crypto(error.to_string()))?;
                hasher.update(bytes);
            }
            None => hasher.update([0_u8; 32]),
        }
        hasher.update(canonical);
        let event_hash = hex::encode(hasher.finalize());
        let mut complete = without_hash;
        complete
            .as_object_mut()
            .ok_or_else(|| WaebError::InvalidMetadata {
                field: "log event",
                reason: "internal event must be an object".to_owned(),
            })?
            .insert("eventHash".to_owned(), Value::String(event_hash.clone()));
        append_bytes(
            &self.staging_dir.join(LOG_PATH),
            &canonicalize_evidence_line(&complete)?,
        )?;
        self.log_state.event_count = sequence;
        self.log_state.terminal_event_hash = Some(event_hash.clone());
        Ok(event_hash)
    }

    /// Returns the log binding to place in `AcquisitionDto`.
    pub fn log_state(&self) -> Result<LogChainState, WaebError> {
        if self.log_state.event_count == 0 {
            return Err(WaebError::EmptyLog);
        }
        Ok(self.log_state.clone())
    }

    /// Writes acquisition metadata exactly once and validates its writer bindings.
    pub fn write_acquisition(&mut self, dto: &AcquisitionDto) -> Result<(), WaebError> {
        if !self.inventory_written {
            return Err(WaebError::MissingPayload("data/dataset-inventory.json"));
        }
        if dto.evidence_id != self.evidence_id {
            return Err(invalid("evidenceId", "does not match writer"));
        }
        if dto.schema_version != SCHEMA_VERSION || dto.wa_evidence_bag_version != WAEB_VERSION {
            return Err(invalid("version", "unsupported acquisition version"));
        }
        self.bind_source_id(dto.source_id)?;
        validate_acquisition(dto)?;
        let state = self.log_state()?;
        if dto.log.path != LOG_PATH
            || dto.log.event_count != state.event_count
            || Some(dto.log.terminal_event_hash.as_str()) != state.terminal_event_hash.as_deref()
        {
            return Err(invalid("log", "does not match append-only writer state"));
        }
        write_json_new(&self.staging_dir.join("data/acquisition.json"), dto)?;
        self.acquisition_written = true;
        Ok(())
    }

    /// Builds and writes the fixed 18-row dataset inventory.
    pub fn write_dataset_inventory(
        &mut self,
        source_id: Uuid,
        generated_at_utc: &str,
        dispositions: &[DatasetDisposition],
    ) -> Result<DatasetInventoryDto, WaebError> {
        validate_timestamp(generated_at_utc, "generatedAtUtc")?;
        if dispositions.len() != DATASETS.len() {
            return Err(WaebError::InvalidDatasetDispositions);
        }
        self.bind_source_id(source_id)?;
        let mut datasets = Vec::with_capacity(DATASETS.len());
        for (index, (spec, disposition)) in DATASETS.iter().zip(dispositions).enumerate() {
            validate_disposition(disposition, self.dataset_stats[index])?;
            datasets.push(DatasetInventoryItemDto {
                name: spec.name.to_owned(),
                path: spec.path.to_owned(),
                record_type: spec.record_type.to_owned(),
                capability: disposition.capability,
                request_state: disposition.request_state,
                result: disposition.result,
                record_count: self.dataset_stats[index].records,
                byte_length: self.dataset_stats[index].bytes,
                observation_window: disposition.observation_window.clone(),
                reason_codes: disposition.reason_codes.clone(),
            });
        }
        let dto = DatasetInventoryDto {
            schema_version: SCHEMA_VERSION.to_owned(),
            source_id,
            generated_at_utc: generated_at_utc.to_owned(),
            datasets,
        };
        write_json_new(&self.staging_dir.join("data/dataset-inventory.json"), &dto)?;
        self.inventory_written = true;
        Ok(dto)
    }

    /// Writes completeness metadata exactly once.
    pub fn write_completeness(&mut self, dto: &CompletenessDto) -> Result<(), WaebError> {
        if dto.schema_version != SCHEMA_VERSION
            || dto.dataset_inventory_path != "data/dataset-inventory.json"
            || dto.chat_completeness_path != CHAT_COMPLETENESS_PATH
            || dto.account_scope != "unverifiable"
        {
            return Err(invalid("completeness", "fixed v1 fields do not match"));
        }
        self.bind_source_id(dto.source_id)?;
        validate_completeness(dto)?;
        write_json_new(&self.staging_dir.join("data/completeness.json"), dto)?;
        self.completeness_written = true;
        Ok(())
    }

    /// Writes the fixed, ordered 19-capability probe result exactly once.
    pub fn write_capabilities(&mut self, dto: &CapabilitiesDto) -> Result<(), WaebError> {
        let ordered = dto.capabilities.len() == CAPABILITY_NAMES.len()
            && dto
                .capabilities
                .iter()
                .zip(CAPABILITY_NAMES)
                .all(|(actual, expected)| actual.name == expected);
        if dto.schema_version != SCHEMA_VERSION || !ordered {
            return Err(WaebError::InvalidCapabilities);
        }
        self.bind_source_id(dto.source_id)?;
        validate_capabilities(dto)?;
        write_json_new(
            &self.staging_dir.join("data/diagnostics/capabilities.json"),
            dto,
        )?;
        self.capabilities_written = true;
        Ok(())
    }

    /// Seals, signs, and syncs this evidence bag inside its staging wrapper.
    ///
    /// No unsigned API exists. If any step fails, the `.partial` directory is
    /// retained for diagnosis. The final directory is never created by this
    /// method: only [`SealedBag::promote_verified`] can perform that transition
    /// after a separate verifier has accepted the returned path.
    #[allow(clippy::too_many_lines)]
    pub fn seal(
        self,
        signing_key: &SigningKey,
        options: &SealOptions,
    ) -> Result<SealedBag, WaebError> {
        self.ensure_ready()?;
        validate_seal_options(options)?;
        self.reject_unexpected_staging_entries()?;
        sync_tree(&self.staging_dir.join("data"))?;

        let payload_files = walk_regular_files(&self.staging_dir.join("data"), &self.staging_dir)?;
        let (payload_bytes, payload_count) = payload_oxum(&self.staging_dir, &payload_files)?;
        write_manifest(
            &self.staging_dir,
            &payload_files,
            "manifest-sha256.txt",
            HashAlgorithm::Sha256,
        )?;
        write_manifest(
            &self.staging_dir,
            &payload_files,
            "manifest-sha512.txt",
            HashAlgorithm::Sha512,
        )?;

        write_new(
            &self.staging_dir.join("bagit.txt"),
            b"BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n",
        )?;
        let bag_info = format!(
            "Bagging-Date: {}\nBag-Software-Agent: {}\nPayload-Oxum: {}.{}\nExternal-Identifier: {}\nWAEvidenceBag-Version: {}\nSource-Organization: {}\n",
            options.bagging_date,
            options.software_agent,
            payload_bytes,
            payload_count,
            self.evidence_id,
            WAEB_VERSION,
            options.source_organization
        );
        write_new(&self.staging_dir.join("bag-info.txt"), bag_info.as_bytes())?;
        copy_embedded_schemas(&self.staging_dir)?;

        let verifying_key = signing_key.verifying_key();
        let mut spki = hex::decode("302a300506032b6570032100")
            .map_err(|error| WaebError::Crypto(error.to_string()))?;
        spki.extend_from_slice(verifying_key.as_bytes());
        let fingerprint = format!("sha256:{}", sha256_hex(&spki));
        let signer = json!({
            "schemaVersion": SCHEMA_VERSION,
            "algorithm": "Ed25519",
            "publicKeyFormat": "DER-SPKI",
            "publicKeySpkiBase64": base64::engine::general_purpose::STANDARD.encode(&spki),
            "publicKeyFingerprint": fingerprint,
            "keyId": options.key_id,
            "synthetic": options.synthetic_key
        });
        write_json_new(&self.staging_dir.join("signatures/signer.json"), &signer)?;

        let payload_manifest_paths = ["manifest-sha256.txt", "manifest-sha512.txt"];
        let payload_manifests = digest_entries(&self.staging_dir, &payload_manifest_paths)?;
        let mut core_tags = vec!["bag-info.txt", "bagit.txt"];
        core_tags.extend(EMBEDDED_SCHEMAS.iter().map(|schema| schema.path));
        core_tags.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        core_tags.push("signatures/signer.json");
        core_tags.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        let tag_files = digest_entries(&self.staging_dir, &core_tags)?;
        let manifest_root_sha256 = sha256_hex(&canonicalize_evidence(&json!({
            "payloadManifests": payload_manifests,
            "tagFiles": tag_files
        }))?);
        let seal = json!({
            "schemaVersion": SCHEMA_VERSION,
            "waEvidenceBagVersion": WAEB_VERSION,
            "evidenceId": self.evidence_id,
            "createdAtUtc": options.created_at_utc,
            "manifestRootSha256": manifest_root_sha256,
            "payloadManifests": payload_manifests,
            "tagFiles": tag_files,
            "signature": {
                "algorithm": "Ed25519",
                "signerFingerprint": fingerprint,
                "signaturePath": "signatures/seal.ed25519",
                "signedBytes": "exact-seal-json-utf8"
            }
        });
        let seal_bytes = canonicalize_evidence_line(&seal)?;
        write_new(&self.staging_dir.join("signatures/seal.json"), &seal_bytes)?;
        let signature = signing_key.sign(&seal_bytes);
        write_new(
            &self.staging_dir.join("signatures/seal.ed25519"),
            &signature.to_bytes(),
        )?;

        let all_files = walk_regular_files(&self.staging_dir, &self.staging_dir)?;
        let tag_files_for_manifest: Vec<String> = all_files
            .into_iter()
            .filter(|path| !path.starts_with("data/") && path != "tagmanifest-sha256.txt")
            .collect();
        write_manifest(
            &self.staging_dir,
            &tag_files_for_manifest,
            "tagmanifest-sha256.txt",
            HashAlgorithm::Sha256,
        )?;
        sync_tree(&self.staging_dir)?;

        Ok(SealedBag {
            path: self.staging_dir,
            evidence_id: self.evidence_id,
            manifest_root_sha256,
            signer_fingerprint: fingerprint,
            staging_base: self.staging_base,
            final_base: self.final_base,
            staging_root: self.staging_root,
            final_dir: self.final_dir,
        })
    }

    fn initialize_payload(&mut self) -> Result<(), WaebError> {
        for dataset in DATASETS {
            let path = self.staging_dir.join(dataset.path);
            create_parent_checked(&path)?;
            write_new(&path, &[])?;
        }
        for relative in [CHAT_COMPLETENESS_PATH, MEDIA_INDEX_PATH, LOG_PATH] {
            let path = self.staging_dir.join(relative);
            create_parent_checked(&path)?;
            write_new(&path, &[])?;
        }
        Ok(())
    }

    fn ensure_ready(&self) -> Result<(), WaebError> {
        if !self.acquisition_written {
            return Err(WaebError::MissingPayload("data/acquisition.json"));
        }
        if !self.inventory_written {
            return Err(WaebError::MissingPayload("data/dataset-inventory.json"));
        }
        if !self.completeness_written {
            return Err(WaebError::MissingPayload("data/completeness.json"));
        }
        if !self.capabilities_written {
            return Err(WaebError::MissingPayload(
                "data/diagnostics/capabilities.json",
            ));
        }
        self.log_state()?;
        Ok(())
    }

    fn ensure_payload_open(&self) -> Result<(), WaebError> {
        if self.inventory_written {
            Err(WaebError::PayloadFinalized)
        } else {
            Ok(())
        }
    }

    fn bind_source_id(&mut self, source_id: Uuid) -> Result<(), WaebError> {
        match self.source_id {
            Some(bound) if bound != source_id => Err(invalid(
                "sourceId",
                "does not match metadata already written in this bag",
            )),
            Some(_) => Ok(()),
            None => {
                self.source_id = Some(source_id);
                Ok(())
            }
        }
    }

    fn reject_unexpected_staging_entries(&self) -> Result<(), WaebError> {
        for entry in WalkDir::new(&self.staging_dir).follow_links(false) {
            let entry = entry.map_err(|error| WaebError::Io {
                path: error.path().unwrap_or(&self.staging_dir).to_path_buf(),
                source: std::io::Error::other(error.to_string()),
            })?;
            reject_symlink(entry.path())?;
            if !entry.file_type().is_dir() && !entry.file_type().is_file() {
                return Err(WaebError::UnsupportedEntry(entry.path().to_path_buf()));
            }
        }
        Ok(())
    }
}

impl SealedBag {
    /// Atomically promotes this already sealed bag to `waeb-<evidence-id>`.
    ///
    /// Callers must invoke this only after an independent verifier has accepted
    /// [`Self::path`] and bound its identity, manifest root, and signer to this
    /// handle. The source and destination cannot be supplied by the caller: both
    /// were fixed when [`WaebWriter::create`] created the staging wrapper.
    ///
    /// # Errors
    ///
    /// Fails closed if the wrapper layout changed, any traversed entry is a
    /// symlink/reparse point, the final name already exists, or the same-volume
    /// atomic rename fails. Before the rename succeeds, the bag remains below
    /// `.partial` and the formal destination is never created by this API.
    pub fn promote_verified(&self) -> Result<PromotedBag, WaebError> {
        self.validate_promotion_layout()?;
        if path_is_present(&self.final_dir)? {
            return Err(WaebError::FinalExists(self.final_dir.clone()));
        }

        fs::rename(&self.path, &self.final_dir).at(&self.path)?;

        // Promotion itself is the atomic security boundary. Failure to remove
        // the now-empty staging wrapper must not turn a completed rename into a
        // false failure (for example when an antivirus briefly holds it open).
        let _ = fs::remove_dir(&self.staging_root);
        Ok(PromotedBag {
            path: self.final_dir.clone(),
            evidence_id: self.evidence_id,
        })
    }

    fn validate_promotion_layout(&self) -> Result<(), WaebError> {
        let leaf = format!("waeb-{}", self.evidence_id);
        let wrapper = format!("{leaf}.partial");
        if self.path.file_name().and_then(|name| name.to_str()) != Some(leaf.as_str())
            || self.staging_root.file_name().and_then(|name| name.to_str())
                != Some(wrapper.as_str())
            || self.final_dir.file_name().and_then(|name| name.to_str()) != Some(leaf.as_str())
            || self.path.parent() != Some(self.staging_root.as_path())
            || self.staging_root.parent() != Some(self.staging_base.as_path())
            || self.final_dir.parent() != Some(self.final_base.as_path())
        {
            return Err(invalid(
                "promotion",
                "sealed handle no longer has the fixed staging/final layout",
            ));
        }

        reject_symlink(&self.staging_base)?;
        reject_symlink(&self.final_base)?;
        reject_symlink(&self.staging_root)?;
        reject_symlink(&self.path)?;
        if !fs::metadata(&self.staging_base)
            .at(&self.staging_base)?
            .is_dir()
            || !fs::metadata(&self.final_base)
                .at(&self.final_base)?
                .is_dir()
            || !fs::metadata(&self.staging_root)
                .at(&self.staging_root)?
                .is_dir()
            || !fs::metadata(&self.path).at(&self.path)?.is_dir()
        {
            return Err(invalid(
                "promotion",
                "staging/final roots, staging wrapper, and bag must remain directories",
            ));
        }
        if fs::canonicalize(&self.staging_base).at(&self.staging_base)? != self.staging_base
            || fs::canonicalize(&self.final_base).at(&self.final_base)? != self.final_base
        {
            return Err(invalid(
                "promotion",
                "staging or final root identity changed after writer creation",
            ));
        }

        let entries = fs::read_dir(&self.staging_root)
            .at(&self.staging_root)?
            .collect::<Result<Vec<_>, _>>()
            .at(&self.staging_root)?;
        if entries.len() != 1 || entries[0].path() != self.path {
            return Err(invalid(
                "promotion",
                "staging wrapper must contain exactly the sealed bag",
            ));
        }
        for entry in WalkDir::new(&self.path).follow_links(false) {
            let entry = entry.map_err(|error| WaebError::Io {
                path: error.path().unwrap_or(&self.path).to_path_buf(),
                source: std::io::Error::other(error.to_string()),
            })?;
            reject_symlink(entry.path())?;
            if !entry.file_type().is_dir() && !entry.file_type().is_file() {
                return Err(WaebError::UnsupportedEntry(entry.path().to_path_buf()));
            }
        }
        Ok(())
    }
}

/// In-progress media bytes whose digest is computed while streaming.
pub struct MediaStream<'a> {
    writer: &'a mut WaebWriter,
    file: Option<File>,
    temp_path: PathBuf,
    sha256: Sha256,
    sha512: Sha512,
    byte_length: u64,
}

impl MediaStream<'_> {
    /// Writes a media chunk without buffering the complete asset in memory.
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), WaebError> {
        let file = self.file.as_mut().ok_or(WaebError::MediaAlreadyCommitted)?;
        file.write_all(bytes).at(&self.temp_path)?;
        self.sha256.update(bytes);
        self.sha512.update(bytes);
        self.byte_length = self
            .byte_length
            .checked_add(
                u64::try_from(bytes.len()).map_err(|error| invalid("media", &error.to_string()))?,
            )
            .ok_or_else(|| invalid("media", "byte length overflow"))?;
        Ok(())
    }

    /// Flushes and atomically commits this object into the SHA-256 CAS.
    pub fn commit(mut self) -> Result<MediaAsset, WaebError> {
        let mut file = self.file.take().ok_or(WaebError::MediaAlreadyCommitted)?;
        file.flush().at(&self.temp_path)?;
        file.sync_all().at(&self.temp_path)?;
        drop(file);
        let sha256 = hex::encode(self.sha256.clone().finalize());
        let sha512 = hex::encode(self.sha512.clone().finalize());
        let relative_path = format!("data/media/sha256/{}/{}", &sha256[..2], sha256);
        let target = self.writer.staging_dir.join(&relative_path);
        create_parent_checked(&target)?;
        let deduplicated = if target.exists() {
            reject_symlink(&target)?;
            let existing = hash_file(&target, HashAlgorithm::Sha256)?;
            if existing != sha256 {
                return Err(WaebError::CasCollision(target));
            }
            fs::remove_file(&self.temp_path).at(&self.temp_path)?;
            true
        } else {
            fs::rename(&self.temp_path, &target).at(&self.temp_path)?;
            false
        };
        let _ = fs::remove_dir(self.writer.staging_dir.join(".incoming"));
        Ok(MediaAsset {
            relative_path,
            sha256,
            sha512,
            byte_length: self.byte_length,
            deduplicated,
        })
    }
}

impl Drop for MediaStream<'_> {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = fs::remove_file(&self.temp_path);
            if let Some(parent) = self.temp_path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum HashAlgorithm {
    Sha256,
    Sha512,
}

fn append_bytes(path: &Path, bytes: &[u8]) -> Result<(), WaebError> {
    reject_symlink(path)?;
    let mut file = OpenOptions::new().append(true).open(path).at(path)?;
    file.write_all(bytes).at(path)?;
    file.flush().at(path)
}

fn append_bytes_create(path: &Path, bytes: &[u8]) -> Result<(), WaebError> {
    create_parent_checked(path)?;
    reject_symlink(path)?;
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .at(path)?;
    file.write_all(bytes).at(path)?;
    file.flush().at(path)
}

fn write_json_new<T: Serialize>(path: &Path, value: &T) -> Result<(), WaebError> {
    write_new(path, &canonicalize_evidence_line(value)?)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), WaebError> {
    create_parent_checked(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .at(path)?;
    file.write_all(bytes).at(path)?;
    file.flush().at(path)?;
    file.sync_all().at(path)
}

fn create_parent_checked(path: &Path) -> Result<(), WaebError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("path", "has no parent"))?;
    create_dir_checked(parent)
}

fn create_dir_checked(path: &Path) -> Result<(), WaebError> {
    if path.exists() {
        reject_symlink(path)?;
        if !fs::metadata(path).at(path)?.is_dir() {
            return Err(invalid("directory", "path is not a directory"));
        }
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| invalid("directory", "has no parent"))?;
        create_dir_checked(parent)?;
        match fs::create_dir(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(source) => {
                return Err(WaebError::Io {
                    path: path.to_path_buf(),
                    source,
                });
            }
        }
        reject_symlink(path)?;
    }
    Ok(())
}

fn canonical_real_directory(path: &Path, field: &'static str) -> Result<PathBuf, WaebError> {
    reject_symlink(path)?;
    if !fs::metadata(path).at(path)?.is_dir() {
        return Err(invalid(field, "must be an existing directory"));
    }
    let canonical = fs::canonicalize(path).at(path)?;
    reject_symlink(&canonical)?;
    Ok(canonical)
}

fn reject_symlink(path: &Path) -> Result<(), WaebError> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).at(path)?;
        if metadata_is_link(&metadata) {
            return Err(WaebError::SymlinkForbidden(path.to_path_buf()));
        }
    }
    Ok(())
}

fn path_is_present(path: &Path) -> Result<bool, WaebError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(WaebError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

#[cfg(windows)]
fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn validate_summary(summary: &Value) -> Result<(), WaebError> {
    let object = summary
        .as_object()
        .ok_or_else(|| invalid("event.summary", "must be an object"))?;
    if object.len() > 30 {
        return Err(invalid("event.summary", "contains more than 30 properties"));
    }
    for (key, value) in object {
        if key.is_empty()
            || key.len() > 80
            || !key.as_bytes()[0].is_ascii_lowercase()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(invalid(
                "event.summary",
                "contains an invalid property name",
            ));
        }
        let permitted = value.is_null()
            || value.is_boolean()
            || value.is_number()
            || value.is_string()
            || value.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.is_null() || item.is_boolean() || item.is_number() || item.is_string()
                })
            });
        if !permitted {
            return Err(invalid("event.summary", "contains a nested object/array"));
        }
    }
    canonicalize_evidence(summary)?;
    Ok(())
}

fn validate_disposition(
    disposition: &DatasetDisposition,
    stats: DatasetStats,
) -> Result<(), WaebError> {
    validate_reason_codes(&disposition.reason_codes)?;
    let has_reason = !disposition.reason_codes.is_empty();
    let has_window = disposition.observation_window.is_some();
    let empty = stats.records == 0 && stats.bytes == 0;
    let valid = match (
        disposition.capability,
        disposition.request_state,
        disposition.result,
    ) {
        (_, RequestState::NotRequested, DatasetResult::NotRequested)
        | (DatasetCapability::Unsupported, RequestState::Requested, DatasetResult::Unsupported) => {
            empty && !has_window && has_reason
        }
        (DatasetCapability::Supported, RequestState::Requested, DatasetResult::Empty) => {
            empty && has_window
        }
        (
            DatasetCapability::Supported,
            RequestState::Requested,
            DatasetResult::CompleteAsObserved,
        ) => !empty && has_window,
        (DatasetCapability::Supported, RequestState::Requested, DatasetResult::Partial) => {
            has_window && has_reason
        }
        (
            DatasetCapability::Supported | DatasetCapability::Unknown,
            RequestState::Requested,
            DatasetResult::Failed,
        ) => empty && has_reason,
        _ => false,
    };
    if !valid {
        return Err(invalid(
            "dataset disposition",
            "state/count combination is invalid",
        ));
    }
    if let Some(window) = &disposition.observation_window {
        validate_window(window)?;
    }
    Ok(())
}

fn validate_window(window: &ObservationWindowDto) -> Result<(), WaebError> {
    validate_timestamp(&window.started_at_utc, "startedAtUtc")?;
    validate_timestamp(&window.ended_at_utc, "endedAtUtc")
}

fn validate_acquisition(dto: &AcquisitionDto) -> Result<(), WaebError> {
    validate_window(&dto.observation_window)?;
    validate_timestamp(&dto.authorization.confirmed_at_utc, "confirmedAtUtc")?;
    if !dto.acquisition_mode.baseline {
        return Err(invalid("acquisitionMode.baseline", "must be true"));
    }
    for (field, component) in [
        ("collector", &dto.collector),
        ("injector", &dto.injector),
        ("adapter", &dto.adapter),
    ] {
        if component.name.is_empty()
            || component.name.len() > 120
            || component.version.is_empty()
            || component.version.len() > 80
            || !is_lower_hex(&component.sha256, 64)
        {
            return Err(invalid(field, "component identity is invalid"));
        }
    }
    if dto.operator.operator_id.len() < 3
        || dto.operator.operator_id.len() > 80
        || !dto.operator.operator_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        return Err(invalid("operatorId", "does not match the v1 grammar"));
    }
    if dto.authorization.reference.is_empty()
        || dto.authorization.reference.len() > 240
        || dto.environment.whatsapp_build.is_empty()
        || dto.environment.whatsapp_build.len() > 160
    {
        return Err(invalid("acquisition", "required text is empty or too long"));
    }
    if !is_lower_hex(&dto.portable_configuration.bundle_manifest_sha256, 64)
        || !is_lower_hex(&dto.portable_configuration.assignment_sha256, 64)
        || !valid_portable_identifier(&dto.portable_configuration.assignment_id)
        || !dto
            .portable_configuration
            .workstation_key_fingerprint_sha256
            .strip_prefix("sha256:")
            .is_some_and(|value| is_lower_hex(value, 64))
    {
        return Err(invalid(
            "portableConfiguration",
            "portable task/configuration binding is invalid",
        ));
    }
    if !dto.privacy.normalized_whitelist {
        return Err(invalid("normalizedWhitelist", "must be true"));
    }
    let allowed_omissions = [
        "media_keys",
        "access_tokens",
        "direct_urls",
        "cookies",
        "credentials",
        "debug_secrets",
    ];
    if has_duplicates(&dto.privacy.omitted_field_classes)
        || !dto
            .privacy
            .omitted_field_classes
            .iter()
            .all(|item| allowed_omissions.contains(&item.as_str()))
    {
        return Err(invalid(
            "omittedFieldClasses",
            "contains an invalid or duplicate value",
        ));
    }
    Ok(())
}

fn valid_portable_identifier(value: &str) -> bool {
    (3..=120).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_alphanumeric()
            } else {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
            }
        })
}

fn validate_completeness(dto: &CompletenessDto) -> Result<(), WaebError> {
    validate_timestamp(&dto.evaluated_at_utc, "evaluatedAtUtc")?;
    if !["complete_as_observed", "partial", "failed"].contains(&dto.overall.as_str())
        || !["verified", "partial", "failed"].contains(&dto.local_snapshot.as_str())
        || ![
            "terminal_observed",
            "stable_no_growth",
            "limit_reached",
            "loader_error",
            "not_run",
        ]
        .contains(&dto.history_scope.as_str())
        || !["complete", "partial", "not_requested"].contains(&dto.media_scope.as_str())
    {
        return Err(invalid("completeness", "contains an unknown v1 state"));
    }
    validate_reason_codes(&dto.reason_codes)?;
    if dto
        .cross_checks
        .differences
        .iter()
        .any(|item| item.len() > 300)
    {
        return Err(invalid(
            "crossChecks.differences",
            "item exceeds 300 characters",
        ));
    }
    Ok(())
}

fn validate_capabilities(dto: &CapabilitiesDto) -> Result<(), WaebError> {
    validate_timestamp(&dto.probed_at_utc, "probedAtUtc")?;
    if dto.whatsapp_build.is_empty() || dto.whatsapp_build.len() > 160 {
        return Err(WaebError::InvalidCapabilities);
    }
    for capability in &dto.capabilities {
        validate_reason_codes(&capability.reason_codes)?;
        let adapter_present = capability
            .adapter
            .as_ref()
            .is_some_and(|value| !value.is_empty());
        let has_reason = !capability.reason_codes.is_empty();
        let valid = match capability.result.as_str() {
            "supported" => adapter_present,
            "degraded" => adapter_present && has_reason,
            "unsupported" => capability.adapter.is_none() && has_reason,
            "error" => has_reason,
            _ => false,
        };
        if !valid
            || capability
                .adapter
                .as_ref()
                .is_some_and(|value| value.len() > 120)
        {
            return Err(WaebError::InvalidCapabilities);
        }
    }
    Ok(())
}

fn validate_reason_codes(codes: &[String]) -> Result<(), WaebError> {
    if has_duplicates(codes) {
        return Err(invalid("reasonCodes", "contains duplicate values"));
    }
    for code in codes {
        if code.len() < 3
            || code.len() > 100
            || !code
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(invalid("reasonCodes", "contains an invalid reason code"));
        }
    }
    Ok(())
}

fn has_duplicates(values: &[String]) -> bool {
    let mut seen = BTreeSet::new();
    values.iter().any(|value| !seen.insert(value))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_timestamp(value: &str, field: &'static str) -> Result<(), WaebError> {
    if !value.ends_with('Z') || chrono::DateTime::parse_from_rfc3339(value).is_err() {
        return Err(invalid(
            field,
            "must be an RFC 3339 UTC timestamp ending in Z",
        ));
    }
    Ok(())
}

fn validate_seal_options(options: &SealOptions) -> Result<(), WaebError> {
    validate_timestamp(&options.created_at_utc, "createdAtUtc")?;
    let valid_date = chrono::NaiveDate::parse_from_str(&options.bagging_date, "%Y-%m-%d").is_ok();
    if !valid_date {
        return Err(invalid("baggingDate", "must be YYYY-MM-DD"));
    }
    for (field, value) in [
        ("softwareAgent", options.software_agent.as_str()),
        ("sourceOrganization", options.source_organization.as_str()),
        ("keyId", options.key_id.as_str()),
    ] {
        if value.is_empty() || value.contains(['\r', '\n']) {
            return Err(invalid(field, "must be non-empty and single-line"));
        }
    }
    if options.key_id.len() < 3
        || options.key_id.len() > 120
        || !options
            .key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(invalid(
            "keyId",
            "does not match the v1 key identifier grammar",
        ));
    }
    Ok(())
}

fn invalid(field: &'static str, reason: &str) -> WaebError {
    WaebError::InvalidMetadata {
        field,
        reason: reason.to_owned(),
    }
}

fn copy_embedded_schemas(root: &Path) -> Result<(), WaebError> {
    for schema in EMBEDDED_SCHEMAS {
        write_new(&root.join(schema.path), schema.bytes)?;
    }
    Ok(())
}

fn walk_regular_files(directory: &Path, root: &Path) -> Result<Vec<String>, WaebError> {
    let mut result = Vec::new();
    for entry in WalkDir::new(directory).follow_links(false) {
        let entry = entry.map_err(|error| WaebError::Io {
            path: error.path().unwrap_or(directory).to_path_buf(),
            source: std::io::Error::other(error.to_string()),
        })?;
        reject_symlink(entry.path())?;
        if entry.file_type().is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|error| invalid("manifest path", &error.to_string()))?;
            let path = relative_path(relative)?;
            result.push(path);
        } else if !entry.file_type().is_dir() {
            return Err(WaebError::UnsupportedEntry(entry.path().to_path_buf()));
        }
    }
    result.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(result)
}

fn relative_path(path: &Path) -> Result<String, WaebError> {
    let mut parts = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(WaebError::UnsafeManifestPath(path.to_path_buf()));
        };
        let text = part
            .to_str()
            .ok_or_else(|| WaebError::UnsafeManifestPath(path.to_path_buf()))?;
        if text.is_empty() || text == "." || text == ".." || text.contains(['/', '\\']) {
            return Err(WaebError::UnsafeManifestPath(path.to_path_buf()));
        }
        parts.push(text);
    }
    if parts.is_empty() {
        return Err(WaebError::UnsafeManifestPath(path.to_path_buf()));
    }
    Ok(parts.join("/"))
}

fn payload_oxum(root: &Path, paths: &[String]) -> Result<(u64, usize), WaebError> {
    let mut total = 0_u64;
    for relative in paths {
        let length = fs::metadata(root.join(relative))
            .at(root.join(relative))?
            .len();
        total = total
            .checked_add(length)
            .ok_or_else(|| invalid("Payload-Oxum", "byte count overflow"))?;
    }
    Ok((total, paths.len()))
}

fn write_manifest(
    root: &Path,
    paths: &[String],
    output_name: &str,
    algorithm: HashAlgorithm,
) -> Result<(), WaebError> {
    let mut manifest = Vec::new();
    for relative in paths {
        let digest = hash_file(&root.join(relative), algorithm)?;
        writeln!(&mut manifest, "{digest}  {relative}")
            .map_err(|error| invalid("manifest", &error.to_string()))?;
    }
    write_new(&root.join(output_name), &manifest)
}

fn hash_file(path: &Path, algorithm: HashAlgorithm) -> Result<String, WaebError> {
    let file = File::open(path).at(path)?;
    let mut reader = BufReader::new(file);
    let mut buffer = vec![0_u8; 64 * 1024];
    match algorithm {
        HashAlgorithm::Sha256 => {
            let mut hasher = Sha256::new();
            loop {
                let read = reader.read(&mut buffer).at(path)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            Ok(hex::encode(hasher.finalize()))
        }
        HashAlgorithm::Sha512 => {
            let mut hasher = Sha512::new();
            loop {
                let read = reader.read(&mut buffer).at(path)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            Ok(hex::encode(hasher.finalize()))
        }
    }
}

fn digest_entries(root: &Path, paths: &[&str]) -> Result<Vec<Value>, WaebError> {
    paths
        .iter()
        .map(|path| {
            Ok(json!({
                "path": path,
                "sha256": hash_file(&root.join(path), HashAlgorithm::Sha256)?
            }))
        })
        .collect()
}

fn sync_tree(root: &Path) -> Result<(), WaebError> {
    let paths = walk_regular_files(root, root)?;
    for relative in paths {
        let path = root.join(relative);
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .at(&path)?
            .sync_all()
            .at(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    use ed25519_dalek::SigningKey;
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::{
        AcquisitionLogDto, AcquisitionModeDto, AuthorizationDto, BrowserDto, CapabilityDto,
        ComponentDto, CrossChecksDto, EnvironmentDto, MediaCountsDto, OperatorDto, OsDto,
        PortableConfigurationDto, PrivacyDto,
    };

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("waeb-writer-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap_or_else(|error| panic!("create temp: {error}"));
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn window() -> ObservationWindowDto {
        ObservationWindowDto {
            started_at_utc: "2026-01-15T08:00:00.000Z".to_owned(),
            ended_at_utc: "2026-01-15T08:00:10.000Z".to_owned(),
        }
    }

    fn dispositions() -> Vec<DatasetDisposition> {
        DATASETS
            .iter()
            .map(|_| DatasetDisposition {
                capability: DatasetCapability::Supported,
                request_state: RequestState::Requested,
                result: DatasetResult::Empty,
                observation_window: Some(window()),
                reason_codes: vec![],
            })
            .collect()
    }

    fn capability_dto(source_id: Uuid) -> CapabilitiesDto {
        CapabilitiesDto {
            schema_version: SCHEMA_VERSION.to_owned(),
            source_id,
            probed_at_utc: "2026-01-15T08:00:01.000Z".to_owned(),
            whatsapp_build: "test-build.invalid".to_owned(),
            capabilities: CAPABILITY_NAMES
                .iter()
                .map(|name| CapabilityDto {
                    name: (*name).to_owned(),
                    result: "supported".to_owned(),
                    adapter: Some("test-adapter".to_owned()),
                    reason_codes: vec![],
                })
                .collect(),
        }
    }

    fn completeness(source_id: Uuid) -> CompletenessDto {
        CompletenessDto {
            schema_version: SCHEMA_VERSION.to_owned(),
            source_id,
            evaluated_at_utc: "2026-01-15T08:00:10.000Z".to_owned(),
            overall: "partial".to_owned(),
            local_snapshot: "verified".to_owned(),
            history_scope: "not_run".to_owned(),
            media_scope: "not_requested".to_owned(),
            account_scope: "unverifiable".to_owned(),
            dataset_inventory_path: "data/dataset-inventory.json".to_owned(),
            chat_completeness_path: CHAT_COMPLETENESS_PATH.to_owned(),
            media_counts: MediaCountsDto {
                requested: 0,
                full: 0,
                thumbnail: 0,
                missing: 0,
                expired: 0,
                decrypt_error: 0,
                not_requested: 0,
            },
            cross_checks: CrossChecksDto {
                inventory_counts_match: true,
                media_index_matches_cas: true,
                normalized_refs_resolved: true,
                differences: vec![],
            },
            reason_codes: vec!["history_not_requested".to_owned()],
        }
    }

    fn acquisition(evidence_id: Uuid, source_id: Uuid, log: LogChainState) -> AcquisitionDto {
        let component = ComponentDto {
            name: "test".to_owned(),
            version: "0.1.0".to_owned(),
            sha256: "0".repeat(64),
        };
        AcquisitionDto {
            schema_version: SCHEMA_VERSION.to_owned(),
            wa_evidence_bag_version: WAEB_VERSION.to_owned(),
            evidence_id,
            acquisition_id: Uuid::new_v4(),
            source_id,
            synthetic: true,
            fixture: None,
            collector: component.clone(),
            injector: component.clone(),
            adapter: component,
            environment: EnvironmentDto {
                os: OsDto {
                    family: "windows".to_owned(),
                    version: "test".to_owned(),
                    architecture: "x86_64".to_owned(),
                },
                browser: BrowserDto {
                    family: "chrome".to_owned(),
                    version: "test".to_owned(),
                    profile_mode: "authorized_existing".to_owned(),
                    profile_reference_sha256: None,
                    debug_transport: "loopback_websocket".to_owned(),
                },
                whatsapp_build: "test.invalid".to_owned(),
                locale: "zh-CN".to_owned(),
                time_zone: "Asia/Shanghai".to_owned(),
            },
            operator: OperatorDto {
                operator_id: "test_operator".to_owned(),
                display_name: None,
            },
            authorization: AuthorizationDto {
                reference: "test-only".to_owned(),
                confirmed_at_utc: window().started_at_utc.clone(),
            },
            portable_configuration: PortableConfigurationDto {
                bundle_id: Uuid::new_v4(),
                bundle_manifest_sha256: "1".repeat(64),
                assignment_id: "assignment-test".to_owned(),
                assignment_sha256: "2".repeat(64),
                workstation_key_fingerprint_sha256: format!("sha256:{}", "3".repeat(64)),
            },
            observation_window: window(),
            acquisition_mode: AcquisitionModeDto {
                baseline: true,
                enrichment_requested: false,
                ui_fallback_allowed: false,
            },
            log: AcquisitionLogDto {
                path: LOG_PATH.to_owned(),
                event_count: log.event_count,
                terminal_event_hash: log
                    .terminal_event_hash
                    .unwrap_or_else(|| panic!("test log must have a hash")),
            },
            privacy: PrivacyDto {
                normalized_whitelist: true,
                omitted_field_classes: vec!["credentials".to_owned()],
                restricted_raw_included: false,
            },
            extensions: None,
        }
    }

    fn ready_writer(root: &Path) -> WaebWriter {
        let evidence_id = Uuid::new_v4();
        let source_id = Uuid::new_v4();
        let mut writer = WaebWriter::create(root, evidence_id)
            .unwrap_or_else(|error| panic!("create writer: {error}"));
        writer
            .append_log_event(
                Uuid::new_v4(),
                "2026-01-15T08:00:00.000Z",
                0,
                LogEventType::AcquisitionStarted,
                &json!({"synthetic": true}),
            )
            .unwrap_or_else(|error| panic!("append log: {error}"));
        writer
            .write_dataset_inventory(source_id, "2026-01-15T08:00:10.000Z", &dispositions())
            .unwrap_or_else(|error| panic!("inventory: {error}"));
        writer
            .write_capabilities(&capability_dto(source_id))
            .unwrap_or_else(|error| panic!("capabilities: {error}"));
        writer
            .write_completeness(&completeness(source_id))
            .unwrap_or_else(|error| panic!("completeness: {error}"));
        let acquisition = acquisition(
            evidence_id,
            source_id,
            writer
                .log_state()
                .unwrap_or_else(|error| panic!("log state: {error}")),
        );
        writer
            .write_acquisition(&acquisition)
            .unwrap_or_else(|error| panic!("acquisition: {error}"));
        writer
    }

    #[test]
    fn media_is_streamed_and_deduplicated_in_cas() {
        let temp = TempDir::new();
        let mut writer = WaebWriter::create(&temp.0, Uuid::new_v4())
            .unwrap_or_else(|error| panic!("create writer: {error}"));
        let first = {
            let mut stream = writer
                .start_media()
                .unwrap_or_else(|error| panic!("start: {error}"));
            stream
                .write_chunk(b"abc")
                .unwrap_or_else(|error| panic!("write: {error}"));
            stream
                .commit()
                .unwrap_or_else(|error| panic!("commit: {error}"))
        };
        let second = {
            let mut stream = writer
                .start_media()
                .unwrap_or_else(|error| panic!("start: {error}"));
            stream
                .write_chunk(b"a")
                .unwrap_or_else(|error| panic!("write: {error}"));
            stream
                .write_chunk(b"bc")
                .unwrap_or_else(|error| panic!("write: {error}"));
            stream
                .commit()
                .unwrap_or_else(|error| panic!("commit: {error}"))
        };
        assert_eq!(first.sha256, second.sha256);
        assert!(!first.deduplicated);
        assert!(second.deduplicated);
        assert_eq!(
            fs::read(writer.staging_path().join(first.relative_path)).unwrap_or_default(),
            b"abc"
        );
    }

    #[test]
    fn unknown_dataset_and_record_type_are_rejected() {
        let temp = TempDir::new();
        let mut writer = WaebWriter::create(&temp.0, Uuid::new_v4())
            .unwrap_or_else(|error| panic!("create writer: {error}"));
        assert!(
            writer
                .append_normalized("../escape", &json!({"recordType":"message"}))
                .is_err()
        );
        assert!(
            writer
                .append_normalized("messages", &json!({"recordType":"contact"}))
                .is_err()
        );
        assert!(!temp.0.join("escape").exists());
    }

    #[test]
    fn production_payload_rejects_native_floats_and_unsafe_integers() {
        let temp = TempDir::new();
        let mut writer = WaebWriter::create(&temp.0, Uuid::new_v4())
            .unwrap_or_else(|error| panic!("create writer: {error}"));
        assert!(
            writer
                .append_raw(
                    RawPhase::Baseline,
                    RawProvider::Store,
                    RawStream::Metadata,
                    &json!({"value": 1.5}),
                )
                .is_err()
        );
        assert!(
            writer
                .append_raw(
                    RawPhase::Baseline,
                    RawProvider::Store,
                    RawStream::Metadata,
                    &json!({"value": 9_007_199_254_740_992_u64}),
                )
                .is_err()
        );
    }

    #[test]
    fn inventory_freezes_all_streaming_payload_interfaces() {
        let temp = TempDir::new();
        let source_id = Uuid::new_v4();
        let mut writer = WaebWriter::create(&temp.0, Uuid::new_v4())
            .unwrap_or_else(|error| panic!("create writer: {error}"));
        writer
            .write_dataset_inventory(source_id, "2026-01-15T08:00:10.000Z", &dispositions())
            .unwrap_or_else(|error| panic!("inventory: {error}"));
        assert!(matches!(
            writer.append_raw(
                RawPhase::Baseline,
                RawProvider::Store,
                RawStream::Metadata,
                &json!({"value": "late"}),
            ),
            Err(WaebError::PayloadFinalized)
        ));
        assert!(matches!(
            writer.start_media(),
            Err(WaebError::PayloadFinalized)
        ));
        assert!(matches!(
            writer.append_log_event(
                Uuid::new_v4(),
                "2026-01-15T08:00:10.000Z",
                1,
                LogEventType::Warning,
                &json!({"reason": "late"}),
            ),
            Err(WaebError::PayloadFinalized)
        ));
    }

    #[test]
    fn unsigned_writer_never_promotes_partial_directory() {
        let temp = TempDir::new();
        let writer = WaebWriter::create(&temp.0, Uuid::new_v4())
            .unwrap_or_else(|error| panic!("create writer: {error}"));
        let staging = writer.staging_path().to_path_buf();
        let final_path = temp.0.join(staging.file_name().unwrap_or_default());
        drop(writer);
        assert!(staging.is_dir());
        assert!(
            staging
                .parent()
                .is_some_and(|parent| parent.to_string_lossy().ends_with(".partial"))
        );
        assert!(!final_path.exists());
    }

    #[test]
    fn base_directory_must_already_exist() {
        let temp = TempDir::new();
        let absent = temp.0.join("absent").join("nested");
        assert!(WaebWriter::create(&absent, Uuid::new_v4()).is_err());
        assert!(!absent.exists());
    }

    #[test]
    fn seals_with_embedded_schemas_and_signature_last() {
        let temp = TempDir::new();
        let writer = ready_writer(&temp.0);
        let options = SealOptions {
            created_at_utc: "2026-01-15T08:00:10.000Z".to_owned(),
            bagging_date: "2026-01-15".to_owned(),
            software_agent: "waeb-writer-test/0.1.0".to_owned(),
            source_organization: "synthetic test".to_owned(),
            key_id: "ephemeral-test-key".to_owned(),
            synthetic_key: true,
        };
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let sealed = writer
            .seal(&key, &options)
            .unwrap_or_else(|error| panic!("seal: {error}"));
        assert!(sealed.path.is_dir());
        let staging_root = sealed
            .path
            .parent()
            .unwrap_or_else(|| panic!("staging root"));
        assert!(staging_root.to_string_lossy().ends_with(".partial"));
        let final_path = temp.0.join(sealed.path.file_name().unwrap_or_default());
        assert!(!final_path.exists());
        assert_eq!(
            fs::read(sealed.path.join("signatures/seal.ed25519"))
                .unwrap_or_default()
                .len(),
            64
        );
        for schema in EMBEDDED_SCHEMAS {
            assert_eq!(
                fs::read(sealed.path.join(schema.path)).unwrap_or_default(),
                schema.bytes
            );
        }
        let tagmanifest = fs::read_to_string(sealed.path.join("tagmanifest-sha256.txt"))
            .unwrap_or_else(|error| panic!("tagmanifest: {error}"));
        assert!(tagmanifest.contains("signatures/seal.json"));
        assert!(tagmanifest.contains("signatures/seal.ed25519"));
        assert!(!tagmanifest.contains("tagmanifest-sha256.txt"));

        let node_available = Command::new("node").arg("--version").output().is_ok();
        if node_available {
            let verifier = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../spec/wa-evidence-bag/v1/tools/verify-example.mjs");
            let verification = Command::new("node")
                .arg(verifier)
                .arg(&sealed.path)
                .output()
                .unwrap_or_else(|error| panic!("run independent verifier: {error}"));
            assert!(
                verification.status.success(),
                "independent verifier rejected Rust bag:\nstdout={}\nstderr={}",
                String::from_utf8_lossy(&verification.stdout),
                String::from_utf8_lossy(&verification.stderr)
            );
        }

        let promoted = sealed
            .promote_verified()
            .unwrap_or_else(|error| panic!("promote verified: {error}"));
        assert_eq!(
            fs::canonicalize(&promoted.path).unwrap_or_else(|error| panic!("canonical: {error}")),
            fs::canonicalize(&final_path).unwrap_or_else(|error| panic!("canonical: {error}"))
        );
        assert!(promoted.path.is_dir());
        assert!(!staging_root.exists());
        assert!(sealed.promote_verified().is_err());
        assert!(promoted.path.is_dir());
    }

    #[test]
    fn promotion_rejects_an_unexpected_staging_sibling() {
        let temp = TempDir::new();
        let sealed = ready_writer(&temp.0)
            .seal(
                &SigningKey::from_bytes(&[8_u8; 32]),
                &SealOptions {
                    created_at_utc: "2026-01-15T08:00:10.000Z".to_owned(),
                    bagging_date: "2026-01-15".to_owned(),
                    software_agent: "waeb-writer-test/0.1.0".to_owned(),
                    source_organization: "synthetic test".to_owned(),
                    key_id: "ephemeral-test-key".to_owned(),
                    synthetic_key: true,
                },
            )
            .unwrap_or_else(|error| panic!("seal: {error}"));
        let staging_root = sealed
            .path
            .parent()
            .unwrap_or_else(|| panic!("staging root"));
        fs::write(staging_root.join("unexpected.txt"), b"must fail closed")
            .unwrap_or_else(|error| panic!("write sibling: {error}"));
        let final_path = temp.0.join(sealed.path.file_name().unwrap_or_default());

        assert!(matches!(
            sealed.promote_verified(),
            Err(WaebError::InvalidMetadata {
                field: "promotion",
                ..
            })
        ));
        assert!(!final_path.exists());
        assert!(sealed.path.is_dir());
    }

    #[test]
    fn promotion_never_overwrites_an_existing_formal_directory() {
        let temp = TempDir::new();
        let sealed = ready_writer(&temp.0)
            .seal(
                &SigningKey::from_bytes(&[10_u8; 32]),
                &SealOptions {
                    created_at_utc: "2026-01-15T08:00:10.000Z".to_owned(),
                    bagging_date: "2026-01-15".to_owned(),
                    software_agent: "waeb-writer-test/0.1.0".to_owned(),
                    source_organization: "synthetic test".to_owned(),
                    key_id: "ephemeral-test-key".to_owned(),
                    synthetic_key: true,
                },
            )
            .unwrap_or_else(|error| panic!("seal: {error}"));
        let final_path = temp.0.join(sealed.path.file_name().unwrap_or_default());
        fs::create_dir(&final_path).unwrap_or_else(|error| panic!("formal dir: {error}"));
        fs::write(final_path.join("owner-marker"), b"pre-existing")
            .unwrap_or_else(|error| panic!("marker: {error}"));

        assert!(matches!(
            sealed.promote_verified(),
            Err(WaebError::FinalExists(_))
        ));
        assert!(sealed.path.is_dir());
        assert_eq!(
            fs::read(final_path.join("owner-marker")).unwrap_or_default(),
            b"pre-existing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_in_staging_is_rejected_before_sealing() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new();
        let writer = ready_writer(&temp.0);
        symlink(&temp.0, writer.staging_path().join("data/escape"))
            .unwrap_or_else(|error| panic!("symlink: {error}"));
        let result = writer.seal(
            &SigningKey::from_bytes(&[9_u8; 32]),
            &SealOptions {
                created_at_utc: "2026-01-15T08:00:10.000Z".to_owned(),
                bagging_date: "2026-01-15".to_owned(),
                software_agent: "test".to_owned(),
                source_organization: "test".to_owned(),
                key_id: "test-key".to_owned(),
                synthetic_key: true,
            },
        );
        assert!(matches!(result, Err(WaebError::SymlinkForbidden(_))));
    }
}
