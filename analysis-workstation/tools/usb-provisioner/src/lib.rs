//! Analysis Workstation backend for creating signed Field Collector USB bundles.
//!
//! This crate is deliberately outside the Field Collector workspace and is not
//! part of its portable release. It retains only Workstation signing material
//! and public operator/assignment registry records.

mod keystore;

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use portable_config::PortableBundle;
use portable_config::provisioning::{
    AssignmentTemplate, ProvisionRequest as PortableProvisionRequest, provision,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::keystore::{WorkstationKeyError, create as create_workstation_key, unlock};

const PROFILE_SCHEMA: &str = "wafc-workstation-profile/1";
const OPERATOR_TEMPLATE_SCHEMA: &str = "wafc-operator-template/1";
const ASSIGNMENT_TEMPLATE_SCHEMA: &str = "wafc-assignment-template/1";
const OPERATOR_REGISTRY_SCHEMA: &str = "wafc-operator-registry-entry/1";
const ASSIGNMENT_REGISTRY_SCHEMA: &str = "wafc-assignment-registry-entry/1";
const RECEIPT_SCHEMA: &str = "wafc-provisioning-receipt/1";
const MAX_TEMPLATE_BYTES: u64 = 1024 * 1024;

/// Errors from Workstation initialization and signed USB provisioning.
#[derive(Debug, Error)]
pub enum ProvisionerError {
    /// A path, identifier, time window, or cross-document field is invalid.
    #[error("invalid provisioning input: {0}")]
    InvalidInput(String),
    /// A fixed path is unsafe, missing, or would overwrite existing state.
    #[error("unsafe provisioning path or existing record: {0}")]
    UnsafePath(String),
    /// Workstation signing-key storage failed.
    #[error("workstation signing-key operation failed: {0}")]
    WorkstationKey(String),
    /// Portable bundle creation or verification failed.
    #[error(transparent)]
    Portable(#[from] portable_config::PortableConfigError),
    /// File I/O failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Strict JSON parsing failed.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// A timestamp is not strict RFC 3339.
    #[error(transparent)]
    Time(#[from] chrono::ParseError),
}

impl From<WorkstationKeyError> for ProvisionerError {
    fn from(value: WorkstationKeyError) -> Self {
        Self::WorkstationKey(value.to_string())
    }
}

/// Public metadata for the Workstation configuration-signing identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkstationProfile {
    /// Schema identifier.
    pub schema_version: String,
    /// Stable Workstation installation identity.
    pub workstation_id: String,
    /// Workstation configuration-signing key identifier.
    pub key_id: String,
    /// Ed25519 DER-SPKI public key, retained only in Workstation state.
    pub public_key_spki_base64: String,
    /// Lowercase SHA-256 DER-SPKI fingerprint.
    pub fingerprint_sha256: String,
    /// Initialization time.
    pub created_at_utc: String,
}

/// Workstation-owned template for one field operator.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorTemplate {
    /// Schema identifier.
    pub schema_version: String,
    /// Stable operator identifier.
    pub operator_id: String,
    /// Human-facing operator name.
    pub display_name: String,
    /// Operator organization.
    pub organization: String,
    /// New evidence-signing key identifier.
    pub key_id: String,
}

/// Workstation-owned unsigned input for one signed assignment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentTemplateDocument {
    /// Schema identifier.
    pub schema_version: String,
    /// Stable task identifier.
    pub assignment_id: String,
    /// Case or authority reference.
    pub authorization_reference: String,
    /// Organization recorded in evidence metadata.
    pub source_organization: String,
    /// Workstation issue time.
    pub issued_at_utc: String,
    /// Inclusive validity start.
    pub valid_from_utc: String,
    /// Exclusive validity end.
    pub valid_until_utc: String,
    /// Human-facing target description.
    pub target_description: String,
}

/// Inputs for initializing one Workstation signing identity.
pub struct InitializeRequest<'a> {
    /// New state directory. It must not already exist.
    pub state_dir: &'a Path,
    /// Stable Workstation identifier.
    pub workstation_id: &'a str,
    /// Workstation configuration-signing key ID.
    pub key_id: &'a str,
    /// Interactive passphrase supplied by the Workstation user.
    pub passphrase: &'a str,
    /// Initialization time.
    pub created_at_utc: DateTime<Utc>,
}

