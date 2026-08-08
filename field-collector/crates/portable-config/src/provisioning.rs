//! Workstation-side portable bundle provisioning.
//!
//! This module is excluded from Field Collector production builds unless the
//! separate Workstation enables the `provisioning` feature.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, SecondsFormat, Utc};
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey};
use portable_keystore::{CreatedKeystore, KeystoreBinding, create};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    ASSIGNMENT_DOMAIN, ASSIGNMENT_SCHEMA, ASSIGNMENTS_DIR, AssignmentDocument, AssignmentPayload,
    BundleManifest, DIAGNOSTICS_DIR, HANDOFF_DIR, KEY_PATH, LAYOUT, MANIFEST_DOMAIN, MANIFEST_PATH,
    MANIFEST_SCHEMA, ManifestFile, ManifestPayload, OperatorProfile, PROFILE_PATH, PROFILE_SCHEMA,
    PortableConfigError, PortableRootDocument, ROOT_MARKER, ROOT_SCHEMA, SEALED_DIR, STAGING_DIR,
    SignatureDocument, TRUST_PATH, TRUST_SCHEMA, WorkstationTrust, fixed_paths, jcs, sha256_hex,
};

/// One signed task to place in a newly provisioned bundle.
#[derive(Clone, Debug)]
pub struct AssignmentTemplate {
    /// Stable task identifier and output filename suffix.
    pub assignment_id: String,
    /// Case/authority reference.
    pub authorization_reference: String,
    /// Source organization recorded in evidence metadata.
    pub source_organization: String,
    /// Workstation issue time.
    pub issued_at_utc: DateTime<Utc>,
    /// Inclusive validity start.
    pub valid_from_utc: DateTime<Utc>,
    /// Exclusive validity end.
    pub valid_until_utc: DateTime<Utc>,
    /// Human-readable target description.
    pub target_description: String,
}

/// Inputs owned by Analysis Workstation when creating a new USB bundle.
pub struct ProvisionRequest<'a> {
    /// Existing empty/prepared portable root. Configuration paths must not exist.
    pub root: &'a Path,
    /// New bundle identity.
    pub bundle_id: Uuid,
    /// Field operator identifier.
    pub operator_id: String,
    /// Field operator display name.
    pub operator_display_name: String,
    /// Operator organization.
    pub operator_organization: String,
    /// Newly generated evidence-signing key identifier.
    pub operator_key_id: String,
    /// Workstation identifier.
    pub workstation_id: String,
    /// Workstation configuration-signing key identifier.
    pub workstation_key_id: String,
    /// Workstation configuration-signing key. Never copied into the bundle.
    pub workstation_signing_key: &'a SigningKey,
    /// Passphrase used to encrypt the new operator private key.
    pub operator_key_passphrase: &'a str,
    /// One or more operator-bound tasks.
    pub assignments: Vec<AssignmentTemplate>,
    /// Bundle creation time.
    pub created_at_utc: DateTime<Utc>,
}

/// Non-secret result returned to Analysis Workstation after provisioning.
#[derive(Debug, Clone)]
pub struct ProvisionedBundle {
    /// Canonical portable root.
    pub root: PathBuf,
    /// Operator evidence-signing key fingerprint for the Workstation registry.
    pub operator_key_fingerprint_sha256: String,
    /// DER-SPKI public key for the Workstation operator registry. This return
    /// value must not be copied into Evidence Bags or handoff summaries.
    pub operator_public_key_spki_base64: String,
    /// Workstation configuration-signing key fingerprint bound into the key.
    pub workstation_key_fingerprint_sha256: String,
    /// Complete signed manifest digest.
    pub manifest_sha256: String,
}

