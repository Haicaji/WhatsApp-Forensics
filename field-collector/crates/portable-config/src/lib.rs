//! Strict loader for Workstation-provisioned Field Collector USB bundles.
//!
//! Configuration is resolved only relative to the running executable. The
//! Workstation signature is provisionally checked before key unlock; the trust
//! anchor becomes authenticated only after the encrypted operator key confirms
//! the same Workstation fingerprint.

mod jcs;

#[cfg(any(test, feature = "provisioning"))]
pub mod provisioning;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, Utc};
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, VerifyingKey};
use portable_keystore::{KeystoreBinding, KeystoreError, UnlockedKeystore, inspect, unlock};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const ROOT_SCHEMA: &str = "wafc-portable/1";
const PROFILE_SCHEMA: &str = "wafc-operator-profile/1";
const TRUST_SCHEMA: &str = "wafc-workstation-trust/1";
const ASSIGNMENT_SCHEMA: &str = "wafc-assignment/1";
const MANIFEST_SCHEMA: &str = "wafc-portable-bundle-manifest/1";
const LAYOUT: &str = "wafc-usb-v1";
const ASSIGNMENT_DOMAIN: &[u8] = b"WAFC-ASSIGNMENT-v1\0";
const MANIFEST_DOMAIN: &[u8] = b"WAFC-BUNDLE-MANIFEST-v1\0";
const MAX_JSON_BYTES: u64 = 1024 * 1024;
const MAX_KEYSTORE_BYTES: u64 = 64 * 1024;
const ROOT_MARKER: &str = "wafc-portable.json";
const PROFILE_PATH: &str = "config/operator-profile.json";
const KEY_PATH: &str = "config/operator-key.enc";
const TRUST_PATH: &str = "config/workstation-trust.json";
const MANIFEST_PATH: &str = "config/bundle-manifest.json";
const ASSIGNMENTS_DIR: &str = "assignments";
const STAGING_DIR: &str = "evidence/staging";
const SEALED_DIR: &str = "evidence/sealed";
const HANDOFF_DIR: &str = "handoff";
const DIAGNOSTICS_DIR: &str = "diagnostics";

/// Fail-closed errors from portable configuration discovery and validation.
#[derive(Debug, Error)]
pub enum PortableConfigError {
    /// A fixed file or directory is missing, unsafe, or has the wrong type.
    #[error("unsafe portable layout: {0}")]
    UnsafeLayout(String),
    /// A strict JSON document or cross-document field is invalid.
    #[error("invalid portable configuration: {0}")]
    InvalidDocument(String),
    /// A configured file differs from the Workstation-signed manifest.
    #[error("portable bundle integrity check failed: {0}")]
    Integrity(String),
    /// A Workstation or assignment signature is invalid.
    #[error("portable configuration signature check failed: {0}")]
    Signature(String),
    /// The selected task is expired, not yet valid, or unknown.
    #[error("assignment is not currently authorised: {0}")]
    AssignmentUnavailable(String),
    /// The encrypted operator key does not authenticate this bundle identity.
    #[error("operator key binding does not match the portable bundle")]
    KeyBindingMismatch,
    /// File I/O failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Strict JSON parsing failed.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// Encrypted keystore handling failed.
    #[error(transparent)]
    Keystore(#[from] KeystoreError),
}

/// Fixed paths declared by `wafc-portable.json`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortablePathDocument {
    /// Workstation-signed manifest path.
    pub manifest: String,
    /// Read-only operator profile path.
    pub operator_profile: String,
    /// Password-encrypted evidence-signing key path.
    pub operator_key: String,
    /// Workstation public-key record path.
    pub workstation_trust: String,
    /// Signed assignment directory.
    pub assignments: String,
    /// Unsealed acquisition staging directory.
    pub evidence_staging: String,
    /// Independently verified evidence destination.
    pub evidence_sealed: String,
    /// Non-content handoff summary directory.
    pub handoff: String,
    /// Non-evidence diagnostic directory.
    pub diagnostics: String,
}

/// Root marker located beside `field-collector.exe`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableRootDocument {
    /// Contract version.
    pub schema_version: String,
    /// Fixed directory-layout identifier.
    pub layout: String,
    /// One Workstation-provisioned portable bundle identity.
    pub bundle_id: Uuid,
    /// Fixed relative paths. Arbitrary paths are not accepted.
    pub paths: PortablePathDocument,
}

/// Read-only field operator identity.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorProfile {
    /// Contract version.
    pub schema_version: String,
    /// Stable operator identifier.
    pub operator_id: String,
    /// Human-readable display name.
    pub display_name: String,
    /// Operator organization.
    pub organization: String,
    /// Evidence-signing key identifier.
    pub key_id: String,
    /// Registered evidence-signing public-key fingerprint.
    pub evidence_signing_key_fingerprint_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkstationTrust {
    schema_version: String,
    workstation_id: String,
    key_id: String,
    algorithm: String,
    encoding: String,
    public_key_spki_base64: String,
    fingerprint_sha256: String,
}