/// Inputs for provisioning one field USB for one operator.
pub struct UsbProvisionRequest<'a> {
    /// Existing Workstation state directory.
    pub state_dir: &'a Path,
    /// Existing USB root containing the two verified executables.
    pub usb_root: &'a Path,
    /// New bundle UUID.
    pub bundle_id: Uuid,
    /// Operator template.
    pub operator: OperatorTemplate,
    /// One or more assignment templates.
    pub assignments: Vec<AssignmentTemplateDocument>,
    /// Workstation signing-key passphrase.
    pub workstation_passphrase: &'a str,
    /// New operator evidence-key passphrase.
    pub operator_passphrase: &'a str,
    /// Provisioning time.
    pub created_at_utc: DateTime<Utc>,
}

/// Non-secret receipt returned to Analysis Workstation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvisioningReceipt {
    /// Receipt schema identifier.
    pub schema_version: String,
    /// Portable bundle UUID.
    pub bundle_id: Uuid,
    /// Operator identifier.
    pub operator_id: String,
    /// Operator evidence-signing key ID.
    pub operator_key_id: String,
    /// Operator public-key fingerprint.
    pub operator_key_fingerprint_sha256: String,
    /// Workstation public-key fingerprint.
    pub workstation_key_fingerprint_sha256: String,
    /// Signed bundle manifest digest.
    pub manifest_sha256: String,
    /// Signed assignment IDs and complete-file digests.
    pub assignments: Vec<RegisteredAssignmentDigest>,
    /// Provisioning time.
    pub provisioned_at_utc: String,
}