/// Creates a new signed portable configuration tree.
///
/// The function never overwrites configuration, assignments, evidence, handoff,
/// or diagnostics paths. The caller is responsible for installing the separately
/// built Collector/verifier release before or after provisioning.
///
/// # Errors
///
/// Returns an error for an unsafe/non-empty configuration destination, invalid
/// task fields, key generation/encryption failures, or any I/O/signing failure.
#[allow(clippy::too_many_lines)]
pub fn provision(request: &ProvisionRequest<'_>) -> Result<ProvisionedBundle, PortableConfigError> {
    if request.assignments.is_empty() {
        return Err(PortableConfigError::InvalidDocument(
            "Workstation must provision at least one assignment".to_owned(),
        ));
    }
    crate::ensure_real_directory(request.root)?;
    let root = fs::canonicalize(request.root)?;
    for relative in [
        ROOT_MARKER,
        "config",
        ASSIGNMENTS_DIR,
        "evidence",
        STAGING_DIR,
        SEALED_DIR,
        HANDOFF_DIR,
        DIAGNOSTICS_DIR,
    ] {
        if crate::safe_relative(&root, relative)?.exists() {
            return Err(PortableConfigError::UnsafeLayout(format!(
                "provisioning destination already exists: {relative}"
            )));
        }
    }

    create_directory(&root.join("config"))?;
    create_directory(&root.join(ASSIGNMENTS_DIR))?;
    create_directory(&root.join("evidence"))?;
    create_directory(&crate::safe_relative(&root, STAGING_DIR)?)?;
    create_directory(&crate::safe_relative(&root, SEALED_DIR)?)?;
    create_directory(&root.join(HANDOFF_DIR))?;
    create_directory(&root.join(DIAGNOSTICS_DIR))?;

    let workstation_spki = request
        .workstation_signing_key
        .verifying_key()
        .to_public_key_der()
        .map_err(|error| {
            PortableConfigError::InvalidDocument(format!(
                "Workstation Ed25519 public key encoding failed: {error}"
            ))
        })?;
    let workstation_fingerprint = format!("sha256:{}", sha256_hex(workstation_spki.as_bytes()));
    let trust = WorkstationTrust {
        schema_version: TRUST_SCHEMA.to_owned(),
        workstation_id: request.workstation_id.clone(),
        key_id: request.workstation_key_id.clone(),
        algorithm: "Ed25519".to_owned(),
        encoding: "spki-der".to_owned(),
        public_key_spki_base64: BASE64.encode(workstation_spki.as_bytes()),
        fingerprint_sha256: workstation_fingerprint.clone(),
    };

    let marker = PortableRootDocument {
        schema_version: ROOT_SCHEMA.to_owned(),
        layout: LAYOUT.to_owned(),
        bundle_id: request.bundle_id,
        paths: fixed_paths(),
    };
    write_json_new(&root.join(ROOT_MARKER), &marker)?;
    write_json_new(&crate::safe_relative(&root, TRUST_PATH)?, &trust)?;

    let binding = KeystoreBinding {
        operator_id: request.operator_id.clone(),
        key_id: request.operator_key_id.clone(),
        workstation_key_fingerprint_sha256: workstation_fingerprint.clone(),
    };
    let created_key = create(
        &crate::safe_relative(&root, KEY_PATH)?,
        request.operator_key_passphrase,
        &binding,
    )?;
    let profile = operator_profile(request, &created_key);
    write_json_new(&crate::safe_relative(&root, PROFILE_PATH)?, &profile)?;

    for assignment in &request.assignments {
        let payload = AssignmentPayload {
            assignment_id: assignment.assignment_id.clone(),
            authorization_reference: assignment.authorization_reference.clone(),
            operator_id: request.operator_id.clone(),
            allowed_key_id: request.operator_key_id.clone(),
            source_organization: assignment.source_organization.clone(),
            issued_at_utc: utc(assignment.issued_at_utc),
            valid_from_utc: utc(assignment.valid_from_utc),
            valid_until_utc: utc(assignment.valid_until_utc),
            acquisition_mode: "passive_t0".to_owned(),
            target_description: assignment.target_description.clone(),
        };
        let signature = sign_payload(
            &payload,
            ASSIGNMENT_DOMAIN,
            &request.workstation_key_id,
            request.workstation_signing_key,
        )?;
        let document = AssignmentDocument {
            schema_version: ASSIGNMENT_SCHEMA.to_owned(),
            payload,
            signature,
        };
        let path = crate::safe_relative(
            &root,
            &format!("assignments/{}.json", assignment.assignment_id),
        )?;
        write_json_new(&path, &document)?;
    }

    let files = manifest_files(&root)?;
    let payload = ManifestPayload {
        bundle_id: request.bundle_id,
        created_at_utc: utc(request.created_at_utc),
        operator_id: request.operator_id.clone(),
        operator_key_id: request.operator_key_id.clone(),
        workstation_key_id: request.workstation_key_id.clone(),
        files,
    };
    let signature = sign_payload(
        &payload,
        MANIFEST_DOMAIN,
        &request.workstation_key_id,
        request.workstation_signing_key,
    )?;
    let manifest = BundleManifest {
        schema_version: MANIFEST_SCHEMA.to_owned(),
        payload,
        signature,
    };
    let manifest_path = crate::safe_relative(&root, MANIFEST_PATH)?;
    write_json_new(&manifest_path, &manifest)?;
    let manifest_sha256 = sha256_hex(&fs::read(&manifest_path)?);
    Ok(ProvisionedBundle {
        root,
        operator_key_fingerprint_sha256: created_key.public_key_fingerprint_sha256,
        operator_public_key_spki_base64: created_key.public_key_spki_base64,
        workstation_key_fingerprint_sha256: workstation_fingerprint,
        manifest_sha256,
    })
}