/// Workstation-signed task fields displayed to the operator.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentPayload {
    /// Stable task identifier.
    pub assignment_id: String,
    /// Case or authority reference.
    pub authorization_reference: String,
    /// Assigned operator.
    pub operator_id: String,
    /// Only evidence-signing key permitted for this task.
    pub allowed_key_id: String,
    /// Organization recorded in the evidence package.
    pub source_organization: String,
    /// Workstation issue time.
    pub issued_at_utc: String,
    /// Inclusive validity start.
    pub valid_from_utc: String,
    /// Exclusive validity end.
    pub valid_until_utc: String,
    /// v1 accepts only `passive_t0`.
    pub acquisition_mode: String,
    /// Human-readable, signed target description.
    pub target_description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignatureDocument {
    algorithm: String,
    key_id: String,
    payload_sha256: String,
    signature_base64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignmentDocument {
    schema_version: String,
    payload: AssignmentPayload,
    signature: SignatureDocument,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestPayload {
    bundle_id: Uuid,
    created_at_utc: String,
    operator_id: String,
    operator_key_id: String,
    workstation_key_id: String,
    files: Vec<ManifestFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleManifest {
    schema_version: String,
    payload: ManifestPayload,
    signature: SignatureDocument,
}

/// One verified assignment and its signed-file digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortableAssignment {
    /// Signed assignment payload.
    pub payload: AssignmentPayload,
    /// Lowercase SHA-256 of the complete assignment document.
    pub document_sha256: String,
    valid_from: DateTime<Utc>,
    valid_until: DateTime<Utc>,
}

impl PortableAssignment {
    /// Returns whether the task is valid at `now`.
    #[must_use]
    pub fn is_valid_at(&self, now: DateTime<Utc>) -> bool {
        now >= self.valid_from && now < self.valid_until
    }
}

/// Canonical, safe paths under the executable-relative portable root.
#[derive(Clone, Debug)]
pub struct ResolvedPortablePaths {
    /// Canonical portable root.
    pub root: PathBuf,
    /// Encrypted operator key.
    pub operator_key: PathBuf,
    /// Acquisition staging directory.
    pub evidence_staging: PathBuf,
    /// Verified Evidence Bag directory.
    pub evidence_sealed: PathBuf,
    /// Handoff summary directory.
    pub handoff: PathBuf,
    /// Diagnostics directory.
    pub diagnostics: PathBuf,
}

/// Provisionally verified portable bundle.
///
/// The Workstation signature and every file hash are valid, but the Workstation
/// trust anchor is not authenticated until [`Self::unlock_operator_key`] also
/// verifies the binding inside the encrypted operator key.
pub struct PortableBundle {
    root_document: PortableRootDocument,
    profile: OperatorProfile,
    trust: WorkstationTrust,
    assignments: Vec<PortableAssignment>,
    manifest_sha256: String,
    paths: ResolvedPortablePaths,
}

impl PortableBundle {
    /// Locates the portable root strictly beside the supplied executable.
    ///
    /// # Errors
    ///
    /// Returns an error for an unsafe executable/root path or any invalid bundle.
    pub fn load_from_executable(
        executable: &Path,
        now: DateTime<Utc>,
    ) -> Result<Self, PortableConfigError> {
        ensure_no_reparse_path(executable)?;
        ensure_real_file(executable, u64::MAX)?;
        let executable = fs::canonicalize(executable)?;
        let root = executable.parent().ok_or_else(|| {
            PortableConfigError::UnsafeLayout("executable has no parent directory".to_owned())
        })?;
        Self::load_from_root(root, now)
    }

    /// Loads a portable root. This explicit-root entry point exists for tests
    /// and Workstation-side validation; production should use
    /// [`Self::load_from_executable`].
    ///
    /// # Errors
    ///
    /// Returns an error for unsafe paths, malformed files, invalid signatures,
    /// hash mismatches, assignment ownership mismatches, or unsupported fields.
    pub fn load_from_root(root: &Path, now: DateTime<Utc>) -> Result<Self, PortableConfigError> {
        ensure_no_reparse_path(root)?;
        ensure_real_directory(root)?;
        let root = fs::canonicalize(root)?;
        ensure_no_reparse_path(&root)?;
        ensure_real_directory(&root)?;

        let marker_bytes = read_relative(&root, ROOT_MARKER, MAX_JSON_BYTES)?;
        let root_document: PortableRootDocument = serde_json::from_slice(&marker_bytes)?;
        validate_root_document(&root_document)?;

        let trust_bytes = read_relative(&root, TRUST_PATH, MAX_JSON_BYTES)?;
        let trust: WorkstationTrust = serde_json::from_slice(&trust_bytes)?;
        let verifying_key = validate_trust(&trust)?;

        let manifest_bytes = read_relative(&root, MANIFEST_PATH, MAX_JSON_BYTES)?;
        let manifest_sha256 = sha256_hex(&manifest_bytes);
        let manifest: BundleManifest = serde_json::from_slice(&manifest_bytes)?;
        validate_manifest_signature(&manifest, &trust, &verifying_key)?;
        validate_manifest_files(&root, &manifest)?;

        let profile_bytes = read_relative(&root, PROFILE_PATH, MAX_JSON_BYTES)?;
        let profile: OperatorProfile = serde_json::from_slice(&profile_bytes)?;
        validate_profile(&profile)?;
        validate_cross_document(&root_document, &profile, &trust, &manifest)?;

        let inspected = inspect(&root.join(KEY_PATH))?;
        if inspected.public_key_fingerprint_sha256
            != profile.evidence_signing_key_fingerprint_sha256
        {
            return Err(PortableConfigError::Integrity(
                "operator profile fingerprint differs from signed keystore".to_owned(),
            ));
        }

        let assignments = load_assignments(&root, &manifest, &profile, &trust, &verifying_key)?;
        if assignments.is_empty() {
            return Err(PortableConfigError::InvalidDocument(
                "portable bundle contains no assignments".to_owned(),
            ));
        }
        if !assignments
            .iter()
            .any(|assignment| assignment.is_valid_at(now))
        {
            return Err(PortableConfigError::AssignmentUnavailable(
                "no assignment is valid at the current UTC time".to_owned(),
            ));
        }

        let paths = resolved_paths(&root)?;
        Ok(Self {
            root_document,
            profile,
            trust,
            assignments,
            manifest_sha256,
            paths,
        })
    }

    /// Read-only operator identity authenticated after key unlock.
    #[must_use]
    pub const fn profile(&self) -> &OperatorProfile {
        &self.profile
    }

    /// Portable bundle UUID.
    #[must_use]
    pub const fn bundle_id(&self) -> Uuid {
        self.root_document.bundle_id
    }

    /// Workstation manifest digest recorded in acquisition metadata.
    #[must_use]
    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    /// Workstation public-key fingerprint. The full key must not enter evidence.
    #[must_use]
    pub fn workstation_key_fingerprint_sha256(&self) -> &str {
        &self.trust.fingerprint_sha256
    }

    /// Safe executable-relative output paths.
    #[must_use]
    pub const fn paths(&self) -> &ResolvedPortablePaths {
        &self.paths
    }

    /// Iterates only assignments valid at `now`.
    pub fn valid_assignments_at(
        &self,
        now: DateTime<Utc>,
    ) -> impl Iterator<Item = &PortableAssignment> {
        self.assignments
            .iter()
            .filter(move |assignment| assignment.is_valid_at(now))
    }

    /// Selects one valid task by exact identifier.
    ///
    /// # Errors
    ///
    /// Returns an error for unknown, expired, or not-yet-valid assignments.
    pub fn assignment_at(
        &self,
        assignment_id: &str,
        now: DateTime<Utc>,
    ) -> Result<&PortableAssignment, PortableConfigError> {
        let assignment = self
            .assignments
            .iter()
            .find(|assignment| assignment.payload.assignment_id == assignment_id)
            .ok_or_else(|| PortableConfigError::AssignmentUnavailable("unknown task".to_owned()))?;
        if !assignment.is_valid_at(now) {
            return Err(PortableConfigError::AssignmentUnavailable(
                "task is expired or not yet valid".to_owned(),
            ));
        }
        Ok(assignment)
    }

    /// Unlocks the operator key and authenticates the Workstation trust binding.
    ///
    /// # Errors
    ///
    /// Returns an error for a bad passphrase, corrupt key, or any operator/key/
    /// Workstation binding mismatch.
    pub fn unlock_operator_key(
        &self,
        passphrase: &str,
    ) -> Result<UnlockedKeystore, PortableConfigError> {
        let unlocked = unlock(&self.paths.operator_key, passphrase)?;
        let expected = KeystoreBinding {
            operator_id: self.profile.operator_id.clone(),
            key_id: self.profile.key_id.clone(),
            workstation_key_fingerprint_sha256: self.trust.fingerprint_sha256.clone(),
        };
        if unlocked.binding != expected {
            return Err(PortableConfigError::KeyBindingMismatch);
        }
        Ok(unlocked)
    }
}

fn fixed_paths() -> PortablePathDocument {
    PortablePathDocument {
        manifest: MANIFEST_PATH.to_owned(),
        operator_profile: PROFILE_PATH.to_owned(),
        operator_key: KEY_PATH.to_owned(),
        workstation_trust: TRUST_PATH.to_owned(),
        assignments: ASSIGNMENTS_DIR.to_owned(),
        evidence_staging: STAGING_DIR.to_owned(),
        evidence_sealed: SEALED_DIR.to_owned(),
        handoff: HANDOFF_DIR.to_owned(),
        diagnostics: DIAGNOSTICS_DIR.to_owned(),
    }
}

fn validate_root_document(document: &PortableRootDocument) -> Result<(), PortableConfigError> {
    if document.schema_version != ROOT_SCHEMA
        || document.layout != LAYOUT
        || document.paths != fixed_paths()
    {
        return Err(PortableConfigError::InvalidDocument(
            "portable marker version or fixed paths differ from v1".to_owned(),
        ));
    }
    Ok(())
}

fn validate_profile(profile: &OperatorProfile) -> Result<(), PortableConfigError> {
    if profile.schema_version != PROFILE_SCHEMA
        || !valid_identifier(&profile.operator_id)
        || !valid_identifier(&profile.key_id)
        || profile.display_name.is_empty()
        || profile.display_name.len() > 120
        || profile.organization.is_empty()
        || profile.organization.len() > 240
        || !valid_fingerprint(&profile.evidence_signing_key_fingerprint_sha256)
        || contains_control(&profile.display_name)
        || contains_control(&profile.organization)
    {
        return Err(PortableConfigError::InvalidDocument(
            "operator profile fields are invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_trust(trust: &WorkstationTrust) -> Result<VerifyingKey, PortableConfigError> {
    if trust.schema_version != TRUST_SCHEMA
        || trust.algorithm != "Ed25519"
        || trust.encoding != "spki-der"
        || !valid_identifier(&trust.workstation_id)
        || !valid_identifier(&trust.key_id)
        || !valid_fingerprint(&trust.fingerprint_sha256)
    {
        return Err(PortableConfigError::InvalidDocument(
            "Workstation trust record is invalid".to_owned(),
        ));
    }
    let der = BASE64.decode(&trust.public_key_spki_base64).map_err(|_| {
        PortableConfigError::InvalidDocument("Workstation public key is not base64".to_owned())
    })?;
    let actual = format!("sha256:{}", sha256_hex(&der));
    if actual != trust.fingerprint_sha256 {
        return Err(PortableConfigError::Integrity(
            "Workstation public-key fingerprint mismatch".to_owned(),
        ));
    }
    VerifyingKey::from_public_key_der(&der).map_err(|_| {
        PortableConfigError::InvalidDocument(
            "Workstation public key is not Ed25519 SPKI".to_owned(),
        )
    })
}

fn validate_manifest_signature(
    manifest: &BundleManifest,
    trust: &WorkstationTrust,
    verifying_key: &VerifyingKey,
) -> Result<(), PortableConfigError> {
    if manifest.schema_version != MANIFEST_SCHEMA
        || manifest.signature.key_id != trust.key_id
        || manifest.payload.workstation_key_id != trust.key_id
    {
        return Err(PortableConfigError::InvalidDocument(
            "bundle manifest identity or version is invalid".to_owned(),
        ));
    }
    verify_signature(
        &manifest.payload,
        &manifest.signature,
        MANIFEST_DOMAIN,
        verifying_key,
    )
}

fn validate_manifest_files(
    root: &Path,
    manifest: &BundleManifest,
) -> Result<(), PortableConfigError> {
    if manifest.payload.files.len() < 5 || manifest.payload.files.len() > 1000 {
        return Err(PortableConfigError::InvalidDocument(
            "manifest file count is outside v1 limits".to_owned(),
        ));
    }
    let mut previous: Option<&str> = None;
    let mut listed = BTreeSet::new();
    for entry in &manifest.payload.files {
        validate_manifest_path(&entry.path)?;
        if previous.is_some_and(|value| value >= entry.path.as_str())
            || !listed.insert(entry.path.clone())
        {
            return Err(PortableConfigError::InvalidDocument(
                "manifest paths must be unique and sorted".to_owned(),
            ));
        }
        previous = Some(&entry.path);
        let limit = if entry.path == KEY_PATH {
            MAX_KEYSTORE_BYTES
        } else {
            MAX_JSON_BYTES
        };
        let bytes = read_relative(root, &entry.path, limit)?;
        if entry.bytes != u64::try_from(bytes.len()).unwrap_or(u64::MAX)
            || entry.sha256 != sha256_hex(&bytes)
        {
            return Err(PortableConfigError::Integrity(format!(
                "manifest size or hash mismatch for {}",
                entry.path
            )));
        }
    }
    for required in [ROOT_MARKER, PROFILE_PATH, KEY_PATH, TRUST_PATH] {
        if !listed.contains(required) {
            return Err(PortableConfigError::InvalidDocument(format!(
                "manifest omitted required file {required}"
            )));
        }
    }

    let assignments = actual_assignment_paths(root)?;
    let listed_assignments = listed
        .iter()
        .filter(|path| path.starts_with("assignments/"))
        .cloned()
        .collect::<BTreeSet<_>>();
    if assignments != listed_assignments {
        return Err(PortableConfigError::Integrity(
            "assignment directory differs from signed manifest".to_owned(),
        ));
    }
    validate_config_directory(root)?;
    Ok(())
}

fn validate_cross_document(
    root: &PortableRootDocument,
    profile: &OperatorProfile,
    trust: &WorkstationTrust,
    manifest: &BundleManifest,
) -> Result<(), PortableConfigError> {
    if manifest.payload.bundle_id != root.bundle_id
        || manifest.payload.operator_id != profile.operator_id
        || manifest.payload.operator_key_id != profile.key_id
        || manifest.payload.workstation_key_id != trust.key_id
        || parse_utc(&manifest.payload.created_at_utc).is_err()
    {
        return Err(PortableConfigError::Integrity(
            "portable marker, profile, trust, and manifest identities differ".to_owned(),
        ));
    }
    Ok(())
}

fn load_assignments(
    root: &Path,
    manifest: &BundleManifest,
    profile: &OperatorProfile,
    trust: &WorkstationTrust,
    verifying_key: &VerifyingKey,
) -> Result<Vec<PortableAssignment>, PortableConfigError> {
    let file_hashes = manifest
        .payload
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut assignments = Vec::new();
    for (path, document_sha256) in file_hashes
        .into_iter()
        .filter(|(path, _)| path.starts_with("assignments/"))
    {
        let bytes = read_relative(root, path, MAX_JSON_BYTES)?;
        let document: AssignmentDocument = serde_json::from_slice(&bytes)?;
        if document.schema_version != ASSIGNMENT_SCHEMA
            || document.signature.key_id != trust.key_id
            || document.payload.operator_id != profile.operator_id
            || document.payload.allowed_key_id != profile.key_id
            || document.payload.acquisition_mode != "passive_t0"
            || !valid_identifier(&document.payload.assignment_id)
            || document.payload.authorization_reference.is_empty()
            || document.payload.authorization_reference.len() > 240
            || document.payload.source_organization.is_empty()
            || document.payload.source_organization.len() > 240
            || document.payload.target_description.is_empty()
            || document.payload.target_description.len() > 500
            || contains_control(&document.payload.authorization_reference)
            || contains_control(&document.payload.source_organization)
            || contains_control(&document.payload.target_description)
            || path != format!("assignments/{}.json", document.payload.assignment_id)
        {
            return Err(PortableConfigError::InvalidDocument(format!(
                "assignment fields are invalid in {path}"
            )));
        }
        verify_signature(
            &document.payload,
            &document.signature,
            ASSIGNMENT_DOMAIN,
            verifying_key,
        )?;
        let issued = parse_utc(&document.payload.issued_at_utc)?;
        let valid_from = parse_utc(&document.payload.valid_from_utc)?;
        let valid_until = parse_utc(&document.payload.valid_until_utc)?;
        if issued > valid_from || valid_from >= valid_until {
            return Err(PortableConfigError::InvalidDocument(format!(
                "assignment validity window is invalid in {path}"
            )));
        }
        assignments.push(PortableAssignment {
            payload: document.payload,
            document_sha256: document_sha256.to_owned(),
            valid_from,
            valid_until,
        });
    }
    assignments.sort_by(|left, right| left.payload.assignment_id.cmp(&right.payload.assignment_id));
    if assignments
        .windows(2)
        .any(|pair| pair[0].payload.assignment_id == pair[1].payload.assignment_id)
    {
        return Err(PortableConfigError::InvalidDocument(
            "duplicate assignment ID".to_owned(),
        ));
    }
    Ok(assignments)
}

fn verify_signature<T: Serialize>(
    payload: &T,
    signature: &SignatureDocument,
    domain: &[u8],
    verifying_key: &VerifyingKey,
) -> Result<(), PortableConfigError> {
    if signature.algorithm != "Ed25519"
        || !valid_identifier(&signature.key_id)
        || !valid_sha256(&signature.payload_sha256)
    {
        return Err(PortableConfigError::InvalidDocument(
            "signature envelope is invalid".to_owned(),
        ));
    }
    let value = serde_json::to_value(payload)?;
    let canonical = jcs::canonicalize(&value)?;
    if sha256_hex(&canonical) != signature.payload_sha256 {
        return Err(PortableConfigError::Integrity(
            "signed payload digest mismatch".to_owned(),
        ));
    }
    let decoded = BASE64.decode(&signature.signature_base64).map_err(|_| {
        PortableConfigError::InvalidDocument("signature is not canonical base64".to_owned())
    })?;
    if BASE64.encode(&decoded) != signature.signature_base64 {
        return Err(PortableConfigError::InvalidDocument(
            "signature base64 is not canonical".to_owned(),
        ));
    }
    let signature_bytes: [u8; 64] = decoded.try_into().map_err(|_| {
        PortableConfigError::InvalidDocument("Ed25519 signature length is invalid".to_owned())
    })?;
    let mut signed = Vec::with_capacity(domain.len() + canonical.len());
    signed.extend_from_slice(domain);
    signed.extend_from_slice(&canonical);
    verifying_key
        .verify_strict(&signed, &Signature::from_bytes(&signature_bytes))
        .map_err(|_| PortableConfigError::Signature("Ed25519 verification failed".to_owned()))
}

fn resolved_paths(root: &Path) -> Result<ResolvedPortablePaths, PortableConfigError> {
    for relative in [
        "config",
        ASSIGNMENTS_DIR,
        "evidence",
        STAGING_DIR,
        SEALED_DIR,
        HANDOFF_DIR,
        DIAGNOSTICS_DIR,
    ] {
        ensure_real_directory(&safe_relative(root, relative)?)?;
    }
    Ok(ResolvedPortablePaths {
        root: root.to_path_buf(),
        operator_key: safe_relative(root, KEY_PATH)?,
        evidence_staging: safe_relative(root, STAGING_DIR)?,
        evidence_sealed: safe_relative(root, SEALED_DIR)?,
        handoff: safe_relative(root, HANDOFF_DIR)?,
        diagnostics: safe_relative(root, DIAGNOSTICS_DIR)?,
    })
}

fn validate_manifest_path(path: &str) -> Result<(), PortableConfigError> {
    let valid_fixed = matches!(path, ROOT_MARKER | PROFILE_PATH | KEY_PATH | TRUST_PATH);
    let valid_assignment = path
        .strip_prefix("assignments/assignment-")
        .and_then(|suffix| suffix.strip_suffix(".json"))
        .is_some_and(|value| {
            !value.is_empty()
                && value.len() <= 180
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        });
    if valid_fixed || valid_assignment {
        Ok(())
    } else {
        Err(PortableConfigError::InvalidDocument(format!(
            "manifest path is outside the portable allowlist: {path}"
        )))
    }
}

fn actual_assignment_paths(root: &Path) -> Result<BTreeSet<String>, PortableConfigError> {
    let directory = safe_relative(root, ASSIGNMENTS_DIR)?;
    ensure_real_directory(&directory)?;
    let mut paths = BTreeSet::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        ensure_real_file(&entry.path(), MAX_JSON_BYTES)?;
        let name = entry.file_name().into_string().map_err(|_| {
            PortableConfigError::UnsafeLayout("assignment filename is not UTF-8".to_owned())
        })?;
        let relative = format!("assignments/{name}");
        validate_manifest_path(&relative)?;
        if !paths.insert(relative) {
            return Err(PortableConfigError::UnsafeLayout(
                "duplicate assignment path".to_owned(),
            ));
        }
    }
    Ok(paths)
}

fn validate_config_directory(root: &Path) -> Result<(), PortableConfigError> {
    let config = safe_relative(root, "config")?;
    ensure_real_directory(&config)?;
    let expected = [
        "bundle-manifest.json",
        "operator-key.enc",
        "operator-profile.json",
        "workstation-trust.json",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let mut actual = BTreeSet::new();
    for entry in fs::read_dir(&config)? {
        let entry = entry?;
        ensure_real_file(&entry.path(), MAX_JSON_BYTES)?;
        let name = entry.file_name().into_string().map_err(|_| {
            PortableConfigError::UnsafeLayout("config filename is not UTF-8".to_owned())
        })?;
        actual.insert(name);
    }
    if actual.iter().map(String::as_str).collect::<BTreeSet<_>>() != expected {
        return Err(PortableConfigError::UnsafeLayout(
            "config directory contains missing or unexpected files".to_owned(),
        ));
    }
    Ok(())
}

fn read_relative(
    root: &Path,
    relative: &str,
    maximum: u64,
) -> Result<Vec<u8>, PortableConfigError> {
    let path = safe_relative(root, relative)?;
    ensure_real_file(&path, maximum)?;
    let mut file = File::open(&path)?;
    let length = file.metadata()?.len();
    let capacity = usize::try_from(length).map_err(|_| {
        PortableConfigError::UnsafeLayout("portable file length is not addressable".to_owned())
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn safe_relative(root: &Path, relative: &str) -> Result<PathBuf, PortableConfigError> {
    if relative.is_empty()
        || relative.contains(['\\', ':', '\0'])
        || Path::new(relative).is_absolute()
        || Path::new(relative)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PortableConfigError::UnsafeLayout(format!(
            "unsafe relative path: {relative}"
        )));
    }
    let mut path = root.to_path_buf();
    for component in relative.split('/') {
        path.push(component);
    }
    Ok(path)
}

fn ensure_real_directory(path: &Path) -> Result<(), PortableConfigError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        PortableConfigError::UnsafeLayout(format!("{}: {error}", path.display()))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
        return Err(PortableConfigError::UnsafeLayout(format!(
            "{} must be a real non-reparse directory",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_no_reparse_path(path: &Path) -> Result<(), PortableConfigError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            PortableConfigError::UnsafeLayout(format!("{}: {error}", current.display()))
        })?;
        if metadata.file_type().is_symlink() || is_reparse(&metadata) {
            return Err(PortableConfigError::UnsafeLayout(format!(
                "{} contains a symlink or Windows reparse point",
                path.display()
            )));
        }
    }
    Ok(())
}

fn ensure_real_file(path: &Path, maximum: u64) -> Result<(), PortableConfigError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        PortableConfigError::UnsafeLayout(format!("{}: {error}", path.display()))
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || is_reparse(&metadata)
        || metadata.len() > maximum
    {
        return Err(PortableConfigError::UnsafeLayout(format!(
            "{} must be a bounded real non-reparse file",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn valid_identifier(value: &str) -> bool {
    (3..=120).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn valid_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(valid_sha256)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn contains_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn parse_utc(value: &str) -> Result<DateTime<Utc>, PortableConfigError> {
    if !value.ends_with('Z') || value.len() > 40 {
        return Err(PortableConfigError::InvalidDocument(
            "timestamp must be bounded UTC RFC 3339".to_owned(),
        ));
    }
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| PortableConfigError::InvalidDocument("invalid UTC timestamp".to_owned()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use ed25519_dalek::SigningKey;
    use ed25519_dalek::pkcs8::EncodePublicKey;
    use serde::Serialize;
    use serde_json::Value;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("wafc-{label}-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap_or_else(|error| panic!("create temp root: {error}"));
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn instant(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 8, hour, 0, 0)
            .single()
            .unwrap_or_else(|| panic!("valid test timestamp"))
    }

    fn provisioned(root: &Path) -> provisioning::ProvisionedBundle {
        let workstation = SigningKey::from_bytes(&[7_u8; 32]);
        let request = provisioning::ProvisionRequest {
            root,
            bundle_id: Uuid::new_v4(),
            operator_id: "operator_001".to_owned(),
            operator_display_name: "现场勘察员 A".to_owned(),
            operator_organization: "测试取证实验室".to_owned(),
            operator_key_id: "operator-key-001".to_owned(),
            workstation_id: "analysis-workstation-001".to_owned(),
            workstation_key_id: "workstation-config-key-001".to_owned(),
            workstation_signing_key: &workstation,
            operator_key_passphrase: "correct horse battery staple",
            assignments: vec![provisioning::AssignmentTemplate {
                assignment_id: "assignment-001".to_owned(),
                authorization_reference: "CASE-2026-001".to_owned(),
                source_organization: "测试取证实验室".to_owned(),
                issued_at_utc: instant(0),
                valid_from_utc: instant(1),
                valid_until_utc: instant(23),
                target_description: "授权的 WhatsApp Web 页面".to_owned(),
            }],
            created_at_utc: instant(0),
        };
        provisioning::provision(&request).unwrap_or_else(|error| panic!("provision: {error}"))
    }

    fn write_json<T: Serialize>(path: &Path, value: &T) {
        let mut bytes = serde_json::to_vec_pretty(value)
            .unwrap_or_else(|error| panic!("serialize {}: {error}", path.display()));
        bytes.push(b'\n');
        fs::write(path, bytes).unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
    }

    fn refresh_manifest(root: &Path, signing_key: &SigningKey) {
        let path = root.join(MANIFEST_PATH);
        let mut manifest: BundleManifest = serde_json::from_slice(
            &fs::read(&path).unwrap_or_else(|error| panic!("read manifest: {error}")),
        )
        .unwrap_or_else(|error| panic!("parse manifest: {error}"));
        for file in &mut manifest.payload.files {
            let file_path = safe_relative(root, &file.path)
                .unwrap_or_else(|error| panic!("safe manifest path {}: {error}", file.path));
            let bytes = fs::read(file_path)
                .unwrap_or_else(|error| panic!("read manifest payload {}: {error}", file.path));
            file.bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
            file.sha256 = sha256_hex(&bytes);
        }
        manifest.signature = provisioning::sign_payload(
            &manifest.payload,
            MANIFEST_DOMAIN,
            &manifest.payload.workstation_key_id,
            signing_key,
        )
        .unwrap_or_else(|error| panic!("sign manifest: {error}"));
        write_json(&path, &manifest);
    }

    fn tamper_one_byte(path: &Path) {
        let mut bytes =
            fs::read(path).unwrap_or_else(|error| panic!("read tamper target: {error}"));
        let position = bytes
            .iter()
            .position(u8::is_ascii_alphanumeric)
            .unwrap_or_else(|| panic!("tamper target has no ASCII byte"));
        bytes[position] ^= 1;
        fs::write(path, bytes).unwrap_or_else(|error| panic!("write tamper target: {error}"));
    }

    #[test]
    fn fixed_paths_reject_drive_letter_and_traversal() {
        let root = Path::new("portable-root");
        assert!(safe_relative(root, "config/operator-profile.json").is_ok());
        for invalid in ["../config.json", "C:/config.json", "config\\key", "/root"] {
            assert!(safe_relative(root, invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn identifiers_and_fingerprints_are_canonical() {
        assert!(valid_identifier("operator_001"));
        assert!(!valid_identifier("Operator A"));
        assert!(valid_fingerprint(&format!("sha256:{}", "a".repeat(64))));
        assert!(!valid_fingerprint(&format!("sha256:{}", "A".repeat(64))));
    }

    #[test]
    fn jcs_is_order_independent_and_rejects_floats() {
        let left: Value = serde_json::from_str(r#"{"b":2,"a":1}"#)
            .unwrap_or_else(|error| panic!("parse: {error}"));
        let right: Value = serde_json::from_str(r#"{"a":1,"b":2}"#)
            .unwrap_or_else(|error| panic!("parse: {error}"));
        assert_eq!(
            jcs::canonicalize(&left).unwrap_or_else(|error| panic!("jcs: {error}")),
            jcs::canonicalize(&right).unwrap_or_else(|error| panic!("jcs: {error}"))
        );
        let float: Value =
            serde_json::from_str("1.25").unwrap_or_else(|error| panic!("parse: {error}"));
        assert!(jcs::canonicalize(&float).is_err());
    }

    #[test]
    fn provision_load_move_and_unlock_round_trip() {
        let first = TempRoot::new("portable-roundtrip");
        let provisioned = provisioned(&first.0);
        assert_eq!(
            provisioned.root,
            fs::canonicalize(&first.0).unwrap_or_default()
        );
        let moved = std::env::temp_dir().join(format!("wafc-moved-{}", Uuid::new_v4()));
        fs::rename(&first.0, &moved).unwrap_or_else(|error| panic!("move root: {error}"));
        let mut first = first;
        first.0 = moved.clone();

        let bundle = PortableBundle::load_from_root(&moved, instant(12))
            .unwrap_or_else(|error| panic!("load: {error}"));
        assert_eq!(bundle.profile().operator_id, "operator_001");
        assert_eq!(bundle.valid_assignments_at(instant(12)).count(), 1);
        let unlocked = bundle
            .unlock_operator_key("correct horse battery staple")
            .unwrap_or_else(|error| panic!("unlock: {error}"));
        assert_eq!(unlocked.binding.operator_id, "operator_001");
        assert_eq!(
            unlocked.binding.workstation_key_fingerprint_sha256,
            bundle.workstation_key_fingerprint_sha256()
        );
        assert!(bundle.paths().evidence_staging.is_dir());
        assert!(bundle.paths().evidence_sealed.is_dir());
        assert!(bundle.paths().handoff.is_dir());
    }

    #[test]
    fn one_byte_assignment_tamper_and_expired_task_are_rejected() {
        let root = TempRoot::new("portable-tamper");
        let _ = provisioned(&root.0);
        let assignment = root.0.join("assignments").join("assignment-001.json");
        let mut bytes = fs::read(&assignment).unwrap_or_else(|error| panic!("read: {error}"));
        let position = bytes
            .iter()
            .position(|byte| *byte == b'C')
            .unwrap_or_else(|| panic!("fixture contains C"));
        bytes[position] = b'X';
        fs::write(&assignment, bytes).unwrap_or_else(|error| panic!("write: {error}"));
        assert!(PortableBundle::load_from_root(&root.0, instant(12)).is_err());

        let expired = TempRoot::new("portable-expired");
        let _ = provisioned(&expired.0);
        assert!(matches!(
            PortableBundle::load_from_root(&expired.0, instant(23)),
            Err(PortableConfigError::AssignmentUnavailable(_))
        ));
    }

    #[test]
    fn every_signed_configuration_class_rejects_one_byte_tamper() {
        for (label, relative) in [
            ("profile", PROFILE_PATH),
            ("operator-key", KEY_PATH),
            ("workstation-trust", TRUST_PATH),
            ("bundle-manifest", MANIFEST_PATH),
        ] {
            let root = TempRoot::new(label);
            let _ = provisioned(&root.0);
            let target = safe_relative(&root.0, relative)
                .unwrap_or_else(|error| panic!("safe tamper path: {error}"));
            tamper_one_byte(&target);
            assert!(
                PortableBundle::load_from_root(&root.0, instant(12)).is_err(),
                "tampered {label} was accepted"
            );
        }
    }

    #[test]
    fn a_resigned_assignment_for_another_operator_is_rejected() {
        let root = TempRoot::new("portable-wrong-operator");
        let _ = provisioned(&root.0);
        let workstation = SigningKey::from_bytes(&[7_u8; 32]);
        let path = root.0.join("assignments/assignment-001.json");
        let mut assignment: AssignmentDocument = serde_json::from_slice(
            &fs::read(&path).unwrap_or_else(|error| panic!("read assignment: {error}")),
        )
        .unwrap_or_else(|error| panic!("parse assignment: {error}"));
        assignment.payload.operator_id = "operator_002".to_owned();
        assignment.signature = provisioning::sign_payload(
            &assignment.payload,
            ASSIGNMENT_DOMAIN,
            &assignment.signature.key_id,
            &workstation,
        )
        .unwrap_or_else(|error| panic!("sign assignment: {error}"));
        write_json(&path, &assignment);
        refresh_manifest(&root.0, &workstation);
        assert!(matches!(
            PortableBundle::load_from_root(&root.0, instant(12)),
            Err(PortableConfigError::InvalidDocument(_))
        ));
    }

    #[test]
    fn substituted_workstation_trust_is_rejected_after_key_unlock() {
        let root = TempRoot::new("portable-fake-workstation");
        let _ = provisioned(&root.0);
        let fake = SigningKey::from_bytes(&[9_u8; 32]);
        let fake_spki = fake
            .verifying_key()
            .to_public_key_der()
            .unwrap_or_else(|error| panic!("fake SPKI: {error}"));
        let fake_fingerprint = format!("sha256:{}", sha256_hex(fake_spki.as_bytes()));
        let trust_path = safe_relative(&root.0, TRUST_PATH)
            .unwrap_or_else(|error| panic!("safe trust path: {error}"));
        let mut trust: WorkstationTrust = serde_json::from_slice(
            &fs::read(&trust_path).unwrap_or_else(|error| panic!("read trust: {error}")),
        )
        .unwrap_or_else(|error| panic!("parse trust: {error}"));
        trust.public_key_spki_base64 = BASE64.encode(fake_spki.as_bytes());
        trust.fingerprint_sha256 = fake_fingerprint;
        write_json(&trust_path, &trust);

        let assignment_path = root.0.join("assignments/assignment-001.json");
        let mut assignment: AssignmentDocument = serde_json::from_slice(
            &fs::read(&assignment_path).unwrap_or_else(|error| panic!("read assignment: {error}")),
        )
        .unwrap_or_else(|error| panic!("parse assignment: {error}"));
        assignment.signature = provisioning::sign_payload(
            &assignment.payload,
            ASSIGNMENT_DOMAIN,
            &assignment.signature.key_id,
            &fake,
        )
        .unwrap_or_else(|error| panic!("fake assignment signature: {error}"));
        write_json(&assignment_path, &assignment);
        refresh_manifest(&root.0, &fake);

        let bundle = PortableBundle::load_from_root(&root.0, instant(12))
            .unwrap_or_else(|error| panic!("provisional signature check: {error}"));
        assert!(matches!(
            bundle.unlock_operator_key("correct horse battery staple"),
            Err(PortableConfigError::KeyBindingMismatch)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn portable_root_symlink_is_rejected_when_creation_is_permitted() {
        use std::os::windows::fs::symlink_dir;

        let root = TempRoot::new("portable-real-root");
        let _ = provisioned(&root.0);
        let link_parent = TempRoot::new("portable-link-parent");
        let link = link_parent.0.join("linked-root");
        if symlink_dir(&root.0, &link).is_err() {
            return;
        }
        assert!(matches!(
            PortableBundle::load_from_root(&link, instant(12)),
            Err(PortableConfigError::UnsafeLayout(_))
        ));
    }
}