/// One assignment identity/digest in a non-secret receipt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredAssignmentDigest {
    /// Assignment identifier.
    pub assignment_id: String,
    /// Complete signed assignment-file SHA-256.
    pub document_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperatorRegistryEntry {
    schema_version: String,
    operator_id: String,
    display_name: String,
    organization: String,
    key_id: String,
    public_key_spki_base64: String,
    fingerprint_sha256: String,
    created_at_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignmentRegistryEntry {
    schema_version: String,
    assignment_id: String,
    operator_id: String,
    operator_key_id: String,
    bundle_id: Uuid,
    document_sha256: String,
    authorization_reference: String,
    valid_from_utc: String,
    valid_until_utc: String,
    registered_at_utc: String,
}

/// Initializes a new Workstation state directory and encrypted Ed25519 key.
///
/// The state directory must not exist. No private key bytes are returned.
///
/// # Errors
///
/// Returns an error for an unsafe/existing path, invalid identifiers, weak
/// passphrase, entropy/cryptographic failure, or write failure.
pub fn initialize_workstation(
    request: &InitializeRequest<'_>,
) -> Result<WorkstationProfile, ProvisionerError> {
    validate_identifier(request.workstation_id, "workstationId")?;
    validate_identifier(request.key_id, "keyId")?;
    create_new_state_root(request.state_dir)?;
    for directory in ["operators", "assignments", "receipts"] {
        create_real_directory(&request.state_dir.join(directory))?;
    }
    let created = create_workstation_key(
        &request.state_dir.join("workstation-key.enc"),
        request.workstation_id,
        request.key_id,
        request.passphrase,
    )?;
    let profile = WorkstationProfile {
        schema_version: PROFILE_SCHEMA.to_owned(),
        workstation_id: request.workstation_id.to_owned(),
        key_id: request.key_id.to_owned(),
        public_key_spki_base64: created.public_key_spki_base64,
        fingerprint_sha256: created.fingerprint_sha256,
        created_at_utc: utc(request.created_at_utc),
    };
    write_json_new(
        &request.state_dir.join("workstation-profile.json"),
        &profile,
    )?;
    Ok(profile)
}

/// Provisions one signed USB and writes only public registry records locally.
///
/// The function verifies the completed portable bundle and encrypted operator
/// key before creating Workstation registry entries.
///
/// # Errors
///
/// Returns an error for unsafe paths, invalid or duplicate templates, bad
/// passphrases, existing registry entries, signing failures, or post-provision
/// verification failures.
#[allow(clippy::too_many_lines)]
pub fn provision_usb(
    request: &UsbProvisionRequest<'_>,
) -> Result<ProvisioningReceipt, ProvisionerError> {
    ensure_state_layout(request.state_dir)?;
    ensure_usb_release_root(request.usb_root)?;
    validate_operator(&request.operator)?;
    if request.assignments.is_empty() {
        return Err(ProvisionerError::InvalidInput(
            "at least one assignment is required".to_owned(),
        ));
    }
    let mut seen = BTreeSet::new();
    let assignment_templates = request
        .assignments
        .iter()
        .map(|document| {
            validate_assignment(document)?;
            if !seen.insert(document.assignment_id.clone()) {
                return Err(ProvisionerError::InvalidInput(
                    "duplicate assignmentId".to_owned(),
                ));
            }
            Ok(AssignmentTemplate {
                assignment_id: document.assignment_id.clone(),
                authorization_reference: document.authorization_reference.clone(),
                source_organization: document.source_organization.clone(),
                issued_at_utc: parse_utc(&document.issued_at_utc)?,
                valid_from_utc: parse_utc(&document.valid_from_utc)?,
                valid_until_utc: parse_utc(&document.valid_until_utc)?,
                target_description: document.target_description.clone(),
            })
        })
        .collect::<Result<Vec<_>, ProvisionerError>>()?;
    let first_assignment = request.assignments.first().ok_or_else(|| {
        ProvisionerError::InvalidInput("at least one assignment is required".to_owned())
    })?;
    let post_provision_validation_time = parse_utc(&first_assignment.valid_from_utc)?;

    let profile =
        read_json::<WorkstationProfile>(&request.state_dir.join("workstation-profile.json"))?;
    validate_workstation_profile(&profile)?;
    let workstation_key = unlock(
        &request.state_dir.join("workstation-key.enc"),
        request.workstation_passphrase,
    )?;
    if workstation_key.fingerprint_sha256 != profile.fingerprint_sha256
        || workstation_key.public_key_spki_base64 != profile.public_key_spki_base64
    {
        return Err(ProvisionerError::InvalidInput(
            "Workstation profile and signing key differ".to_owned(),
        ));
    }
    preflight_registry_paths(request)?;
    let provisioned = provision(&PortableProvisionRequest {
        root: request.usb_root,
        bundle_id: request.bundle_id,
        operator_id: request.operator.operator_id.clone(),
        operator_display_name: request.operator.display_name.clone(),
        operator_organization: request.operator.organization.clone(),
        operator_key_id: request.operator.key_id.clone(),
        workstation_id: profile.workstation_id.clone(),
        workstation_key_id: profile.key_id.clone(),
        workstation_signing_key: &workstation_key.signing_key,
        operator_key_passphrase: request.operator_passphrase,
        assignments: assignment_templates,
        created_at_utc: request.created_at_utc,
    })?;

    // A newly issued task may intentionally start a few minutes in the future.
    // Validate the signed portable structure at the first assignment's start
    // instant rather than falsely requiring it to be active during provisioning.
    let bundle = PortableBundle::load_from_root(request.usb_root, post_provision_validation_time)?;
    let unlocked_operator = bundle.unlock_operator_key(request.operator_passphrase)?;
    if unlocked_operator.public_key_fingerprint_sha256
        != provisioned.operator_key_fingerprint_sha256
    {
        return Err(ProvisionerError::InvalidInput(
            "post-provision operator-key verification failed".to_owned(),
        ));
    }
    drop(unlocked_operator);

    let assignment_digests = request
        .assignments
        .iter()
        .map(|assignment| {
            let path = request
                .usb_root
                .join("assignments")
                .join(format!("{}.json", assignment.assignment_id));
            Ok(RegisteredAssignmentDigest {
                assignment_id: assignment.assignment_id.clone(),
                document_sha256: sha256_file(&path)?,
            })
        })
        .collect::<Result<Vec<_>, ProvisionerError>>()?;
    write_registry_entries(
        request,
        &provisioned.operator_public_key_spki_base64,
        &provisioned.operator_key_fingerprint_sha256,
        &assignment_digests,
    )?;
    let receipt = ProvisioningReceipt {
        schema_version: RECEIPT_SCHEMA.to_owned(),
        bundle_id: request.bundle_id,
        operator_id: request.operator.operator_id.clone(),
        operator_key_id: request.operator.key_id.clone(),
        operator_key_fingerprint_sha256: provisioned.operator_key_fingerprint_sha256,
        workstation_key_fingerprint_sha256: provisioned.workstation_key_fingerprint_sha256,
        manifest_sha256: provisioned.manifest_sha256,
        assignments: assignment_digests,
        provisioned_at_utc: utc(request.created_at_utc),
    };
    write_json_new(
        &request
            .state_dir
            .join("receipts")
            .join(format!("{}.json", request.bundle_id)),
        &receipt,
    )?;
    Ok(receipt)
}

/// Reads one strict operator template from disk.
///
/// # Errors
///
/// Returns an error for an unsafe/oversized file or malformed JSON.
pub fn read_operator_template(path: &Path) -> Result<OperatorTemplate, ProvisionerError> {
    read_json(path)
}

/// Reads one strict assignment template from disk.
///
/// # Errors
///
/// Returns an error for an unsafe/oversized file or malformed JSON.
pub fn read_assignment_template(
    path: &Path,
) -> Result<AssignmentTemplateDocument, ProvisionerError> {
    read_json(path)
}

fn preflight_registry_paths(request: &UsbProvisionRequest<'_>) -> Result<(), ProvisionerError> {
    let operator_path = request.state_dir.join("operators").join(format!(
        "{}--{}.json",
        request.operator.operator_id, request.operator.key_id
    ));
    if operator_path.exists() {
        return Err(ProvisionerError::UnsafePath(
            "operator/key registry entry already exists".to_owned(),
        ));
    }
    for assignment in &request.assignments {
        if request
            .state_dir
            .join("assignments")
            .join(format!("{}.json", assignment.assignment_id))
            .exists()
        {
            return Err(ProvisionerError::UnsafePath(format!(
                "assignment registry already exists: {}",
                assignment.assignment_id
            )));
        }
    }
    Ok(())
}

fn write_registry_entries(
    request: &UsbProvisionRequest<'_>,
    operator_spki: &str,
    operator_fingerprint: &str,
    assignment_digests: &[RegisteredAssignmentDigest],
) -> Result<(), ProvisionerError> {
    let operator = OperatorRegistryEntry {
        schema_version: OPERATOR_REGISTRY_SCHEMA.to_owned(),
        operator_id: request.operator.operator_id.clone(),
        display_name: request.operator.display_name.clone(),
        organization: request.operator.organization.clone(),
        key_id: request.operator.key_id.clone(),
        public_key_spki_base64: operator_spki.to_owned(),
        fingerprint_sha256: operator_fingerprint.to_owned(),
        created_at_utc: utc(request.created_at_utc),
    };
    write_json_new(
        &request.state_dir.join("operators").join(format!(
            "{}--{}.json",
            request.operator.operator_id, request.operator.key_id
        )),
        &operator,
    )?;
    for (assignment, digest) in request.assignments.iter().zip(assignment_digests) {
        let entry = AssignmentRegistryEntry {
            schema_version: ASSIGNMENT_REGISTRY_SCHEMA.to_owned(),
            assignment_id: assignment.assignment_id.clone(),
            operator_id: request.operator.operator_id.clone(),
            operator_key_id: request.operator.key_id.clone(),
            bundle_id: request.bundle_id,
            document_sha256: digest.document_sha256.clone(),
            authorization_reference: assignment.authorization_reference.clone(),
            valid_from_utc: assignment.valid_from_utc.clone(),
            valid_until_utc: assignment.valid_until_utc.clone(),
            registered_at_utc: utc(request.created_at_utc),
        };
        write_json_new(
            &request
                .state_dir
                .join("assignments")
                .join(format!("{}.json", assignment.assignment_id)),
            &entry,
        )?;
    }
    Ok(())
}

fn ensure_state_layout(root: &Path) -> Result<(), ProvisionerError> {
    ensure_real_directory(root)?;
    for (relative, is_file) in [
        ("operators", false),
        ("assignments", false),
        ("receipts", false),
        ("workstation-profile.json", true),
        ("workstation-key.enc", true),
    ] {
        let path = root.join(relative);
        ensure_no_reparse_path(&path)?;
        if is_file {
            ensure_real_file(&path)?;
        } else {
            ensure_real_directory(&path)?;
        }
    }
    Ok(())
}

fn ensure_usb_release_root(root: &Path) -> Result<(), ProvisionerError> {
    ensure_real_directory(root)?;
    for name in ["field-collector.exe", "waeb-verify.exe"] {
        ensure_real_file(&root.join(name))?;
    }
    Ok(())
}

fn create_new_state_root(path: &Path) -> Result<(), ProvisionerError> {
    if path.exists() {
        return Err(ProvisionerError::UnsafePath(
            "state directory already exists".to_owned(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ProvisionerError::UnsafePath("state directory has no parent".to_owned()))?;
    ensure_real_directory(parent)?;
    fs::create_dir(path)?;
    ensure_real_directory(path)
}

fn create_real_directory(path: &Path) -> Result<(), ProvisionerError> {
    fs::create_dir(path)?;
    ensure_real_directory(path)
}

fn ensure_real_directory(path: &Path) -> Result<(), ProvisionerError> {
    ensure_no_reparse_path(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
        return Err(ProvisionerError::UnsafePath(format!(
            "not a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_real_file(path: &Path) -> Result<(), ProvisionerError> {
    ensure_no_reparse_path(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
        return Err(ProvisionerError::UnsafePath(format!(
            "not a real file: {}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_no_reparse_path(path: &Path) -> Result<(), ProvisionerError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(ProvisionerError::UnsafePath(
                "path contains traversal components".to_owned(),
            ));
        }
        current.push(component.as_os_str());
        if current.exists() {
            let metadata = fs::symlink_metadata(&current)?;
            if metadata.file_type().is_symlink() || is_reparse(&metadata) {
                return Err(ProvisionerError::UnsafePath(
                    "path contains a symlink or reparse point".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
const fn is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn validate_operator(operator: &OperatorTemplate) -> Result<(), ProvisionerError> {
    if operator.schema_version != OPERATOR_TEMPLATE_SCHEMA {
        return Err(ProvisionerError::InvalidInput(
            "unsupported operator template schema".to_owned(),
        ));
    }
    validate_identifier(&operator.operator_id, "operatorId")?;
    validate_identifier(&operator.key_id, "keyId")?;
    validate_text(&operator.display_name, 160, "displayName")?;
    validate_text(&operator.organization, 240, "organization")
}

fn validate_assignment(assignment: &AssignmentTemplateDocument) -> Result<(), ProvisionerError> {
    if assignment.schema_version != ASSIGNMENT_TEMPLATE_SCHEMA {
        return Err(ProvisionerError::InvalidInput(
            "unsupported assignment template schema".to_owned(),
        ));
    }
    validate_identifier(&assignment.assignment_id, "assignmentId")?;
    validate_text(
        &assignment.authorization_reference,
        240,
        "authorizationReference",
    )?;
    validate_text(&assignment.source_organization, 240, "sourceOrganization")?;
    validate_text(&assignment.target_description, 500, "targetDescription")?;
    let issued = parse_utc(&assignment.issued_at_utc)?;
    let valid_from = parse_utc(&assignment.valid_from_utc)?;
    let valid_until = parse_utc(&assignment.valid_until_utc)?;
    if issued > valid_from || valid_from >= valid_until {
        return Err(ProvisionerError::InvalidInput(
            "assignment validity window is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_workstation_profile(profile: &WorkstationProfile) -> Result<(), ProvisionerError> {
    if profile.schema_version != PROFILE_SCHEMA
        || !is_fingerprint(&profile.fingerprint_sha256)
        || profile.public_key_spki_base64.is_empty()
    {
        return Err(ProvisionerError::InvalidInput(
            "invalid Workstation profile".to_owned(),
        ));
    }
    validate_identifier(&profile.workstation_id, "workstationId")?;
    validate_identifier(&profile.key_id, "keyId")
}

fn validate_identifier(value: &str, field: &str) -> Result<(), ProvisionerError> {
    let valid = (3..=120).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && b"_.-".contains(&byte))
        });
    if valid {
        Ok(())
    } else {
        Err(ProvisionerError::InvalidInput(format!(
            "{field} is not a canonical identifier"
        )))
    }
}

fn validate_text(value: &str, max: usize, field: &str) -> Result<(), ProvisionerError> {
    if !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(ProvisionerError::InvalidInput(format!(
            "{field} is empty, too long, or contains controls"
        )))
    }
}

fn is_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn parse_utc(value: &str) -> Result<DateTime<Utc>, ProvisionerError> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

fn utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, ProvisionerError> {
    ensure_real_file(path)?;
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_TEMPLATE_BYTES {
        return Err(ProvisionerError::InvalidInput(
            "JSON input exceeds limit".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    fs::File::open(path)?
        .take(MAX_TEMPLATE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_json_new<T: Serialize>(path: &Path, value: &T) -> Result<(), ProvisionerError> {
    ensure_no_reparse_path(path)?;
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, ProvisionerError> {
    ensure_real_file(path)?;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const WORKSTATION_PASSPHRASE: &str = "workstation-passphrase-2026";
    const OPERATOR_PASSPHRASE: &str = "operator-passphrase-2026";

    fn fixed_time() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-08T00:00:00Z")
            .unwrap_or_else(|error| panic!("fixed time: {error}"))
            .with_timezone(&Utc)
    }

    fn operator() -> OperatorTemplate {
        OperatorTemplate {
            schema_version: OPERATOR_TEMPLATE_SCHEMA.to_owned(),
            operator_id: "operator-a".to_owned(),
            display_name: "Field Operator A".to_owned(),
            organization: "Forensics Lab".to_owned(),
            key_id: "operator-key-001".to_owned(),
        }
    }

    fn assignment() -> AssignmentTemplateDocument {
        AssignmentTemplateDocument {
            schema_version: ASSIGNMENT_TEMPLATE_SCHEMA.to_owned(),
            assignment_id: "assignment-001".to_owned(),
            authorization_reference: "AUTH-2026-001".to_owned(),
            source_organization: "Forensics Lab".to_owned(),
            issued_at_utc: "2026-08-08T00:00:00Z".to_owned(),
            valid_from_utc: "2026-08-08T00:00:00Z".to_owned(),
            valid_until_utc: "2026-08-09T00:00:00Z".to_owned(),
            target_description: "Authorized passive T0".to_owned(),
        }
    }

    fn prepare_release_root(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        fs::create_dir(path)?;
        fs::write(path.join("field-collector.exe"), b"MZ synthetic collector")?;
        fs::write(path.join("waeb-verify.exe"), b"MZ synthetic verifier")?;
        Ok(())
    }

    #[test]
    fn workstation_initialization_and_usb_provisioning_round_trip()
    -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempdir()?;
        let state = temporary.path().join("state");
        let usb = temporary.path().join("usb");
        prepare_release_root(&usb)?;
        let profile = initialize_workstation(&InitializeRequest {
            state_dir: &state,
            workstation_id: "lab-workstation-001",
            key_id: "workstation-key-001",
            passphrase: WORKSTATION_PASSPHRASE,
            created_at_utc: fixed_time(),
        })?;
        assert!(is_fingerprint(&profile.fingerprint_sha256));
        let bundle_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")?;
        let receipt = provision_usb(&UsbProvisionRequest {
            state_dir: &state,
            usb_root: &usb,
            bundle_id,
            operator: operator(),
            assignments: vec![assignment()],
            workstation_passphrase: WORKSTATION_PASSPHRASE,
            operator_passphrase: OPERATOR_PASSPHRASE,
            created_at_utc: fixed_time(),
        })?;
        assert_eq!(receipt.bundle_id, bundle_id);
        assert_eq!(receipt.assignments.len(), 1);
        assert!(usb.join("config/operator-key.enc").is_file());
        assert!(usb.join("assignments/assignment-001.json").is_file());
        assert!(usb.join("evidence/staging").is_dir());
        assert!(usb.join("evidence/sealed").is_dir());
        assert!(
            state
                .join("operators/operator-a--operator-key-001.json")
                .is_file()
        );
        assert!(state.join("assignments/assignment-001.json").is_file());
        assert!(state.join(format!("receipts/{bundle_id}.json")).is_file());
        assert!(!state.join("operator-key.enc").exists());

        let bundle = PortableBundle::load_from_root(&usb, fixed_time())?;
        let unlocked = bundle.unlock_operator_key(OPERATOR_PASSPHRASE)?;
        assert_eq!(
            unlocked.public_key_fingerprint_sha256,
            receipt.operator_key_fingerprint_sha256
        );
        Ok(())
    }

    #[test]
    fn wrong_workstation_passphrase_fails_before_usb_configuration()
    -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempdir()?;
        let state = temporary.path().join("state");
        let usb = temporary.path().join("usb");
        prepare_release_root(&usb)?;
        initialize_workstation(&InitializeRequest {
            state_dir: &state,
            workstation_id: "lab-workstation-001",
            key_id: "workstation-key-001",
            passphrase: WORKSTATION_PASSPHRASE,
            created_at_utc: fixed_time(),
        })?;
        let result = provision_usb(&UsbProvisionRequest {
            state_dir: &state,
            usb_root: &usb,
            bundle_id: Uuid::new_v4(),
            operator: operator(),
            assignments: vec![assignment()],
            workstation_passphrase: "incorrect-passphrase",
            operator_passphrase: OPERATOR_PASSPHRASE,
            created_at_utc: fixed_time(),
        });
        assert!(result.is_err());
        assert!(!usb.join("wafc-portable.json").exists());
        assert!(!usb.join("config").exists());
        Ok(())
    }

    #[test]
    fn assignment_tamper_is_rejected_after_provisioning() -> Result<(), Box<dyn std::error::Error>>
    {
        let temporary = tempdir()?;
        let state = temporary.path().join("state");
        let usb = temporary.path().join("usb");
        prepare_release_root(&usb)?;
        initialize_workstation(&InitializeRequest {
            state_dir: &state,
            workstation_id: "lab-workstation-001",
            key_id: "workstation-key-001",
            passphrase: WORKSTATION_PASSPHRASE,
            created_at_utc: fixed_time(),
        })?;
        provision_usb(&UsbProvisionRequest {
            state_dir: &state,
            usb_root: &usb,
            bundle_id: Uuid::new_v4(),
            operator: operator(),
            assignments: vec![assignment()],
            workstation_passphrase: WORKSTATION_PASSPHRASE,
            operator_passphrase: OPERATOR_PASSPHRASE,
            created_at_utc: fixed_time(),
        })?;
        let assignment_path = usb.join("assignments/assignment-001.json");
        let mut bytes = fs::read(&assignment_path)?;
        let last = bytes
            .last_mut()
            .ok_or_else(|| std::io::Error::other("empty assignment"))?;
        *last ^= 1;
        fs::write(&assignment_path, bytes)?;
        assert!(PortableBundle::load_from_root(&usb, fixed_time()).is_err());
        Ok(())
    }

    #[test]
    fn strict_template_reader_rejects_unknown_fields() -> Result<(), Box<dyn std::error::Error>> {
        let temporary = tempdir()?;
        let template = temporary.path().join("operator.json");
        fs::write(
            &template,
            br#"{"schemaVersion":"wafc-operator-template/1","operatorId":"operator-a","displayName":"A","organization":"Lab","keyId":"operator-key-001","unexpected":true}"#,
        )?;
        assert!(read_operator_template(&template).is_err());
        Ok(())
    }
}