fn operator_profile(request: &ProvisionRequest<'_>, key: &CreatedKeystore) -> OperatorProfile {
    OperatorProfile {
        schema_version: PROFILE_SCHEMA.to_owned(),
        operator_id: request.operator_id.clone(),
        display_name: request.operator_display_name.clone(),
        organization: request.operator_organization.clone(),
        key_id: request.operator_key_id.clone(),
        evidence_signing_key_fingerprint_sha256: key.public_key_fingerprint_sha256.clone(),
    }
}

pub(crate) fn sign_payload<T: Serialize>(
    payload: &T,
    domain: &[u8],
    key_id: &str,
    signing_key: &SigningKey,
) -> Result<SignatureDocument, PortableConfigError> {
    let value = serde_json::to_value(payload)?;
    let canonical = jcs::canonicalize(&value)?;
    let mut signed = Vec::with_capacity(domain.len() + canonical.len());
    signed.extend_from_slice(domain);
    signed.extend_from_slice(&canonical);
    let signature = signing_key.sign(&signed);
    Ok(SignatureDocument {
        algorithm: "Ed25519".to_owned(),
        key_id: key_id.to_owned(),
        payload_sha256: sha256_hex(&canonical),
        signature_base64: BASE64.encode(signature.to_bytes()),
    })
}

fn manifest_files(root: &Path) -> Result<Vec<ManifestFile>, PortableConfigError> {
    let mut paths = vec![
        ROOT_MARKER.to_owned(),
        KEY_PATH.to_owned(),
        PROFILE_PATH.to_owned(),
        TRUST_PATH.to_owned(),
    ];
    for entry in fs::read_dir(root.join(ASSIGNMENTS_DIR))? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| {
            PortableConfigError::UnsafeLayout("assignment filename is not UTF-8".to_owned())
        })?;
        paths.push(format!("assignments/{name}"));
    }
    paths.sort();
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        crate::validate_manifest_path(&path)?;
        let bytes = fs::read(crate::safe_relative(root, &path)?)?;
        files.push(ManifestFile {
            path,
            bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            sha256: hex::encode(Sha256::digest(&bytes)),
        });
    }
    Ok(files)
}

fn write_json_new<T: Serialize>(path: &Path, value: &T) -> Result<(), PortableConfigError> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn create_directory(path: &Path) -> Result<(), PortableConfigError> {
    fs::create_dir(path)?;
    if let Some(parent) = path.parent()
        && let Ok(directory) = File::open(parent)
    {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
