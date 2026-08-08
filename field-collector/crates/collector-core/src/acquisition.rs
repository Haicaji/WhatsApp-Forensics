//! End-to-end passive T0 acquisition over an explicitly authorized CDP endpoint.

use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{Read, Write};
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
use std::time::{Duration, Instant};

use browser_cdp::{
    BrowserCdpError, BrowserVersion, CdpEndpoint, CdpEvent, CdpSession, CdpTarget, get_version,
    is_whatsapp_web_url, list_whatsapp_targets, operating_system_version,
    verify_dedicated_profile_binding,
};
use chrono::{SecondsFormat, Utc};
use page_bridge::{
    AckOutcome, BridgeError, CapabilityPayload, DatasetKind, ErrorPayload, Frame, FrameKind,
    FrameValidator, ProbeResultPayload, ReceiveOutcome, RecordBatchPayload, StreamEndPayload,
    StreamStartPayload,
};
use portable_keystore::{KeystoreError, UnlockedKeystore, unlock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::sync::broadcast::error::TryRecvError;
use tokio::time::timeout;
use uuid::Uuid;
use waeb_writer::{
    AcquisitionDto, AcquisitionLogDto, AcquisitionModeDto, AuthorizationDto, BrowserDto,
    CAPABILITY_NAMES, CapabilitiesDto, CapabilityDto, CompletenessDto, ComponentDto,
    CrossChecksDto, DATASETS, DatasetCapability, DatasetDisposition, DatasetResult, EnvironmentDto,
    LogEventType, MediaCountsDto, ObservationWindowDto, OperatorDto, OsDto,
    PortableConfigurationDto, PrivacyDto, RequestState, SCHEMA_VERSION, SealOptions, SealedBag,
    WAEB_VERSION, WaebError, WaebWriter, sha256_hex,
};

use crate::COLLECTOR_VERSION;
use crate::normalize::{NormalizationError, NormalizationSummary, Normalizer};
use crate::state::{AcquisitionState, StateError, StateMachine};

const INJECTOR: &str = include_str!("../../../injector/dist/collector.iife.js");
const DISPATCH_FUNCTION: &str = "function(command){ return this.dispatch(command); }";
const NEXT_FUNCTION: &str = "function(){ return this.next(); }";
const ACK_FUNCTION: &str = "function(sequence){ return this.ack(sequence); }";
const CHECK_ACCOUNT_BINDING_FUNCTION: &str = "function(){ return this.checkAccountBinding(); }";
const ORIGIN_EXPRESSION: &str = "window.location.origin";
const MAX_OUTPUT_MARKER_BYTES: usize = 64;
const ACK_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
const ACCOUNT_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(120);

/// Workstation-provisioned portable configuration bound to one acquisition.
#[derive(Clone, Debug)]
pub struct PortableConfigurationContext {
    /// Workstation-created portable bundle identity.
    pub bundle_id: Uuid,
    /// SHA-256 of the complete signed bundle manifest.
    pub bundle_manifest_sha256: String,
    /// Selected signed assignment identifier.
    pub assignment_id: String,
    /// SHA-256 of the complete signed assignment document.
    pub assignment_sha256: String,
    /// Workstation key fingerprint authenticated inside the encrypted operator key.
    pub workstation_key_fingerprint_sha256: String,
    /// Registered operator evidence-signing public-key fingerprint.
    pub operator_key_fingerprint_sha256: String,
}

/// Operator-mediated use of one original Chromium profile and the fixed
/// read-only extension package.
///
/// The selected profile path and extension ID are deliberately excluded. The
/// context records the bounded observation and possible state impacts without
/// claiming that the profile was untouched or that the account is authentic.
#[derive(Clone, Debug)]
pub struct ExistingProfileContext {
    /// Domain-separated SHA-256 reference generated from the validated profile
    /// directory. The original path never enters evidence or logs.
    pub profile_reference_sha256: String,
    /// Browser family selected from the read-only profile index.
    pub browser_family: String,
    /// Whether that browser product was running before the launch request. The
    /// exact original state of the selected profile remains unverifiable.
    pub browser_product_was_running: bool,
    /// UTC time at which the Collector requested a normal profile launch.
    pub browser_opened_at_utc: String,
    /// UTC time at which the operator-activated extension paired successfully.
    pub extension_paired_at_utc: String,
    /// Exact release version of the fixed MV3 extension shell.
    pub extension_version: String,
    /// Exact stable extension-to-Collector protocol identifier.
    pub transport_protocol: String,
    /// Versioned `WhatsApp` reader selected by the extension.
    pub adapter_id: String,
    /// Adapter release version.
    pub adapter_version: String,
    /// Lowercase SHA-256 of the exact injected Adapter bytes.
    pub adapter_sha256: String,
}

/// Workstation-provisioned inputs plus one operator-selected browser target.
#[derive(Clone, Debug)]
pub struct AcquisitionRequest {
    /// Explicit loopback CDP HTTP endpoint.
    pub endpoint: CdpEndpoint,
    /// Dedicated profile directory launched by this collector, or `None` for
    /// an independently authorised existing debugging endpoint.
    pub dedicated_profile_dir: Option<PathBuf>,
    /// Original-profile/extension observation for the ordinary field workflow.
    /// It is mutually exclusive with `dedicated_profile_dir`.
    pub existing_profile: Option<ExistingProfileContext>,
    /// Target ID chosen from [`list_whatsapp_targets`].
    pub target_id: String,
    /// Fixed executable-relative `evidence/staging` directory.
    pub evidence_staging_dir: PathBuf,
    /// Fixed executable-relative `evidence/sealed` directory.
    pub evidence_sealed_dir: PathBuf,
    /// Portable password-encrypted Ed25519 keystore.
    pub keystore_path: PathBuf,
    /// Lowercase operator identifier stored in acquisition metadata.
    pub operator_id: String,
    /// Optional display name.
    pub operator_display_name: Option<String>,
    /// Case/authorization reference supplied by the operator.
    pub authorization_reference: String,
    /// UTC moment at which the operator confirmed authority.
    pub authorization_confirmed_at_utc: String,
    /// Required explicit consent for passive T0.
    pub passive_t0_consent: bool,
    /// Browser locale label.
    pub locale: String,
    /// Browser/field time-zone label.
    pub time_zone: String,
    /// Single-line source organization used in `BagIt` tags.
    pub source_organization: String,
    /// Stable, non-secret signing-key identifier.
    pub key_id: String,
    /// Signed Workstation configuration and assignment summary.
    pub portable_configuration: PortableConfigurationContext,
}

/// One-time, non-identifying operator gate issued after the fixed probe and
/// before any passive snapshot command or normalized evidence write.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfirmationChallenge {
    /// Random one-time code the operator must type back exactly.
    pub confirmation_code: String,
    /// The narrow claim supported by the observation.
    pub claim_scope: String,
    /// Account ownership/authenticity is never established by this gate.
    pub account_authenticity: String,
    /// `WhatsApp` Web build label visible to the fixed adapter.
    pub whatsapp_build: String,
    /// Fixed adapter selected by structural probing.
    pub adapter_id: String,
    /// Explicit read/write capability matrix.
    pub capabilities: CapabilityPayload,
    /// Operator instruction with no account identifier or evidence content.
    pub instruction: String,
}

/// Inputs for a capability-only inspection of one explicitly selected target.
///
/// This request has no output directory, signing key, operator identity, or
/// authorization metadata because inspection never starts T0 or creates an
/// Evidence Bag.
#[derive(Clone, Debug)]
pub struct TargetInspectionRequest {
    /// Explicit loopback CDP HTTP endpoint.
    pub endpoint: CdpEndpoint,
    /// Dedicated profile directory launched by this collector, or `None` for
    /// an independently authorised existing debugging endpoint.
    pub dedicated_profile_dir: Option<PathBuf>,
    /// Target ID chosen from [`list_whatsapp_targets`].
    pub target_id: String,
}

/// Sanitized result of the fixed, read-only capability probe.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetReadinessReport {
    /// Whether this exact attached page currently satisfies passive T0's fixed
    /// adapter and capability contract.
    pub ready_for_passive_t0: bool,
    /// The narrow observation claim; never an account identity assertion.
    pub claim_scope: String,
    /// Account ownership/authenticity is not established by inspection.
    pub account_authenticity: String,
    /// Inspection is not a substitute for collection-time human confirmation.
    pub authorization_assessment: String,
    /// Browser product/version label returned by the authorized endpoint.
    pub browser: String,
    /// Browser CDP protocol version.
    pub protocol_version: String,
    /// Bounded `WhatsApp` Web build label visible to the fixed adapter.
    pub whatsapp_build: String,
    /// Fixed adapter identifier, absent for an unsupported build.
    pub adapter_id: Option<String>,
    /// Explicit read/write capability matrix.
    pub capabilities: CapabilityPayload,
    /// Fixed allowlisted capability mismatch reason codes.
    pub reason_codes: Vec<String>,
    /// Evidence metadata mode implied by the supplied profile binding.
    pub browser_profile_mode: String,
    /// Explicit non-identifying limitations.
    pub warnings: Vec<String>,
    /// Always false: inspection cannot dispatch passive T0.
    pub collection_started: bool,
    /// Always false: inspection has no writer or output path.
    pub evidence_bag_created: bool,
}

/// Non-mutating checks plus create/delete write probes of the fixed evidence roots.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    /// Canonical `evidence/staging` directory.
    pub evidence_staging_dir: PathBuf,
    /// Canonical `evidence/sealed` directory.
    pub evidence_sealed_dir: PathBuf,
    /// Both fixed output probes were created, synced, and removed.
    pub output_writable: bool,
    /// Keystore exists and is a regular file (not yet decrypted).
    pub keystore_present: bool,
    /// Endpoint passed strict loopback URL parsing before any connection.
    pub loopback_endpoint: String,
    /// Evidence metadata mode derived from the explicitly supplied profile binding.
    pub browser_profile_mode: String,
    /// Hashed canonical dedicated profile reference; never the profile path itself.
    pub profile_reference_sha256: Option<String>,
    /// v0.1 does not yet have a cross-platform free-space API.
    pub available_space_bytes: Option<u64>,
    /// Explicit limitations to show before acquisition.
    pub warnings: Vec<String>,
}

/// Sealed acquisition handoff awaiting independent verification and promotion.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionResult {
    /// Exact-name bag directory nested below its `.partial` staging wrapper.
    /// This changes to the formal hand-off directory only after promotion.
    pub evidence_bag_path: PathBuf,
    /// One acquisition-package identity.
    pub evidence_id: Uuid,
    /// One observable browser source identity.
    pub source_id: Uuid,
    /// Cryptographic manifest root from `seal.json`.
    pub manifest_root_sha256: String,
    /// Signer fingerprint copied from the sealed bag.
    pub signer_fingerprint: String,
    /// Normalized record counts without evidence content.
    pub record_counts: std::collections::BTreeMap<String, u64>,
    /// Missing references observed during deterministic cross-checks.
    pub unresolved_reference_count: usize,
    /// State reached by the core. The app must now invoke the independent verifier.
    pub lifecycle_state: AcquisitionState,
    #[serde(skip)]
    sealed_bag: Option<SealedBag>,
}

impl AcquisitionResult {
    /// Promotes the sealed staging bag after the caller independently verifies
    /// and binds the verifier report to this result.
    ///
    /// No path is accepted from the caller. The writer-owned sealed handle fixes
    /// both source and destination, checks the staging tree, and performs a
    /// same-volume atomic rename.
    ///
    /// # Errors
    ///
    /// Returns an error unless the result is awaiting external verification, or
    /// if the fixed-path writer promotion fails closed.
    pub fn promote_verified(&mut self) -> Result<(), CollectorError> {
        if self.lifecycle_state != AcquisitionState::ExternalVerify {
            return Err(CollectorError::Protocol(
                "only an externally verified staging bag can be promoted".to_owned(),
            ));
        }
        let sealed = self.sealed_bag.as_ref().ok_or_else(|| {
            CollectorError::Protocol("sealed staging promotion handle is unavailable".to_owned())
        })?;
        if sealed.path != self.evidence_bag_path
            || sealed.evidence_id != self.evidence_id
            || sealed.manifest_root_sha256 != self.manifest_root_sha256
            || sealed.signer_fingerprint != self.signer_fingerprint
        {
            return Err(CollectorError::Protocol(
                "sealed staging handle does not match acquisition result".to_owned(),
            ));
        }
        let promoted = sealed.promote_verified()?;
        if promoted.evidence_id != self.evidence_id {
            return Err(CollectorError::Protocol(
                "promoted evidence identity changed unexpectedly".to_owned(),
            ));
        }
        self.evidence_bag_path = promoted.path;
        self.lifecycle_state = AcquisitionState::Complete;
        self.sealed_bag = None;
        Ok(())
    }
}

/// Failures from preflight, strict CDP, bridge validation, normalization, or sealing.
#[derive(Debug, Error)]
pub enum CollectorError {
    /// Preflight or operator input was invalid.
    #[error("preflight failed: {0}")]
    Preflight(String),
    /// Operator did not explicitly authorize passive T0.
    #[error("passive T0 requires explicit operator consent")]
    ConsentRequired,
    /// Operator rejected, abandoned, or mistyped the one-time visual confirmation.
    #[error("operator did not confirm the selected WhatsApp Web page")]
    AccountConfirmationRejected,
    /// Operator confirmation did not arrive within the fixed safety window.
    #[error("operator confirmation timed out")]
    AccountConfirmationTimedOut,
    /// Selected target disappeared or was not an eligible `WhatsApp` page.
    #[error("selected WhatsApp target was not found at the authorized endpoint")]
    TargetNotFound,
    /// Fixed injector/CDP result violated the protocol contract.
    #[error("collector protocol failed closed: {0}")]
    Protocol(String),
    /// The fixed Adapter did not recognize the current `WhatsApp` build or its
    /// required passive-T0 capability signature.
    #[error("current WhatsApp Web version is not supported by this Adapter")]
    UnsupportedWhatsAppVersion {
        /// Bounded non-content build label reported by the fixed probe.
        build: String,
        /// Fixed allowlisted diagnostic reason codes.
        reason_codes: Vec<String>,
    },
    /// A navigation/context/target event invalidated the source lock.
    #[error("target lock invalidated: {0}")]
    TargetInvalidated(String),
    /// Direct browser protocol failure.
    #[error(transparent)]
    Browser(#[from] BrowserCdpError),
    /// Page-frame validation failure.
    #[error(transparent)]
    Bridge(#[from] BridgeError),
    /// Host whitelist/normalization failure.
    #[error(transparent)]
    Normalization(#[from] NormalizationError),
    /// Evidence Bag writer failure.
    #[error(transparent)]
    Writer(#[from] WaebError),
    /// Portable signing-key failure.
    #[error(transparent)]
    Keystore(#[from] KeystoreError),
    /// Internal lifecycle transition failure.
    #[error(transparent)]
    State(#[from] StateError),
    /// Local I/O failure outside the Evidence Bag writer.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Checks the fixed portable evidence roots and keystore before connecting to Chromium.
///
/// # Errors
///
/// Returns an error when request metadata is invalid, either fixed evidence
/// directory is unsafe/unwritable, or the keystore is unavailable or unsafe.
pub fn preflight(request: &AcquisitionRequest) -> Result<PreflightReport, CollectorError> {
    validate_request(request)?;
    let (browser_profile_mode, profile_reference_sha256) = profile_evidence_metadata(request)?;
    let evidence_staging_dir =
        canonical_portable_directory(&request.evidence_staging_dir, "evidence/staging")?;
    let evidence_sealed_dir =
        canonical_portable_directory(&request.evidence_sealed_dir, "evidence/sealed")?;
    validate_portable_layout(
        &evidence_staging_dir,
        &evidence_sealed_dir,
        &request.keystore_path,
    )?;
    probe_writable_directory(&evidence_staging_dir)?;
    probe_writable_directory(&evidence_sealed_dir)?;

    let key_metadata = fs::symlink_metadata(&request.keystore_path)
        .map_err(|error| CollectorError::Preflight(format!("keystore is unavailable: {error}")))?;
    if !key_metadata.is_file() || key_metadata.file_type().is_symlink() {
        return Err(CollectorError::Preflight(
            "keystore must be a regular non-symlink file".to_owned(),
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if key_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(CollectorError::Preflight(
                "keystore cannot be a Windows reparse point".to_owned(),
            ));
        }
    }
    let available_space_bytes = available_space_bytes(&evidence_sealed_dir);
    Ok(PreflightReport {
        evidence_staging_dir,
        evidence_sealed_dir,
        output_writable: true,
        keystore_present: true,
        loopback_endpoint: request.endpoint.as_url().to_string(),
        browser_profile_mode,
        profile_reference_sha256,
        available_space_bytes,
        warnings: if available_space_bytes.is_some() {
            Vec::new()
        } else {
            vec!["available_space_unavailable".to_owned()]
        },
    })
}

/// Returns the current user's available bytes on the volume containing `path`.
///
/// Windows uses the inbox, absolute-path Windows `PowerShell` executable with a
/// fixed script and a task-specific environment variable. Failure is reported
/// as `None` and never weakens the fixed-path write probe.
#[must_use]
#[cfg(windows)]
pub fn available_space_bytes(path: &std::path::Path) -> Option<u64> {
    let system_root = std::env::var_os("SystemRoot")?;
    let executable =
        PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let metadata = fs::symlink_metadata(&executable).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
        return None;
    }
    let output = Command::new(executable)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write([IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:WAFC_SPACE_PATH)).AvailableFreeSpace)",
        ])
        .env("WAFC_SPACE_PATH", path.as_os_str())
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > 32 || !output.stderr.is_empty() {
        return None;
    }
    std::str::from_utf8(&output.stdout).ok()?.parse().ok()
}

/// Non-Windows builds cannot satisfy the Windows-first portable volume check.
#[must_use]
#[cfg(not(windows))]
pub const fn available_space_bytes(_path: &std::path::Path) -> Option<u64> {
    None
}

fn canonical_portable_directory(
    path: &std::path::Path,
    label: &str,
) -> Result<PathBuf, CollectorError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CollectorError::Preflight(format!("{label} is unavailable: {error}")))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
        return Err(CollectorError::Preflight(format!(
            "{label} must be a real non-reparse directory"
        )));
    }
    fs::canonicalize(path).map_err(CollectorError::Io)
}

fn validate_portable_layout(
    staging: &std::path::Path,
    sealed: &std::path::Path,
    keystore: &std::path::Path,
) -> Result<(), CollectorError> {
    let evidence = staging
        .parent()
        .ok_or_else(|| CollectorError::Preflight("evidence/staging has no parent".to_owned()))?;
    if staging.file_name().and_then(|value| value.to_str()) != Some("staging")
        || sealed.file_name().and_then(|value| value.to_str()) != Some("sealed")
        || sealed.parent() != Some(evidence)
        || evidence.file_name().and_then(|value| value.to_str()) != Some("evidence")
    {
        return Err(CollectorError::Preflight(
            "evidence output must use the fixed evidence/staging and evidence/sealed layout"
                .to_owned(),
        ));
    }
    let portable_root = evidence.parent().ok_or_else(|| {
        CollectorError::Preflight("portable evidence directory has no root".to_owned())
    })?;
    let canonical_key = fs::canonicalize(keystore)?;
    if canonical_key.file_name().and_then(|value| value.to_str()) != Some("operator-key.enc")
        || canonical_key
            .parent()
            .and_then(std::path::Path::file_name)
            .and_then(|value| value.to_str())
            != Some("config")
        || canonical_key.parent().and_then(std::path::Path::parent) != Some(portable_root)
    {
        return Err(CollectorError::Preflight(
            "operator key must use the fixed config/operator-key.enc path".to_owned(),
        ));
    }
    Ok(())
}

fn probe_writable_directory(directory: &std::path::Path) -> Result<(), CollectorError> {
    let marker = directory.join(format!(".wafc-preflight-{}.tmp", Uuid::new_v4()));
    let mut probe = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)?;
    let marker_bytes = b"WAFC-PREFLIGHT-v1\n";
    debug_assert!(marker_bytes.len() <= MAX_OUTPUT_MARKER_BYTES);
    probe.write_all(marker_bytes)?;
    probe.sync_all()?;
    drop(probe);
    fs::remove_file(marker)?;
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

/// Inspects one selected `WhatsApp` target with the fixed read-only capability
/// probe, without starting T0, opening a keystore, or creating output files.
///
/// The result deliberately omits the controller's ephemeral account binding
/// and cannot establish account identity, ownership, authorization, or account-
/// level completeness. A later collection still requires the same-session
/// visual confirmation gate.
///
/// # Errors
///
/// Returns an error for an invalid target/profile binding, a target lifecycle
/// change, a malformed fixed-probe response, or unconfirmed CDP teardown.
pub async fn inspect_target(
    request: &TargetInspectionRequest,
) -> Result<TargetReadinessReport, CollectorError> {
    validate_target_id(&request.target_id)?;
    let browser_profile_mode = if let Some(profile_dir) = &request.dedicated_profile_dir {
        verify_dedicated_profile_binding(profile_dir, &request.endpoint)?;
        "dedicated_acquisition"
    } else {
        "authorized_existing"
    };
    let version = get_version(&request.endpoint).await?;
    let target = find_target(&request.endpoint, &request.target_id).await?;
    let session = CdpSession::connect(&request.endpoint, &version.web_socket_debugger_url).await?;
    let mut events = session.subscribe();
    let attached_id = match session.attach_to_target(&target.id).await {
        Ok(value) => value,
        Err(error) => {
            let close_error = session.close().await.err();
            if let Some(close_error) = close_error {
                return Err(CollectorError::Protocol(format!(
                    "CDP transport closure was not confirmed after inspection attach failure: {}",
                    bounded_browser_error(&close_error)
                )));
            }
            return Err(error.into());
        }
    };

    let attached_probe =
        probe_attached_controller(&session, &attached_id, &target, &mut events).await;
    let attached_probe = match attached_probe {
        Ok(value) => value,
        Err(error) => {
            cleanup_attached_session(&session, &attached_id, None, "failed inspection probe")
                .await?;
            return Err(error);
        }
    };

    let inspection_result = build_target_readiness_report(
        &session,
        &attached_id,
        &mut events,
        &attached_probe,
        &version,
        browser_profile_mode,
    )
    .await;

    cleanup_attached_session(
        &session,
        &attached_id,
        Some(&attached_probe.object_id),
        "target inspection",
    )
    .await?;
    inspection_result
}

async fn build_target_readiness_report(
    session: &CdpSession,
    attached_id: &str,
    events: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    attached_probe: &AttachedProbe,
    version: &BrowserVersion,
    browser_profile_mode: &str,
) -> Result<TargetReadinessReport, CollectorError> {
    ensure_target_stable(events, attached_id, &attached_probe.target_lock)?;
    verify_frame_tree_lock(session, attached_id, &attached_probe.target_lock).await?;
    let origin = evaluate_value(session, attached_id, ORIGIN_EXPRESSION, false).await?;
    if origin.as_str() != Some("https://web.whatsapp.com") {
        return Err(CollectorError::TargetInvalidated(
            "origin changed during target inspection".to_owned(),
        ));
    }
    if attached_probe.probe.supported {
        validate_probe(&attached_probe.probe)?;
        let account_binding = attached_probe.account_binding.as_ref().ok_or_else(|| {
            CollectorError::Protocol(
                "supported inspection probe omitted internal account binding".to_owned(),
            )
        })?;
        verify_live_account_binding(
            session,
            attached_id,
            &attached_probe.object_id,
            &attached_probe.controller_session_id,
            account_binding,
        )
        .await?;
        ensure_target_stable(events, attached_id, &attached_probe.target_lock)?;
        verify_frame_tree_lock(session, attached_id, &attached_probe.target_lock).await?;
    } else if attached_probe.account_binding.is_some() {
        return Err(CollectorError::Protocol(
            "unsupported inspection probe exposed an account binding".to_owned(),
        ));
    }

    let mut warnings = vec![
        "capability_readiness_only".to_owned(),
        "human_confirmation_still_required_at_collection".to_owned(),
        "account_identity_ownership_and_authorization_unverified".to_owned(),
        "no_collection_or_evidence_output".to_owned(),
    ];
    if attached_probe.probe_ack_retried {
        warnings.push("probe_ack_timeout_retried".to_owned());
    }
    Ok(TargetReadinessReport {
        ready_for_passive_t0: attached_probe.probe.supported,
        claim_scope: "browser_page_observation".to_owned(),
        account_authenticity: "unverified".to_owned(),
        authorization_assessment: "not_assessed".to_owned(),
        browser: bounded_label(&version.browser, 160),
        protocol_version: bounded_label(&version.protocol_version, 80),
        whatsapp_build: bounded_label(&attached_probe.probe.build, 160),
        adapter_id: attached_probe.probe.adapter_id.clone(),
        capabilities: attached_probe.probe.capabilities.clone(),
        reason_codes: attached_probe.probe.reasons.clone(),
        browser_profile_mode: browser_profile_mode.to_owned(),
        warnings,
        collection_started: false,
        evidence_bag_created: false,
    })
}

/// Runs one passive, source-bound T0 acquisition and creates a signed WAEB v1 bag.
///
/// The returned bag is mathematically unverified by this crate. The caller must
/// invoke the separately built `waeb-verify` executable before reporting success.
///
/// # Errors
///
/// Returns an error for any failed preflight, target-lock, fixed CDP/bridge,
/// normalization, keystore, evidence-writing, or sealing operation. Failures
/// after writer creation retain only a `.partial` staging directory.
#[allow(clippy::too_many_lines)]
pub async fn collect_t0<F, Fut>(
    request: &AcquisitionRequest,
    keystore_passphrase: &str,
    confirmation_gate: F,
) -> Result<AcquisitionResult, CollectorError>
where
    F: FnOnce(AccountConfirmationChallenge) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    let mut state = StateMachine::default();
    state.transition(AcquisitionState::Preflight)?;
    let report = preflight(request)?;

    let version = get_version(&request.endpoint).await?;
    state.transition(AcquisitionState::EndpointAuthorized)?;
    let target = find_selected_target(request).await?;
    state.transition(AcquisitionState::TargetSelected)?;
    if !request.passive_t0_consent {
        return Err(CollectorError::ConsentRequired);
    }
    state.transition(AcquisitionState::T0Consent)?;

    let session = CdpSession::connect(&request.endpoint, &version.web_socket_debugger_url).await?;
    // Subscribe before attaching so no target lifecycle event can fall into an
    // unobserved window between attachment and the first target-lock check.
    let mut events = session.subscribe();
    let attached_id = match session.attach_to_target(&target.id).await {
        Ok(value) => value,
        Err(error) => {
            let _ = session.close().await;
            return Err(error.into());
        }
    };
    state.transition(AcquisitionState::Attached)?;

    let prepared = prepare_attached_t0(
        &session,
        &attached_id,
        &target,
        &mut events,
        &mut state,
        confirmation_gate,
    )
    .await;
    let prepared = match prepared {
        Ok(value) => value,
        Err(error) => {
            let _ = session.detach_from_target(&attached_id).await;
            let close_error = session.close().await.err();
            if let Some(close_error) = close_error {
                return Err(CollectorError::Protocol(format!(
                    "CDP transport closure was not confirmed after rejected probe: {}",
                    bounded_browser_error(&close_error)
                )));
            }
            return Err(error);
        }
    };

    if let Err(error) = validate_existing_profile_probe(request, &version, &prepared.probe) {
        cleanup_attached_session(
            &session,
            &attached_id,
            Some(&prepared.object_id),
            "profile and extension binding mismatch",
        )
        .await?;
        return Err(error);
    }

    let initialized = (|| -> Result<_, CollectorError> {
        let signing_key = unlock(&request.keystore_path, keystore_passphrase)?;
        validate_unlocked_keystore(request, &signing_key)?;
        let evidence_id = Uuid::new_v4();
        let acquisition_id = Uuid::new_v4();
        let source_id = Uuid::new_v4();
        let log_session_id = Uuid::new_v4();
        let started = Instant::now();
        let collector_hash = current_executable_sha256()?;
        let injector_hash = sha256_hex(INJECTOR.as_bytes());
        let audit = AuditContext {
            evidence_id,
            acquisition_id,
            source_id,
            portable_bundle_id: request.portable_configuration.bundle_id,
            portable_manifest_sha256: request
                .portable_configuration
                .bundle_manifest_sha256
                .clone(),
            assignment_id: request.portable_configuration.assignment_id.clone(),
            assignment_sha256: request.portable_configuration.assignment_sha256.clone(),
            workstation_key_fingerprint_sha256: request
                .portable_configuration
                .workstation_key_fingerprint_sha256
                .clone(),
            operator_key_fingerprint_sha256: request
                .portable_configuration
                .operator_key_fingerprint_sha256
                .clone(),
            operator_id_sha256: audit_digest("operator_id", &request.operator_id),
            authorization_reference_sha256: audit_digest(
                "authorization_reference",
                &request.authorization_reference,
            ),
            collector_version: COLLECTOR_VERSION.to_owned(),
            collector_sha256: collector_hash.clone(),
            injector_version: page_bridge::CONTROLLER_VERSION.to_owned(),
            injector_sha256: injector_hash.clone(),
            browser_family: browser_family(&version).to_owned(),
            browser_version: bounded_label(&version.browser, 120),
            browser_profile_mode: report.browser_profile_mode.clone(),
            browser_profile_reference_sha256: report.profile_reference_sha256.clone(),
            browser_profile_original_state: request.existing_profile.as_ref().map(|context| {
                if context.browser_product_was_running {
                    "browser_product_running_profile_state_unverifiable".to_owned()
                } else {
                    "browser_product_not_running".to_owned()
                }
            }),
            browser_opened_at_utc: request
                .existing_profile
                .as_ref()
                .map(|context| context.browser_opened_at_utc.clone()),
            extension_version: request
                .existing_profile
                .as_ref()
                .map(|context| context.extension_version.clone()),
            adapter_id: prepared.probe.adapter_id.clone(),
            adapter_version: Some(
                request
                    .existing_profile
                    .as_ref()
                    .map_or_else(|| "1".to_owned(), |context| context.adapter_version.clone()),
            ),
            whatsapp_build: Some(bounded_label(&prepared.probe.build, 160)),
        };
        let mut writer = WaebWriter::create_with_roots(
            &report.evidence_staging_dir,
            &report.evidence_sealed_dir,
            evidence_id,
        )?;
        append_log(
            &mut writer,
            &audit,
            log_session_id,
            started,
            LogEventType::AcquisitionStarted,
            &json!({
                "mode": "passive_t0",
                "claim_scope": "browser_page_observation",
                "account_authenticity": "unverified",
                "profile_original_state": audit.browser_profile_original_state,
                "browser_opened_at_utc": audit.browser_opened_at_utc,
                "extension_installation": request.existing_profile.as_ref().map(|_| "operator_loaded_unpacked_extension_in_selected_profile"),
                "extension_version": audit.extension_version,
                "profile_impact_codes": request.existing_profile.as_ref().map(|_| original_profile_impacts().join(",")),
            }),
        )?;
        if prepared.probe_ack_retried {
            append_log(
                &mut writer,
                &audit,
                log_session_id,
                started,
                LogEventType::Warning,
                &json!({
                    "code": "bridge_ack_timeout_retry",
                    "frame_sequence": "0",
                    "frame_kind": "probe_result",
                    "retry_count": 1,
                }),
            )?;
        }
        append_log(
            &mut writer,
            &audit,
            log_session_id,
            started,
            LogEventType::CapabilityProbeCompleted,
            &json!({
                "supported": prepared.probe.supported,
                "adapter": prepared.probe.adapter_id.clone().unwrap_or_default(),
                "build": prepared.probe.build.clone(),
            }),
        )?;
        Ok((
            signing_key,
            evidence_id,
            acquisition_id,
            source_id,
            log_session_id,
            started,
            collector_hash,
            injector_hash,
            audit,
            writer,
        ))
    })();
    let (
        signing_key,
        evidence_id,
        acquisition_id,
        source_id,
        log_session_id,
        started,
        collector_hash,
        injector_hash,
        audit,
        mut writer,
    ) = match initialized {
        Ok(value) => value,
        Err(error) => {
            let _ = release_controller_object(&session, &attached_id, &prepared.object_id).await;
            let _ = session.detach_from_target(&attached_id).await;
            let _ = session.close().await;
            return Err(error);
        }
    };

    let session_outcome = run_prepared_t0(
        &session,
        &attached_id,
        &mut events,
        prepared,
        &mut writer,
        &audit,
        source_id,
        log_session_id,
        started,
        &mut state,
    )
    .await;

    let teardown_started_log = append_log(
        &mut writer,
        &audit,
        log_session_id,
        started,
        LogEventType::PhaseStarted,
        &json!({"phase": "teardown"}),
    );
    let detach_error = session.detach_from_target(&attached_id).await.err();
    let close_error = session.close().await.err();
    let teardown_warning_log = match (&detach_error, &close_error) {
        (None, None) => Ok(()),
        (detach, close) => append_log(
            &mut writer,
            &audit,
            log_session_id,
            started,
            LogEventType::Warning,
            &json!({
                "code": "cdp_teardown_degraded",
                "detach_error": detach.as_ref().map(bounded_browser_error),
                "transport_close_error": close.as_ref().map(bounded_browser_error),
            }),
        ),
    };
    let session_outcome = match session_outcome {
        Ok(value) => value,
        Err(error) => {
            let _ = state.transition(AcquisitionState::FailedStaging);
            let _ = append_log(
                &mut writer,
                &audit,
                log_session_id,
                started,
                LogEventType::Warning,
                &json!({"code": "t0_failed", "detail": bounded_error(&error)}),
            );
            return Err(error);
        }
    };
    teardown_started_log?;
    teardown_warning_log?;
    if let Some(error) = close_error {
        let _ = state.transition(AcquisitionState::FailedStaging);
        return Err(CollectorError::Protocol(format!(
            "CDP transport closure was not confirmed: {}",
            bounded_browser_error(&error)
        )));
    }

    for (name, count) in &session_outcome.normalization.record_counts {
        append_log(
            &mut writer,
            &audit,
            log_session_id,
            started,
            LogEventType::DatasetCompleted,
            &json!({"dataset": name, "record_count": count}),
        )?;
    }
    append_log(
        &mut writer,
        &audit,
        log_session_id,
        started,
        LogEventType::AcquisitionCompleted,
        &json!({
            "mode": "passive_t0",
            "history_scope": "not_run",
            "media_scope": "not_requested",
            "runtime_object_released": session_outcome.runtime_object_released,
            "detach_status": if detach_error.is_none() { "confirmed" } else { "failed_transport_closed" },
            "transport_close_status": "confirmed",
            "seal_status": "pending",
        }),
    )?;
    state.transition(AcquisitionState::Finalizing)?;

    let finished_at = utc_now();
    let observation_window = ObservationWindowDto {
        started_at_utc: session_outcome.stream_start.observed_at.clone(),
        ended_at_utc: session_outcome.stream_end.completed_at.clone(),
    };
    writer.write_capabilities(&capabilities_dto(
        source_id,
        &session_outcome.probe,
        &session_outcome.probed_at,
    ))?;
    let dispositions = dataset_dispositions(&session_outcome.normalization, &observation_window);
    writer.write_dataset_inventory(source_id, &finished_at, &dispositions)?;

    let references_resolved = session_outcome.normalization.unresolved_reference_count == 0;
    writer.write_completeness(&CompletenessDto {
        schema_version: SCHEMA_VERSION.to_owned(),
        source_id,
        evaluated_at_utc: finished_at.clone(),
        overall: "partial".to_owned(),
        local_snapshot: "verified".to_owned(),
        history_scope: "not_run".to_owned(),
        media_scope: "not_requested".to_owned(),
        account_scope: "unverifiable".to_owned(),
        dataset_inventory_path: "data/dataset-inventory.json".to_owned(),
        chat_completeness_path: "data/completeness/chats.ndjson".to_owned(),
        media_counts: MediaCountsDto {
            requested: 0,
            full: 0,
            thumbnail: 0,
            missing: 0,
            expired: 0,
            decrypt_error: 0,
            not_requested: session_outcome.normalization.media_not_requested_count,
        },
        cross_checks: CrossChecksDto {
            inventory_counts_match: true,
            media_index_matches_cas: true,
            normalized_refs_resolved: references_resolved,
            differences: if references_resolved {
                Vec::new()
            } else {
                vec![format!(
                    "{} normalized references were not observable in passive T0",
                    session_outcome.normalization.unresolved_reference_count
                )]
            },
        },
        reason_codes: vec![
            "passive_t0_only".to_owned(),
            "history_not_run".to_owned(),
            "media_not_requested".to_owned(),
            "account_scope_unverifiable".to_owned(),
        ],
    })?;

    let log = writer.log_state()?;
    writer.write_acquisition(&AcquisitionDto {
        schema_version: SCHEMA_VERSION.to_owned(),
        wa_evidence_bag_version: WAEB_VERSION.to_owned(),
        evidence_id,
        acquisition_id,
        source_id,
        synthetic: false,
        fixture: None,
        collector: ComponentDto {
            name: "wafc-field-collector".to_owned(),
            version: COLLECTOR_VERSION.to_owned(),
            sha256: collector_hash,
        },
        injector: ComponentDto {
            name: "wafc-page-injector".to_owned(),
            version: page_bridge::CONTROLLER_VERSION.to_owned(),
            sha256: injector_hash.clone(),
        },
        adapter: ComponentDto {
            name: session_outcome.probe.adapter_id.clone().ok_or_else(|| {
                CollectorError::Protocol("supported probe omitted adapter ID".to_owned())
            })?,
            version: request
                .existing_profile
                .as_ref()
                .map_or_else(|| "1".to_owned(), |context| context.adapter_version.clone()),
            // The adapter implementation is compiled into the fixed injector
            // artifact; use that artifact digest instead of hashing its label.
            sha256: request
                .existing_profile
                .as_ref()
                .map_or(injector_hash, |context| context.adapter_sha256.clone()),
        },
        environment: EnvironmentDto {
            os: OsDto {
                family: "windows".to_owned(),
                version: operating_system_version(),
                architecture: architecture_label().to_owned(),
            },
            browser: BrowserDto {
                family: browser_family(&version).to_owned(),
                version: version.browser.clone(),
                profile_mode: report.browser_profile_mode,
                profile_reference_sha256: report.profile_reference_sha256,
                debug_transport: "loopback_websocket".to_owned(),
            },
            whatsapp_build: session_outcome.probe.build.clone(),
            locale: request.locale.clone(),
            time_zone: request.time_zone.clone(),
        },
        operator: OperatorDto {
            operator_id: request.operator_id.clone(),
            display_name: request.operator_display_name.clone(),
        },
        authorization: AuthorizationDto {
            reference: request.authorization_reference.clone(),
            confirmed_at_utc: request.authorization_confirmed_at_utc.clone(),
        },
        portable_configuration: PortableConfigurationDto {
            bundle_id: request.portable_configuration.bundle_id,
            bundle_manifest_sha256: request
                .portable_configuration
                .bundle_manifest_sha256
                .clone(),
            assignment_id: request.portable_configuration.assignment_id.clone(),
            assignment_sha256: request.portable_configuration.assignment_sha256.clone(),
            workstation_key_fingerprint_sha256: request
                .portable_configuration
                .workstation_key_fingerprint_sha256
                .clone(),
        },
        observation_window,
        acquisition_mode: AcquisitionModeDto {
            baseline: true,
            enrichment_requested: false,
            ui_fallback_allowed: false,
        },
        log: AcquisitionLogDto {
            path: "data/logs/acquisition.ndjson".to_owned(),
            event_count: log.event_count,
            terminal_event_hash: log.terminal_event_hash.ok_or_else(|| {
                CollectorError::Protocol("acquisition log has no terminal hash".to_owned())
            })?,
        },
        privacy: PrivacyDto {
            normalized_whitelist: true,
            omitted_field_classes: vec![
                "media_keys".to_owned(),
                "access_tokens".to_owned(),
                "direct_urls".to_owned(),
                "cookies".to_owned(),
                "credentials".to_owned(),
                "debug_secrets".to_owned(),
            ],
            restricted_raw_included: false,
        },
        extensions: request.existing_profile.as_ref().map(|context| {
            json!({
                "org.whatsapp-forensics.wafc": {
                    "acquisitionTransport": "mv3_active_tab_loopback",
                    "transportProtocol": context.transport_protocol,
                    "profileSelectionBasis": "chromium_local_state_and_operator_selection",
                    "profileOriginalState": if context.browser_product_was_running {
                        "browser_product_running_profile_state_unverifiable"
                    } else {
                        "browser_product_not_running"
                    },
                    "browserOpenedAtUtc": context.browser_opened_at_utc,
                    "extensionInstallation": "operator_loaded_unpacked_extension_in_selected_profile",
                    "extensionActivation": "operator_clicked_current_whatsapp_tab",
                    "extensionPairedAtUtc": context.extension_paired_at_utc,
                    "extensionVersion": context.extension_version,
                    "adapterId": context.adapter_id,
                    "adapterVersion": context.adapter_version,
                    "adapterSha256": context.adapter_sha256,
                    "possibleProfileImpacts": original_profile_impacts(),
                    "traceClaim": "state_changes_and_network_sync_are_possible"
                }
            })
        }),
    })?;

    let sealed = writer.seal(
        &signing_key.signing_key,
        &SealOptions {
            created_at_utc: finished_at,
            bagging_date: Utc::now().date_naive().format("%Y-%m-%d").to_string(),
            software_agent: format!("WAFC Field Collector {COLLECTOR_VERSION}"),
            source_organization: request.source_organization.clone(),
            key_id: request.key_id.clone(),
            synthetic_key: false,
        },
    )?;
    state.transition(AcquisitionState::ExternalVerify)?;
    Ok(acquisition_result(
        sealed,
        source_id,
        session_outcome.normalization,
        state.current(),
    ))
}

struct SessionOutcome {
    probe: ProbeResultPayload,
    probed_at: String,
    stream_start: StreamStartPayload,
    stream_end: StreamEndPayload,
    normalization: NormalizationSummary,
    runtime_object_released: bool,
}

struct AuditContext {
    evidence_id: Uuid,
    acquisition_id: Uuid,
    source_id: Uuid,
    portable_bundle_id: Uuid,
    portable_manifest_sha256: String,
    assignment_id: String,
    assignment_sha256: String,
    workstation_key_fingerprint_sha256: String,
    operator_key_fingerprint_sha256: String,
    operator_id_sha256: String,
    authorization_reference_sha256: String,
    collector_version: String,
    collector_sha256: String,
    injector_version: String,
    injector_sha256: String,
    browser_family: String,
    browser_version: String,
    browser_profile_mode: String,
    browser_profile_reference_sha256: Option<String>,
    browser_profile_original_state: Option<String>,
    browser_opened_at_utc: Option<String>,
    extension_version: Option<String>,
    adapter_id: Option<String>,
    adapter_version: Option<String>,
    whatsapp_build: Option<String>,
}

#[derive(Debug)]
struct TargetLock {
    target_id: String,
    main_frame_id: String,
    url: String,
}

#[derive(Clone, Copy)]
enum EventPhase {
    Initial,
    Injected,
}

struct PreparedT0 {
    target_lock: TargetLock,
    object_id: String,
    controller_session_id: String,
    validator: FrameValidator,
    probe: ProbeResultPayload,
    probed_at: String,
    account_binding: [u8; 32],
    probe_ack_retried: bool,
}

struct AttachedProbe {
    target_lock: TargetLock,
    object_id: String,
    controller_session_id: String,
    validator: FrameValidator,
    probe: ProbeResultPayload,
    probed_at: String,
    account_binding: Option<[u8; 32]>,
    probe_ack_retried: bool,
}

#[allow(clippy::too_many_lines)]
async fn probe_attached_controller(
    session: &CdpSession,
    attached_id: &str,
    target: &CdpTarget,
    events: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
) -> Result<AttachedProbe, CollectorError> {
    session
        .request("Runtime.enable", json!({}), Some(attached_id))
        .await?;
    session
        .request("Page.enable", json!({}), Some(attached_id))
        .await?;
    let target_lock = lock_main_frame(session, attached_id, target).await?;
    let origin = evaluate_value(session, attached_id, ORIGIN_EXPRESSION, false).await?;
    if origin.as_str() != Some("https://web.whatsapp.com") || !is_whatsapp_web_url(&target.url) {
        return Err(CollectorError::TargetInvalidated(
            "origin differs from the selected WhatsApp target".to_owned(),
        ));
    }
    consume_initial_events(events, attached_id, &target_lock)?;

    let injection = session
        .runtime_evaluate(attached_id, INJECTOR, false, false)
        .await?;
    ensure_target_stable(events, attached_id, &target_lock)?;
    let object_id = extract_object_id(&injection)?;
    let probe_result: Result<AttachedProbe, CollectorError> = async {
        let dispatch = call_value(
            session,
            attached_id,
            DISPATCH_FUNCTION,
            &object_id,
            &[json!({"value": "probe"})],
        )
        .await?;
        let controller_session_id = successful_dispatch_session(&dispatch)?;
        let mut validator = FrameValidator::new(controller_session_id.clone())?;
        ensure_target_stable(events, attached_id, &target_lock)?;
        let probe_frame = pull_frame(session, attached_id, &object_id).await?;
        if validator.receive(&probe_frame)? != ReceiveOutcome::Accepted
            || probe_frame.kind != FrameKind::ProbeResult
        {
            return Err(CollectorError::Protocol(
                "first controller frame was not a new probe result".to_owned(),
            ));
        }
        let probe: ProbeResultPayload = serde_json::from_str(&probe_frame.payload)
            .map_err(|error| CollectorError::Protocol(format!("invalid probe payload: {error}")))?;
        let account_binding = probe
            .account_binding_sha256
            .as_deref()
            .map(decode_account_binding)
            .transpose()?;
        ensure_target_stable(events, attached_id, &target_lock)?;
        let probe_ack_retried = acknowledge_frame_raw(
            session,
            attached_id,
            &object_id,
            &probe_frame,
            &mut validator,
        )
        .await?;
        Ok(AttachedProbe {
            target_lock,
            object_id: object_id.clone(),
            controller_session_id,
            validator,
            probe,
            probed_at: utc_now(),
            account_binding,
            probe_ack_retried,
        })
    }
    .await;

    match probe_result {
        Ok(probe) => Ok(probe),
        Err(error) => {
            if let Err(release_error) =
                release_controller_object(session, attached_id, &object_id).await
            {
                return Err(CollectorError::Protocol(format!(
                    "probe failed and Runtime.releaseObject was not confirmed: {}",
                    bounded_browser_error(&release_error)
                )));
            }
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_lines)]
async fn prepare_attached_t0<F, Fut>(
    session: &CdpSession,
    attached_id: &str,
    target: &CdpTarget,
    events: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    state: &mut StateMachine,
    confirmation_gate: F,
) -> Result<PreparedT0, CollectorError>
where
    F: FnOnce(AccountConfirmationChallenge) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    state.transition(AcquisitionState::Probe)?;
    let attached_probe = probe_attached_controller(session, attached_id, target, events).await?;
    let object_id = attached_probe.object_id.clone();
    let prepared_result: Result<PreparedT0, CollectorError> = async {
        validate_probe(&attached_probe.probe)?;
        let account_binding = attached_probe.account_binding.ok_or_else(|| {
            CollectorError::Protocol("probe omitted internal account binding".to_owned())
        })?;
        let adapter_id = attached_probe.probe.adapter_id.clone().ok_or_else(|| {
            CollectorError::Protocol("supported probe omitted adapter ID".to_owned())
        })?;
        let confirmation_code = new_confirmation_code();
        let challenge = AccountConfirmationChallenge {
            confirmation_code: confirmation_code.clone(),
            claim_scope: "browser_page_observation".to_owned(),
            account_authenticity: "unverified".to_owned(),
            whatsapp_build: bounded_label(&attached_probe.probe.build, 160),
            adapter_id,
            capabilities: attached_probe.probe.capabilities.clone(),
            instruction: "Visually verify the selected WhatsApp Web page, then type the one-time code exactly to continue passive T0."
                .to_owned(),
        };
        await_operator_confirmation(
            confirmation_gate(challenge),
            &confirmation_code,
            events,
            attached_id,
            &attached_probe.target_lock,
        )
        .await?;
        ensure_target_stable(events, attached_id, &attached_probe.target_lock)?;
        verify_frame_tree_lock(session, attached_id, &attached_probe.target_lock).await?;
        let confirmed_origin =
            evaluate_value(session, attached_id, ORIGIN_EXPRESSION, false).await?;
        if confirmed_origin.as_str() != Some("https://web.whatsapp.com") {
            return Err(CollectorError::TargetInvalidated(
                "origin changed during operator confirmation".to_owned(),
            ));
        }
        verify_live_account_binding(
            session,
            attached_id,
            &object_id,
            &attached_probe.controller_session_id,
            &account_binding,
        )
        .await?;
        ensure_target_stable(events, attached_id, &attached_probe.target_lock)?;
        let mut probe = attached_probe.probe;
        probe.account_binding_sha256 = None;
        Ok(PreparedT0 {
            target_lock: attached_probe.target_lock,
            object_id: attached_probe.object_id,
            controller_session_id: attached_probe.controller_session_id,
            validator: attached_probe.validator,
            probe,
            probed_at: attached_probe.probed_at,
            account_binding,
            probe_ack_retried: attached_probe.probe_ack_retried,
        })
    }
    .await;

    match prepared_result {
        Ok(prepared) => Ok(prepared),
        Err(error) => {
            if let Err(release_error) =
                release_controller_object(session, attached_id, &object_id).await
            {
                return Err(CollectorError::Protocol(format!(
                    "probe failed and Runtime.releaseObject was not confirmed: {}",
                    bounded_browser_error(&release_error)
                )));
            }
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_lines)]
async fn run_prepared_t0(
    session: &CdpSession,
    attached_id: &str,
    events: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    prepared: PreparedT0,
    writer: &mut WaebWriter,
    audit: &AuditContext,
    source_id: Uuid,
    log_session_id: Uuid,
    started: Instant,
    state: &mut StateMachine,
) -> Result<SessionOutcome, CollectorError> {
    let PreparedT0 {
        target_lock,
        object_id,
        controller_session_id,
        mut validator,
        probe,
        probed_at,
        account_binding,
        ..
    } = prepared;
    let controller_result: Result<SessionOutcome, CollectorError> = async {
        state.transition(AcquisitionState::T0)?;
        append_log(
            writer,
            audit,
            log_session_id,
            started,
            LogEventType::PhaseStarted,
            &json!({"phase": "t0", "network_actions": false, "dom_writes": false}),
        )?;
        let dispatch = call_value(
            session,
            attached_id,
            DISPATCH_FUNCTION,
            &object_id,
            &[json!({"value": "start_t0"})],
        )
        .await?;
        let t0_session_id = successful_dispatch_session(&dispatch)?;
        if t0_session_id != controller_session_id {
            return Err(CollectorError::Protocol(
                "controller session changed between probe and passive T0".to_owned(),
            ));
        }

        let mut normalizer = Normalizer::new(source_id);
        let mut stream_start = None;
        let mut stream_end = None;
        loop {
            ensure_target_stable(events, attached_id, &target_lock)?;
            let frame = pull_frame(session, attached_id, &object_id).await?;
            if validator.receive(&frame)? != ReceiveOutcome::Accepted {
                return Err(CollectorError::Protocol(
                    "unexpected frame redelivery before host write".to_owned(),
                ));
            }
            match frame.kind {
                FrameKind::StreamStart => {
                    if stream_start.is_some() {
                        return Err(CollectorError::Protocol(
                            "duplicate stream_start".to_owned(),
                        ));
                    }
                    let payload: StreamStartPayload = serde_json::from_str(&frame.payload)
                        .map_err(|error| {
                            CollectorError::Protocol(format!(
                                "invalid stream_start payload: {error}"
                            ))
                        })?;
                    validate_stream_start(&payload, &account_binding)?;
                    stream_start = Some(payload);
                }
                FrameKind::Records => {
                    if stream_start.is_none() || stream_end.is_some() {
                        return Err(CollectorError::Protocol(
                            "records appeared outside the active T0 stream".to_owned(),
                        ));
                    }
                    let payload: RecordBatchPayload<Value> = serde_json::from_str(&frame.payload)
                        .map_err(|error| {
                        CollectorError::Protocol(format!("invalid record batch payload: {error}"))
                    })?;
                    validate_record_batch_account_lock(&payload, &account_binding)?;
                    let start = stream_start.as_ref().ok_or_else(|| {
                        CollectorError::Protocol("record batch preceded stream_start".to_owned())
                    })?;
                    validate_record_batch_position(
                        start,
                        &normalizer.summary(),
                        payload.dataset,
                        payload.records.len(),
                    )?;
                    normalizer.ingest_batch(
                        payload.dataset,
                        &payload.records,
                        &utc_now(),
                        writer,
                    )?;
                }
                FrameKind::StreamEnd => {
                    if stream_start.is_none() || stream_end.is_some() {
                        return Err(CollectorError::Protocol(
                            "invalid stream_end ordering".to_owned(),
                        ));
                    }
                    let payload: StreamEndPayload =
                        serde_json::from_str(&frame.payload).map_err(|error| {
                            CollectorError::Protocol(format!("invalid stream_end payload: {error}"))
                        })?;
                    validate_stream_end(&payload, &normalizer.summary(), &account_binding)?;
                    stream_end = Some(payload);
                }
                FrameKind::Error => {
                    let payload: ErrorPayload =
                        serde_json::from_str(&frame.payload).map_err(|_| {
                            CollectorError::Protocol("invalid page error frame".to_owned())
                        })?;
                    if payload.code != "snapshot_failed" || payload.message != "snapshot_failed" {
                        return Err(CollectorError::Protocol(
                            "invalid page error frame".to_owned(),
                        ));
                    }
                    return Err(CollectorError::Protocol(
                        "page snapshot failed closed".to_owned(),
                    ));
                }
                FrameKind::Cancelled => {
                    return Err(CollectorError::Protocol(
                        "page snapshot was cancelled".to_owned(),
                    ));
                }
                FrameKind::ProbeResult | FrameKind::MediaChunk => {
                    return Err(CollectorError::Protocol(
                        "unexpected frame kind during passive T0".to_owned(),
                    ));
                }
            }
            acknowledge_frame(
                session,
                attached_id,
                &object_id,
                &frame,
                &mut validator,
                writer,
                audit,
                log_session_id,
                started,
            )
            .await?;
            if stream_end.is_some() {
                break;
            }
        }
        ensure_target_stable(events, attached_id, &target_lock)?;
        verify_live_account_binding(
            session,
            attached_id,
            &object_id,
            &controller_session_id,
            &account_binding,
        )
        .await?;
        ensure_target_stable(events, attached_id, &target_lock)?;
        verify_frame_tree_lock(session, attached_id, &target_lock).await?;
        let origin = evaluate_value(session, attached_id, ORIGIN_EXPRESSION, false).await?;
        if origin.as_str() != Some("https://web.whatsapp.com") {
            return Err(CollectorError::TargetInvalidated(
                "origin changed before snapshot completion".to_owned(),
            ));
        }
        let stream_start = stream_start
            .ok_or_else(|| CollectorError::Protocol("stream_start was not observed".to_owned()))?;
        let stream_end = stream_end
            .ok_or_else(|| CollectorError::Protocol("stream_end was not observed".to_owned()))?;
        validate_start_end_counts(&stream_start, &stream_end)?;
        normalizer.write_chat_completeness(writer)?;
        Ok(SessionOutcome {
            probe,
            probed_at,
            stream_start,
            stream_end,
            normalization: normalizer.summary(),
            runtime_object_released: false,
        })
    }
    .await;

    let release_result = release_controller_object(session, attached_id, &object_id).await;
    match (controller_result, release_result) {
        (Ok(mut outcome), Ok(())) => {
            outcome.runtime_object_released = true;
            Ok(outcome)
        }
        (Ok(_), Err(release_error)) => {
            append_log(
                writer,
                audit,
                log_session_id,
                started,
                LogEventType::Warning,
                &json!({
                    "code": "runtime_object_release_failed",
                    "detail": bounded_browser_error(&release_error),
                }),
            )?;
            Err(release_error.into())
        }
        (Err(controller_error), release) => {
            if let Err(release_error) = release {
                let _ = append_log(
                    writer,
                    audit,
                    log_session_id,
                    started,
                    LogEventType::Warning,
                    &json!({
                        "code": "runtime_object_release_failed_after_t0_error",
                        "detail": bounded_browser_error(&release_error),
                    }),
                );
            }
            Err(controller_error)
        }
    }
}

async fn release_controller_object(
    session: &CdpSession,
    attached_id: &str,
    object_id: &str,
) -> Result<(), BrowserCdpError> {
    session
        .request(
            "Runtime.releaseObject",
            json!({"objectId": object_id}),
            Some(attached_id),
        )
        .await
        .map(|_| ())
}

async fn cleanup_attached_session(
    session: &CdpSession,
    attached_id: &str,
    object_id: Option<&str>,
    context: &str,
) -> Result<(), CollectorError> {
    let release_error = if let Some(object_id) = object_id {
        release_controller_object(session, attached_id, object_id)
            .await
            .err()
    } else {
        None
    };
    let detach_error = session.detach_from_target(attached_id).await.err();
    let close_error = session.close().await.err();
    if let Some(error) = close_error {
        return Err(CollectorError::Protocol(format!(
            "CDP transport closure was not confirmed after {context}: {}",
            bounded_browser_error(&error)
        )));
    }
    if let Some(error) = release_error {
        return Err(CollectorError::Protocol(format!(
            "Runtime.releaseObject was not confirmed after {context}: {}",
            bounded_browser_error(&error)
        )));
    }
    if let Some(error) = detach_error {
        return Err(CollectorError::Protocol(format!(
            "Target.detachFromTarget was not confirmed after {context}: {}",
            bounded_browser_error(&error)
        )));
    }
    Ok(())
}

async fn find_target(endpoint: &CdpEndpoint, target_id: &str) -> Result<CdpTarget, CollectorError> {
    list_whatsapp_targets(endpoint)
        .await?
        .into_iter()
        .find(|target| target.id == target_id)
        .ok_or(CollectorError::TargetNotFound)
}

async fn find_selected_target(request: &AcquisitionRequest) -> Result<CdpTarget, CollectorError> {
    find_target(&request.endpoint, &request.target_id).await
}

async fn lock_main_frame(
    session: &CdpSession,
    attached_id: &str,
    target: &CdpTarget,
) -> Result<TargetLock, CollectorError> {
    let response = session
        .request("Page.getFrameTree", json!({}), Some(attached_id))
        .await?;
    let frame = response
        .get("frameTree")
        .and_then(|tree| tree.get("frame"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CollectorError::TargetInvalidated("Page.getFrameTree omitted the main frame".to_owned())
        })?;
    let main_frame_id = frame
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| CollectorError::TargetInvalidated("main frame ID is invalid".to_owned()))?;
    let url = frame
        .get("url")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 4096)
        .ok_or_else(|| CollectorError::TargetInvalidated("main frame URL is invalid".to_owned()))?;
    if frame.get("parentId").is_some() || !is_whatsapp_web_url(url) || url != target.url {
        return Err(CollectorError::TargetInvalidated(
            "main frame does not match the selected WhatsApp target".to_owned(),
        ));
    }
    Ok(TargetLock {
        target_id: target.id.clone(),
        main_frame_id: main_frame_id.to_owned(),
        url: url.to_owned(),
    })
}

async fn verify_frame_tree_lock(
    session: &CdpSession,
    attached_id: &str,
    lock: &TargetLock,
) -> Result<(), CollectorError> {
    let response = session
        .request("Page.getFrameTree", json!({}), Some(attached_id))
        .await?;
    let frame = response
        .get("frameTree")
        .and_then(|tree| tree.get("frame"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CollectorError::TargetInvalidated(
                "Page.getFrameTree omitted the main frame at completion".to_owned(),
            )
        })?;
    if frame.get("id").and_then(Value::as_str) != Some(lock.main_frame_id.as_str())
        || frame.get("url").and_then(Value::as_str) != Some(lock.url.as_str())
        || frame.get("parentId").is_some()
    {
        return Err(CollectorError::TargetInvalidated(
            "main frame identity or URL changed during acquisition".to_owned(),
        ));
    }
    Ok(())
}

async fn evaluate_value(
    session: &CdpSession,
    attached_id: &str,
    expression: &str,
    await_promise: bool,
) -> Result<Value, CollectorError> {
    let response = session
        .runtime_evaluate(attached_id, expression, await_promise, true)
        .await?;
    extract_value(&response)
}

async fn call_value(
    session: &CdpSession,
    attached_id: &str,
    function: &str,
    object_id: &str,
    arguments: &[Value],
) -> Result<Value, CollectorError> {
    let response = session
        .runtime_call_function_on(
            attached_id,
            function,
            Some(object_id),
            arguments,
            true,
            true,
        )
        .await?;
    extract_value(&response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveAccountBindingPayload {
    ok: bool,
    protocol: String,
    session_id: String,
    account_binding_sha256: String,
}

async fn verify_live_account_binding(
    session: &CdpSession,
    attached_id: &str,
    object_id: &str,
    controller_session_id: &str,
    expected: &[u8; 32],
) -> Result<(), CollectorError> {
    let value = call_value(
        session,
        attached_id,
        CHECK_ACCOUNT_BINDING_FUNCTION,
        object_id,
        &[],
    )
    .await?;
    let payload: LiveAccountBindingPayload = serde_json::from_value(value).map_err(|_| {
        CollectorError::Protocol("live account binding response was invalid".to_owned())
    })?;
    if !payload.ok
        || payload.protocol != page_bridge::PROTOCOL
        || payload.session_id != controller_session_id
        || !account_binding_matches(expected, &payload.account_binding_sha256)?
    {
        return Err(CollectorError::Protocol(
            "live account binding changed during the attached session".to_owned(),
        ));
    }
    Ok(())
}

async fn pull_frame(
    session: &CdpSession,
    attached_id: &str,
    object_id: &str,
) -> Result<Frame, CollectorError> {
    let value = call_value(session, attached_id, NEXT_FUNCTION, object_id, &[]).await?;
    if value.is_null() {
        return Err(CollectorError::Protocol(
            "controller returned no frame before completion".to_owned(),
        ));
    }
    serde_json::from_value(value)
        .map_err(|error| CollectorError::Protocol(format!("invalid bridge frame: {error}")))
}

#[allow(clippy::too_many_arguments)]
async fn acknowledge_frame(
    session: &CdpSession,
    attached_id: &str,
    object_id: &str,
    frame: &Frame,
    validator: &mut FrameValidator,
    writer: &mut WaebWriter,
    audit: &AuditContext,
    log_session_id: Uuid,
    started: Instant,
) -> Result<(), CollectorError> {
    let retried = acknowledge_frame_raw(session, attached_id, object_id, frame, validator).await?;
    if retried {
        append_log(
            writer,
            audit,
            log_session_id,
            started,
            LogEventType::Warning,
            &json!({
                "code": "bridge_ack_timeout_retry",
                "frame_sequence": frame.sequence.to_string(),
                "frame_kind": frame_kind_label(frame.kind),
                "retry_count": 1,
            }),
        )?;
    }
    Ok(())
}

async fn acknowledge_frame_raw(
    session: &CdpSession,
    attached_id: &str,
    object_id: &str,
    frame: &Frame,
    validator: &mut FrameValidator,
) -> Result<bool, CollectorError> {
    let arguments = [json!({"value": frame.sequence.to_string()})];
    let first = timeout(
        ACK_ATTEMPT_TIMEOUT,
        call_value(session, attached_id, ACK_FUNCTION, object_id, &arguments),
    )
    .await;
    let (acknowledged, retried) = if let Ok(result) = first {
        (result?, false)
    } else {
        let result = timeout(
            ACK_ATTEMPT_TIMEOUT,
            call_value(session, attached_id, ACK_FUNCTION, object_id, &arguments),
        )
        .await
        .map_err(|_| {
            CollectorError::Protocol(
                "page acknowledgement response timed out after one idempotent retry".to_owned(),
            )
        })??;
        (result, true)
    };
    if acknowledged != Value::Bool(true) {
        return Err(CollectorError::Protocol(
            "page rejected an otherwise valid frame acknowledgement".to_owned(),
        ));
    }
    if validator.acknowledge(frame.sequence)? != AckOutcome::Applied {
        return Err(CollectorError::Protocol(
            "host acknowledgement was not newly applied".to_owned(),
        ));
    }
    Ok(retried)
}

const fn frame_kind_label(kind: FrameKind) -> &'static str {
    match kind {
        FrameKind::ProbeResult => "probe_result",
        FrameKind::StreamStart => "stream_start",
        FrameKind::Records => "records",
        FrameKind::MediaChunk => "media_chunk",
        FrameKind::StreamEnd => "stream_end",
        FrameKind::Error => "error",
        FrameKind::Cancelled => "cancelled",
    }
}

fn extract_object_id(response: &Value) -> Result<String, CollectorError> {
    reject_exception(response)?;
    response
        .get("result")
        .and_then(|value| value.get("objectId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            CollectorError::Protocol("injector did not return a remote object".to_owned())
        })
}

fn extract_value(response: &Value) -> Result<Value, CollectorError> {
    reject_exception(response)?;
    response
        .get("result")
        .and_then(|value| value.get("value"))
        .cloned()
        .ok_or_else(|| {
            CollectorError::Protocol("CDP result omitted return-by-value data".to_owned())
        })
}

fn reject_exception(response: &Value) -> Result<(), CollectorError> {
    if response.get("exceptionDetails").is_some() {
        return Err(CollectorError::Protocol(
            "fixed page expression raised an exception".to_owned(),
        ));
    }
    Ok(())
}

fn successful_dispatch_session(value: &Value) -> Result<String, CollectorError> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(CollectorError::Protocol(
            "controller rejected fixed command".to_owned(),
        ));
    }
    value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            CollectorError::Protocol("dispatch omitted controller session ID".to_owned())
        })
}

fn validate_probe(probe: &ProbeResultPayload) -> Result<(), CollectorError> {
    if probe.protocol != page_bridge::PROTOCOL
        || probe.controller_version != page_bridge::CONTROLLER_VERSION
    {
        return Err(CollectorError::Protocol(
            "page bridge version contract did not match".to_owned(),
        ));
    }
    if !probe.supported
        || probe.adapter_id.is_none()
        || probe
            .account_binding_sha256
            .as_deref()
            .is_none_or(|value| decode_account_binding(value).is_err())
        || !probe.reasons.is_empty()
    {
        return Err(CollectorError::UnsupportedWhatsAppVersion {
            build: bounded_label(&probe.build, 160),
            reason_codes: probe.reasons.clone(),
        });
    }
    let CapabilityPayload {
        passive_t0,
        accounts,
        contacts,
        chats,
        messages,
        media,
        history_loading,
        network_actions,
        dom_writes,
    } = probe.capabilities;
    if !passive_t0
        || !accounts
        || !contacts
        || !chats
        || !messages
        || media
        || history_loading
        || network_actions
        || dom_writes
    {
        return Err(CollectorError::Protocol(
            "injector capability matrix exceeds or misses the passive T0 contract".to_owned(),
        ));
    }
    Ok(())
}

fn validate_stream_start(
    payload: &StreamStartPayload,
    account_binding: &[u8; 32],
) -> Result<(), CollectorError> {
    let names = payload
        .datasets
        .iter()
        .map(|item| item.dataset)
        .collect::<Vec<_>>();
    if names
        != vec![
            DatasetKind::Accounts,
            DatasetKind::Contacts,
            DatasetKind::Chats,
            DatasetKind::Messages,
        ]
        || !account_binding_matches(account_binding, &payload.account_binding_sha256)?
        || observed_records(payload, DatasetKind::Accounts) != Some(1)
        || chrono::DateTime::parse_from_rfc3339(&payload.observed_at).is_err()
        || !payload.observed_at.ends_with('Z')
    {
        return Err(CollectorError::Protocol(
            "stream_start dataset set or timestamp is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_stream_end(
    payload: &StreamEndPayload,
    summary: &NormalizationSummary,
    account_binding: &[u8; 32],
) -> Result<(), CollectorError> {
    let actual = |name: &str| summary.record_counts.get(name).copied().unwrap_or(0);
    let counts_match = payload.totals.accounts == actual("accounts")
        && payload.totals.contacts == actual("contacts")
        && payload.totals.chats == actual("chats")
        && payload.totals.messages == actual("messages");
    let complete = matches!(
        payload.completeness.local_snapshot,
        page_bridge::LocalSnapshotCompleteness::Verified
    ) && matches!(
        payload.completeness.history_scope,
        page_bridge::HistoryCompleteness::NotRun
    ) && matches!(
        payload.completeness.media_scope,
        page_bridge::MediaCompleteness::NotRequested
    ) && matches!(
        payload.completeness.account_scope,
        page_bridge::AccountCompleteness::Unverifiable
    );
    if payload.totals.accounts != 1
        || actual("accounts") != 1
        || !account_binding_matches(account_binding, &payload.account_binding_sha256)?
        || !counts_match
        || !complete
        || chrono::DateTime::parse_from_rfc3339(&payload.completed_at).is_err()
        || !payload.completed_at.ends_with('Z')
    {
        return Err(CollectorError::Protocol(
            "stream_end totals or completeness contract does not match host observations"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_record_batch_account_lock(
    payload: &RecordBatchPayload<Value>,
    account_binding: &[u8; 32],
) -> Result<(), CollectorError> {
    let valid = match payload.dataset {
        DatasetKind::Accounts => payload
            .account_binding_sha256
            .as_deref()
            .is_some_and(|value| account_binding_matches(account_binding, value).unwrap_or(false)),
        DatasetKind::Contacts | DatasetKind::Chats | DatasetKind::Messages => {
            payload.account_binding_sha256.is_none()
        }
    };
    if !valid {
        return Err(CollectorError::Protocol(
            "record batch account binding changed or appeared on the wrong dataset".to_owned(),
        ));
    }
    Ok(())
}

fn valid_account_binding(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn decode_account_binding(value: &str) -> Result<[u8; 32], CollectorError> {
    if !valid_account_binding(value) {
        return Err(CollectorError::Protocol(
            "account binding is not canonical lowercase SHA-256".to_owned(),
        ));
    }
    let mut decoded = [0_u8; 32];
    hex::decode_to_slice(value, &mut decoded)
        .map_err(|_| CollectorError::Protocol("account binding hex decoding failed".to_owned()))?;
    Ok(decoded)
}

fn account_binding_matches(
    expected: &[u8; 32],
    observed_hex: &str,
) -> Result<bool, CollectorError> {
    let observed = decode_account_binding(observed_hex)?;
    Ok(bool::from(expected.ct_eq(&observed)))
}

fn new_confirmation_code() -> String {
    let random = Uuid::new_v4();
    hex::encode(&random.as_bytes()[..6])
}

async fn await_operator_confirmation<Fut>(
    response: Fut,
    confirmation_code: &str,
    events: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    attached_id: &str,
    lock: &TargetLock,
) -> Result<(), CollectorError>
where
    Fut: Future<Output = Option<String>>,
{
    await_operator_confirmation_with_timeout(
        response,
        confirmation_code,
        events,
        attached_id,
        lock,
        ACCOUNT_CONFIRMATION_TIMEOUT,
    )
    .await
}

async fn await_operator_confirmation_with_timeout<Fut>(
    response: Fut,
    confirmation_code: &str,
    events: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    attached_id: &str,
    lock: &TargetLock,
    confirmation_timeout: Duration,
) -> Result<(), CollectorError>
where
    Fut: Future<Output = Option<String>>,
{
    let wait = async {
        tokio::pin!(response);
        loop {
            tokio::select! {
                entered = &mut response => break Ok(entered),
                event = events.recv() => {
                    match event {
                        Ok(event) => classify_target_event(&event, attached_id, lock, EventPhase::Injected)?,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            return Err(CollectorError::TargetInvalidated(
                                "target event channel lagged during operator confirmation".to_owned(),
                            ));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            return Err(CollectorError::TargetInvalidated(
                                "target event channel closed during operator confirmation".to_owned(),
                            ));
                        }
                    }
                }
            }
        }
    };
    let entered = timeout(confirmation_timeout, wait)
        .await
        .map_err(|_| CollectorError::AccountConfirmationTimedOut)??
        .ok_or(CollectorError::AccountConfirmationRejected)?;
    if entered.len() != confirmation_code.len()
        || !bool::from(entered.as_bytes().ct_eq(confirmation_code.as_bytes()))
    {
        return Err(CollectorError::AccountConfirmationRejected);
    }
    Ok(())
}

fn validate_start_end_counts(
    start: &StreamStartPayload,
    end: &StreamEndPayload,
) -> Result<(), CollectorError> {
    let observed = |dataset: DatasetKind| observed_records(start, dataset);
    let start_time = chrono::DateTime::parse_from_rfc3339(&start.observed_at)
        .map_err(|_| CollectorError::Protocol("invalid stream_start timestamp".to_owned()))?;
    let end_observed_time = chrono::DateTime::parse_from_rfc3339(&end.observed_at)
        .map_err(|_| CollectorError::Protocol("invalid stream_end observedAt".to_owned()))?;
    let completed_time = chrono::DateTime::parse_from_rfc3339(&end.completed_at)
        .map_err(|_| CollectorError::Protocol("invalid stream_end completedAt".to_owned()))?;
    if observed(DatasetKind::Accounts) != Some(end.totals.accounts)
        || observed(DatasetKind::Contacts) != Some(end.totals.contacts)
        || observed(DatasetKind::Chats) != Some(end.totals.chats)
        || observed(DatasetKind::Messages) != Some(end.totals.messages)
        || end.totals.accounts != 1
        || start.observed_at != end.observed_at
        || start_time != end_observed_time
        || completed_time < start_time
    {
        return Err(CollectorError::Protocol(
            "stream_start observations changed before stream_end".to_owned(),
        ));
    }
    Ok(())
}

fn observed_records(payload: &StreamStartPayload, dataset: DatasetKind) -> Option<u64> {
    payload
        .datasets
        .iter()
        .find(|item| item.dataset == dataset)
        .map(|item| item.observed_records)
}

fn validate_record_batch_position(
    start: &StreamStartPayload,
    summary: &NormalizationSummary,
    dataset: DatasetKind,
    incoming_records: usize,
) -> Result<(), CollectorError> {
    let order = [
        (DatasetKind::Accounts, "accounts"),
        (DatasetKind::Contacts, "contacts"),
        (DatasetKind::Chats, "chats"),
        (DatasetKind::Messages, "messages"),
    ];
    let expected = order.iter().find_map(|(kind, name)| {
        let observed = observed_records(start, *kind)?;
        let accepted = summary.record_counts.get(*name).copied().unwrap_or(0);
        (accepted < observed).then_some((*kind, *name, observed, accepted))
    });
    let Some((expected_kind, _, observed, accepted)) = expected else {
        return Err(CollectorError::Protocol(
            "record batch exceeded stream_start observations".to_owned(),
        ));
    };
    let incoming = u64::try_from(incoming_records).map_err(|_| {
        CollectorError::Protocol("record batch count exceeds host range".to_owned())
    })?;
    if dataset != expected_kind || accepted.saturating_add(incoming) > observed {
        return Err(CollectorError::Protocol(
            "record datasets were reordered, repeated, or exceeded declared counts".to_owned(),
        ));
    }
    Ok(())
}

fn consume_initial_events(
    receiver: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    attached_id: &str,
    lock: &TargetLock,
) -> Result<(), CollectorError> {
    consume_target_events(receiver, attached_id, lock, EventPhase::Initial)
}

fn ensure_target_stable(
    receiver: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    attached_id: &str,
    lock: &TargetLock,
) -> Result<(), CollectorError> {
    consume_target_events(receiver, attached_id, lock, EventPhase::Injected)
}

fn consume_target_events(
    receiver: &mut tokio::sync::broadcast::Receiver<CdpEvent>,
    attached_id: &str,
    lock: &TargetLock,
    phase: EventPhase,
) -> Result<(), CollectorError> {
    loop {
        match receiver.try_recv() {
            Ok(event) => classify_target_event(&event, attached_id, lock, phase)?,
            Err(TryRecvError::Empty) => return Ok(()),
            Err(TryRecvError::Closed) => {
                return Err(CollectorError::TargetInvalidated(
                    "CDP event channel closed".to_owned(),
                ));
            }
            Err(TryRecvError::Lagged(_)) => {
                return Err(CollectorError::TargetInvalidated(
                    "CDP event stream lagged".to_owned(),
                ));
            }
        }
    }
}

fn classify_target_event(
    event: &CdpEvent,
    attached_id: &str,
    lock: &TargetLock,
    phase: EventPhase,
) -> Result<(), CollectorError> {
    let same_session = event.session_id.as_deref() == Some(attached_id);
    match event.method.as_str() {
        "Page.navigatedWithinDocument" if same_session => {
            let frame_id = event
                .params
                .get("frameId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalidated(&event.method, "frame ID missing"))?;
            if frame_id == lock.main_frame_id {
                return Err(invalidated(
                    &event.method,
                    "main frame URL changed within the document",
                ));
            }
        }
        "Page.frameNavigated" if same_session => {
            let frame = event
                .params
                .get("frame")
                .and_then(Value::as_object)
                .ok_or_else(|| invalidated(&event.method, "malformed frame event"))?;
            let frame_id = frame
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| invalidated(&event.method, "frame ID missing"))?;
            if frame_id == lock.main_frame_id {
                let unchanged_initial_main_frame = matches!(phase, EventPhase::Initial)
                    && frame.get("parentId").is_none()
                    && frame.get("url").and_then(Value::as_str) == Some(lock.url.as_str());
                if !unchanged_initial_main_frame {
                    return Err(invalidated(&event.method, "main frame navigated"));
                }
            }
        }
        "Runtime.executionContextCreated" if same_session => {
            if matches!(phase, EventPhase::Initial) {
                validate_initial_execution_context(event, lock)?;
            }
        }
        "Runtime.executionContextsCleared" | "Inspector.detached" if same_session => {
            return Err(invalidated(
                &event.method,
                "attached page context was reset",
            ));
        }
        "Target.targetDestroyed" => {
            let target_id = event.params.get("targetId").and_then(Value::as_str);
            if target_id == Some(lock.target_id.as_str()) {
                return Err(invalidated(&event.method, "selected target was destroyed"));
            }
        }
        "Target.detachedFromTarget" => {
            let session_id = event.params.get("sessionId").and_then(Value::as_str);
            if session_id == Some(attached_id) {
                return Err(invalidated(&event.method, "selected target was detached"));
            }
        }
        "Target.targetInfoChanged" => {
            let info = event
                .params
                .get("targetInfo")
                .and_then(Value::as_object)
                .ok_or_else(|| invalidated(&event.method, "target info missing"))?;
            if info.get("targetId").and_then(Value::as_str) == Some(lock.target_id.as_str())
                && info.get("url").and_then(Value::as_str) != Some(lock.url.as_str())
            {
                return Err(invalidated(&event.method, "selected target URL changed"));
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_initial_execution_context(
    event: &CdpEvent,
    lock: &TargetLock,
) -> Result<(), CollectorError> {
    let Some(context) = event.params.get("context").and_then(Value::as_object) else {
        return Err(invalidated(&event.method, "execution context missing"));
    };
    let Some(aux_data) = context.get("auxData").and_then(Value::as_object) else {
        // Worker and non-frame contexts need not expose frame auxiliary data.
        return Ok(());
    };
    if aux_data.get("frameId").and_then(Value::as_str) != Some(lock.main_frame_id.as_str()) {
        return Ok(());
    }
    match aux_data.get("isDefault").and_then(Value::as_bool) {
        // Chromium reports extension and other isolated worlds for the main
        // frame after Runtime.enable. They are not the controller's Main World
        // and are safely ignored; the fixed Runtime.evaluate origin check below
        // still executes in the default context.
        Some(false) => return Ok(()),
        Some(true) => {}
        None => {
            return Err(invalidated(
                &event.method,
                "initial main-frame execution context omitted its world type",
            ));
        }
    }
    if context.get("origin").and_then(Value::as_str) != Some("https://web.whatsapp.com") {
        return Err(invalidated(
            &event.method,
            "initial main-frame execution context is not the expected origin",
        ));
    }
    Ok(())
}

fn invalidated(method: &str, reason: &str) -> CollectorError {
    CollectorError::TargetInvalidated(format!("{method}: {reason}"))
}

fn capabilities_dto(
    source_id: Uuid,
    probe: &ProbeResultPayload,
    probed_at: &str,
) -> CapabilitiesDto {
    let adapter = probe.adapter_id.clone();
    let capabilities = CAPABILITY_NAMES
        .iter()
        .map(|name| {
            let supported = matches!(*name, "accounts" | "contacts" | "chats" | "messages");
            if supported {
                CapabilityDto {
                    name: (*name).to_owned(),
                    result: "supported".to_owned(),
                    adapter: adapter.clone(),
                    reason_codes: Vec::new(),
                }
            } else {
                CapabilityDto {
                    name: (*name).to_owned(),
                    result: "unsupported".to_owned(),
                    adapter: None,
                    reason_codes: vec!["passive_t0_v0_1".to_owned()],
                }
            }
        })
        .collect();
    CapabilitiesDto {
        schema_version: SCHEMA_VERSION.to_owned(),
        source_id,
        probed_at_utc: probed_at.to_owned(),
        whatsapp_build: probe.build.clone(),
        capabilities,
    }
}

fn dataset_dispositions(
    summary: &NormalizationSummary,
    window: &ObservationWindowDto,
) -> Vec<DatasetDisposition> {
    DATASETS
        .iter()
        .map(|dataset| {
            let requested = matches!(dataset.name, "accounts" | "contacts" | "chats" | "messages");
            if requested {
                let count = summary
                    .record_counts
                    .get(dataset.name)
                    .copied()
                    .unwrap_or(0);
                DatasetDisposition {
                    capability: DatasetCapability::Supported,
                    request_state: RequestState::Requested,
                    result: if count == 0 {
                        DatasetResult::Empty
                    } else {
                        DatasetResult::CompleteAsObserved
                    },
                    observation_window: Some(window.clone()),
                    reason_codes: Vec::new(),
                }
            } else {
                DatasetDisposition {
                    capability: DatasetCapability::Unsupported,
                    request_state: RequestState::NotRequested,
                    result: DatasetResult::NotRequested,
                    observation_window: None,
                    reason_codes: vec!["passive_t0_v0_1".to_owned()],
                }
            }
        })
        .collect()
}

fn append_log(
    writer: &mut WaebWriter,
    audit: &AuditContext,
    session_id: Uuid,
    started: Instant,
    event_type: LogEventType,
    summary: &Value,
) -> Result<(), CollectorError> {
    let elapsed = started.elapsed().as_nanos();
    let monotonic = u64::try_from(elapsed).unwrap_or(u64::MAX);
    let mut complete = summary.as_object().cloned().ok_or_else(|| {
        CollectorError::Protocol("audit operation summary must be an object".to_owned())
    })?;
    for (name, value) in audit.fields() {
        if complete.insert(name, value).is_some() {
            return Err(CollectorError::Protocol(
                "audit operation summary collides with fixed context".to_owned(),
            ));
        }
    }
    writer.append_log_event(
        session_id,
        &utc_now(),
        monotonic,
        event_type,
        &Value::Object(complete),
    )?;
    Ok(())
}

impl AuditContext {
    fn fields(&self) -> Vec<(String, Value)> {
        vec![
            ("evidence_id".to_owned(), json!(self.evidence_id)),
            ("acquisition_id".to_owned(), json!(self.acquisition_id)),
            ("source_id".to_owned(), json!(self.source_id)),
            (
                "portable_bundle_id".to_owned(),
                json!(self.portable_bundle_id),
            ),
            (
                "portable_manifest_sha256".to_owned(),
                json!(self.portable_manifest_sha256),
            ),
            ("assignment_id".to_owned(), json!(self.assignment_id)),
            (
                "assignment_sha256".to_owned(),
                json!(self.assignment_sha256),
            ),
            (
                "workstation_key_fingerprint_sha256".to_owned(),
                json!(self.workstation_key_fingerprint_sha256),
            ),
            (
                "operator_key_fingerprint_sha256".to_owned(),
                json!(self.operator_key_fingerprint_sha256),
            ),
            (
                "operator_id_sha256".to_owned(),
                json!(self.operator_id_sha256),
            ),
            (
                "authorization_reference_sha256".to_owned(),
                json!(self.authorization_reference_sha256),
            ),
            (
                "collector_version".to_owned(),
                json!(self.collector_version),
            ),
            ("collector_sha256".to_owned(), json!(self.collector_sha256)),
            ("injector_version".to_owned(), json!(self.injector_version)),
            ("injector_sha256".to_owned(), json!(self.injector_sha256)),
            ("browser_family".to_owned(), json!(self.browser_family)),
            ("browser_version".to_owned(), json!(self.browser_version)),
            (
                "browser_profile_mode".to_owned(),
                json!(self.browser_profile_mode),
            ),
            (
                "browser_profile_reference_sha256".to_owned(),
                json!(self.browser_profile_reference_sha256),
            ),
            ("adapter_id".to_owned(), json!(self.adapter_id)),
            ("adapter_version".to_owned(), json!(self.adapter_version)),
            ("whatsapp_build".to_owned(), json!(self.whatsapp_build)),
        ]
    }
}

fn audit_digest(label: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"WAFC-AUDIT-CONTEXT-v1\0");
    hasher.update(label.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn bounded_label(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn validate_unlocked_keystore(
    request: &AcquisitionRequest,
    unlocked: &UnlockedKeystore,
) -> Result<(), CollectorError> {
    let binding_matches = unlocked.binding.operator_id == request.operator_id
        && unlocked.binding.key_id == request.key_id
        && fingerprint_ct_eq(
            &unlocked.binding.workstation_key_fingerprint_sha256,
            &request
                .portable_configuration
                .workstation_key_fingerprint_sha256,
        )
        && fingerprint_ct_eq(
            &unlocked.public_key_fingerprint_sha256,
            &request
                .portable_configuration
                .operator_key_fingerprint_sha256,
        );
    if !binding_matches {
        return Err(CollectorError::Preflight(
            "operator key does not match the signed portable assignment".to_owned(),
        ));
    }
    Ok(())
}

fn fingerprint_ct_eq(left: &str, right: &str) -> bool {
    let Some(left) = decode_fingerprint(left) else {
        return false;
    };
    let Some(right) = decode_fingerprint(right) else {
        return false;
    };
    bool::from(left.ct_eq(&right))
}

fn decode_fingerprint(value: &str) -> Option<[u8; 32]> {
    let hex = value.strip_prefix("sha256:")?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    let decoded = hex::decode(hex).ok()?;
    decoded.try_into().ok()
}

fn validate_request(request: &AcquisitionRequest) -> Result<(), CollectorError> {
    if request.dedicated_profile_dir.is_some() && request.existing_profile.is_some() {
        return Err(CollectorError::Preflight(
            "dedicated and original profile modes are mutually exclusive".to_owned(),
        ));
    }
    let valid_operator = (3..=80).contains(&request.operator_id.len())
        && request.operator_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        });
    if !valid_operator {
        return Err(CollectorError::Preflight(
            "operator ID must match [a-z0-9_-]{3,80}".to_owned(),
        ));
    }
    validate_target_id(&request.target_id)?;
    if request.authorization_reference.is_empty()
        || request.authorization_reference.len() > 240
        || !request.authorization_confirmed_at_utc.ends_with('Z')
        || chrono::DateTime::parse_from_rfc3339(&request.authorization_confirmed_at_utc).is_err()
    {
        return Err(CollectorError::Preflight(
            "authorization reference or confirmation time is invalid".to_owned(),
        ));
    }
    for (name, value, max) in [
        ("locale", request.locale.as_str(), 40),
        ("time zone", request.time_zone.as_str(), 80),
        (
            "source organization",
            request.source_organization.as_str(),
            240,
        ),
        ("key ID", request.key_id.as_str(), 120),
    ] {
        if value.is_empty() || value.len() > max || value.contains(['\r', '\n']) {
            return Err(CollectorError::Preflight(format!("invalid {name}")));
        }
    }
    let valid_key_id = request.key_id.len() >= 3
        && request
            .key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
    if !valid_key_id {
        return Err(CollectorError::Preflight(
            "key ID contains unsupported characters".to_owned(),
        ));
    }
    if !valid_portable_identifier(&request.portable_configuration.assignment_id)
        || decode_fingerprint(
            &request
                .portable_configuration
                .workstation_key_fingerprint_sha256,
        )
        .is_none()
        || decode_fingerprint(
            &request
                .portable_configuration
                .operator_key_fingerprint_sha256,
        )
        .is_none()
        || !valid_sha256(&request.portable_configuration.bundle_manifest_sha256)
        || !valid_sha256(&request.portable_configuration.assignment_sha256)
    {
        return Err(CollectorError::Preflight(
            "portable configuration binding is invalid".to_owned(),
        ));
    }
    if let Some(context) = &request.existing_profile {
        validate_existing_profile_context(context)?;
    }
    Ok(())
}

fn profile_evidence_metadata(
    request: &AcquisitionRequest,
) -> Result<(String, Option<String>), CollectorError> {
    if let Some(profile_dir) = &request.dedicated_profile_dir {
        let binding = verify_dedicated_profile_binding(profile_dir, &request.endpoint)?;
        return Ok((
            "dedicated_acquisition".to_owned(),
            Some(binding.profile_reference_sha256),
        ));
    }
    Ok((
        "authorized_existing".to_owned(),
        request
            .existing_profile
            .as_ref()
            .map(|context| context.profile_reference_sha256.clone()),
    ))
}

fn validate_existing_profile_context(
    context: &ExistingProfileContext,
) -> Result<(), CollectorError> {
    let timestamps_valid = [
        &context.browser_opened_at_utc,
        &context.extension_paired_at_utc,
    ]
    .into_iter()
    .all(|value| value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok());
    let labels_valid = [
        (context.extension_version.as_str(), 40_usize),
        (context.transport_protocol.as_str(), 80),
        (context.adapter_id.as_str(), 120),
        (context.adapter_version.as_str(), 80),
    ]
    .into_iter()
    .all(|(value, max)| {
        !value.is_empty() && value.len() <= max && value.bytes().all(|byte| byte.is_ascii_graphic())
    });
    if !valid_sha256(&context.profile_reference_sha256)
        || !valid_sha256(&context.adapter_sha256)
        || !matches!(context.browser_family.as_str(), "chrome" | "edge")
        || !timestamps_valid
        || !labels_valid
        || context.transport_protocol != "wafc-extension-relay/1"
    {
        return Err(CollectorError::Preflight(
            "original browser profile or extension binding is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_existing_profile_probe(
    request: &AcquisitionRequest,
    version: &BrowserVersion,
    probe: &ProbeResultPayload,
) -> Result<(), CollectorError> {
    let Some(context) = &request.existing_profile else {
        return Ok(());
    };
    let observed_adapter = probe.adapter_id.as_deref().unwrap_or_default();
    let embedded_adapter_sha256 = sha256_hex(INJECTOR.as_bytes());
    if browser_family(version) != context.browser_family
        || observed_adapter != context.adapter_id
        || embedded_adapter_sha256 != context.adapter_sha256
    {
        return Err(CollectorError::Protocol(
            "selected profile, extension, and adapter contract did not match".to_owned(),
        ));
    }
    Ok(())
}

fn original_profile_impacts() -> Vec<&'static str> {
    vec![
        "original_profile_opened",
        "unpacked_extension_loaded_or_reloaded",
        "whatsapp_network_sync_possible",
        "browser_cache_or_profile_metadata_change_possible",
    ]
}

fn valid_portable_identifier(value: &str) -> bool {
    (3..=120).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn validate_target_id(target_id: &str) -> Result<(), CollectorError> {
    if target_id.is_empty()
        || target_id.len() > 256
        || !target_id.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(CollectorError::Preflight("invalid target ID".to_owned()));
    }
    Ok(())
}

fn browser_family(version: &BrowserVersion) -> &'static str {
    let label = version.browser.to_ascii_lowercase();
    if label.contains("edge") || label.contains("edg/") {
        "edge"
    } else if label.contains("chrome") {
        "chrome"
    } else {
        "chromium"
    }
}

fn architecture_label() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        _ => "unknown",
    }
}

fn current_executable_sha256() -> Result<String, CollectorError> {
    let path = std::env::current_exe()?;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn utc_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn acquisition_result(
    sealed: SealedBag,
    source_id: Uuid,
    normalization: NormalizationSummary,
    lifecycle_state: AcquisitionState,
) -> AcquisitionResult {
    AcquisitionResult {
        evidence_bag_path: sealed.path.clone(),
        evidence_id: sealed.evidence_id,
        source_id,
        manifest_root_sha256: sealed.manifest_root_sha256.clone(),
        signer_fingerprint: sealed.signer_fingerprint.clone(),
        record_counts: normalization.record_counts,
        unresolved_reference_count: normalization.unresolved_reference_count,
        lifecycle_state,
        sealed_bag: Some(sealed),
    }
}

fn bounded_error(error: &CollectorError) -> String {
    error.to_string().chars().take(240).collect()
}

fn bounded_browser_error(error: &BrowserCdpError) -> String {
    error.to_string().chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(output: &std::path::Path, key: PathBuf) -> AcquisitionRequest {
        let endpoint = CdpEndpoint::parse("http://127.0.0.1:9222");
        assert!(endpoint.is_ok());
        AcquisitionRequest {
            endpoint: match endpoint {
                Ok(value) => value,
                Err(error) => panic!("endpoint parse failed: {error}"),
            },
            dedicated_profile_dir: None,
            existing_profile: None,
            target_id: "target-one".to_owned(),
            evidence_staging_dir: output.join("evidence/staging"),
            evidence_sealed_dir: output.join("evidence/sealed"),
            keystore_path: key,
            operator_id: "operator_1".to_owned(),
            operator_display_name: None,
            authorization_reference: "authorized-test".to_owned(),
            authorization_confirmed_at_utc: "2026-08-08T00:00:00.000Z".to_owned(),
            passive_t0_consent: true,
            locale: "zh-CN".to_owned(),
            time_zone: "Asia/Shanghai".to_owned(),
            source_organization: "Test Laboratory".to_owned(),
            key_id: "test-key-1".to_owned(),
            portable_configuration: PortableConfigurationContext {
                bundle_id: Uuid::nil(),
                bundle_manifest_sha256: "a".repeat(64),
                assignment_id: "assignment-test".to_owned(),
                assignment_sha256: "b".repeat(64),
                workstation_key_fingerprint_sha256: format!("sha256:{}", "c".repeat(64)),
                operator_key_fingerprint_sha256: format!("sha256:{}", "d".repeat(64)),
            },
        }
    }

    #[test]
    fn request_validation_rejects_noncanonical_operator() {
        let mut value = request(std::path::Path::new("out"), PathBuf::from("key"));
        value.operator_id = "Operator 1".to_owned();
        assert!(validate_request(&value).is_err());
    }

    #[test]
    fn dispositions_are_fixed_and_ordered() {
        let mut summary = NormalizationSummary::default();
        summary.record_counts.insert("accounts".to_owned(), 1);
        let window = ObservationWindowDto {
            started_at_utc: "2026-08-08T00:00:00.000Z".to_owned(),
            ended_at_utc: "2026-08-08T00:00:01.000Z".to_owned(),
        };
        let dispositions = dataset_dispositions(&summary, &window);
        assert_eq!(dispositions.len(), 18);
        assert!(matches!(
            dispositions[0].result,
            DatasetResult::CompleteAsObserved
        ));
        assert!(matches!(
            dispositions[4].result,
            DatasetResult::NotRequested
        ));
    }

    #[test]
    fn unsupported_capabilities_never_claim_an_adapter() {
        let probe = ProbeResultPayload {
            protocol: page_bridge::PROTOCOL.to_owned(),
            controller_version: page_bridge::CONTROLLER_VERSION.to_owned(),
            supported: true,
            adapter_id: Some("adapter-v1".to_owned()),
            build: "test".to_owned(),
            account_binding_sha256: Some("a".repeat(64)),
            reasons: Vec::new(),
            capabilities: CapabilityPayload {
                passive_t0: true,
                accounts: true,
                contacts: true,
                chats: true,
                messages: true,
                media: false,
                history_loading: false,
                network_actions: false,
                dom_writes: false,
            },
        };
        let dto = capabilities_dto(Uuid::new_v4(), &probe, "2026-08-08T00:00:00.000Z");
        assert_eq!(dto.capabilities.len(), 19);
        assert!(dto.capabilities[0].adapter.is_some());
        assert!(dto.capabilities[4].adapter.is_none());
    }

    fn synthetic_lock() -> TargetLock {
        TargetLock {
            target_id: "target-one".to_owned(),
            main_frame_id: "main-frame-one".to_owned(),
            url: "https://web.whatsapp.com/".to_owned(),
        }
    }

    fn event(method: &str, params: Value, session_id: Option<&str>) -> CdpEvent {
        CdpEvent {
            method: method.to_owned(),
            params,
            session_id: session_id.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn initial_events_are_classified_instead_of_blindly_drained() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(8);
        let lock = synthetic_lock();
        assert!(
            sender
                .send(event(
                    "Page.frameNavigated",
                    json!({"frame": {"id": lock.main_frame_id, "url": lock.url}}),
                    Some("attached-one"),
                ))
                .is_ok()
        );
        assert!(
            sender
                .send(event(
                    "Runtime.executionContextCreated",
                    json!({
                        "context": {
                            "id": 6,
                            "origin": "chrome-extension://synthetic-isolated-world",
                            "auxData": {
                                "isDefault": false,
                                "frameId": lock.main_frame_id,
                            }
                        }
                    }),
                    Some("attached-one"),
                ))
                .is_ok()
        );
        assert!(
            sender
                .send(event(
                    "Runtime.executionContextCreated",
                    json!({
                        "context": {
                            "id": 7,
                            "origin": "https://web.whatsapp.com",
                            "auxData": {
                                "isDefault": true,
                                "frameId": lock.main_frame_id,
                            }
                        }
                    }),
                    Some("attached-one"),
                ))
                .is_ok()
        );
        assert!(consume_initial_events(&mut receiver, "attached-one", &lock).is_ok());
    }

    #[test]
    fn initial_default_main_world_requires_the_exact_whatsapp_origin() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(4);
        let lock = synthetic_lock();
        assert!(
            sender
                .send(event(
                    "Runtime.executionContextCreated",
                    json!({
                        "context": {
                            "id": 9,
                            "origin": "https://example.invalid",
                            "auxData": {
                                "isDefault": true,
                                "frameId": lock.main_frame_id,
                            }
                        }
                    }),
                    Some("attached-one"),
                ))
                .is_ok()
        );
        assert!(matches!(
            consume_initial_events(&mut receiver, "attached-one", &lock),
            Err(CollectorError::TargetInvalidated(_))
        ));
    }

    #[test]
    fn child_frame_navigation_is_allowed_after_injection() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(4);
        let lock = synthetic_lock();
        assert!(
            sender
                .send(event(
                    "Page.frameNavigated",
                    json!({
                        "frame": {
                            "id": "child-frame",
                            "parentId": lock.main_frame_id,
                            "url": "https://example.invalid/embedded"
                        }
                    }),
                    Some("attached-one"),
                ))
                .is_ok()
        );
        assert!(ensure_target_stable(&mut receiver, "attached-one", &lock).is_ok());
    }

    #[test]
    fn main_frame_navigation_and_same_origin_url_jump_are_rejected() {
        let lock = synthetic_lock();
        let (sender, mut receiver) = tokio::sync::broadcast::channel(4);
        assert!(
            sender
                .send(event(
                    "Page.frameNavigated",
                    json!({"frame": {"id": lock.main_frame_id, "url": lock.url}}),
                    Some("attached-one"),
                ))
                .is_ok()
        );
        assert!(matches!(
            ensure_target_stable(&mut receiver, "attached-one", &lock),
            Err(CollectorError::TargetInvalidated(_))
        ));

        let (sender, mut receiver) = tokio::sync::broadcast::channel(4);
        for url in [
            "https://web.whatsapp.com/?transient=1",
            "https://web.whatsapp.com/",
        ] {
            assert!(
                sender
                    .send(event(
                        "Page.navigatedWithinDocument",
                        json!({"frameId": lock.main_frame_id, "url": url}),
                        Some("attached-one"),
                    ))
                    .is_ok()
            );
        }
        assert!(matches!(
            ensure_target_stable(&mut receiver, "attached-one", &lock),
            Err(CollectorError::TargetInvalidated(_))
        ));

        let (sender, mut receiver) = tokio::sync::broadcast::channel(4);
        assert!(
            sender
                .send(event(
                    "Target.targetInfoChanged",
                    json!({
                        "targetInfo": {
                            "targetId": lock.target_id,
                            "url": "https://web.whatsapp.com/?same-origin-jump=1"
                        }
                    }),
                    None,
                ))
                .is_ok()
        );
        assert!(matches!(
            ensure_target_stable(&mut receiver, "attached-one", &lock),
            Err(CollectorError::TargetInvalidated(_))
        ));
    }

    #[test]
    fn target_event_lag_and_channel_close_fail_closed() {
        let lock = synthetic_lock();
        let (sender, mut receiver) = tokio::sync::broadcast::channel(1);
        assert!(
            sender
                .send(event("Runtime.consoleAPICalled", json!({}), None))
                .is_ok()
        );
        assert!(
            sender
                .send(event("Runtime.consoleAPICalled", json!({}), None))
                .is_ok()
        );
        assert!(matches!(
            ensure_target_stable(&mut receiver, "attached-one", &lock),
            Err(CollectorError::TargetInvalidated(_))
        ));

        let (sender, mut receiver) = tokio::sync::broadcast::channel::<CdpEvent>(1);
        drop(sender);
        assert!(matches!(
            ensure_target_stable(&mut receiver, "attached-one", &lock),
            Err(CollectorError::TargetInvalidated(_))
        ));
    }

    #[tokio::test]
    async fn operator_gate_rejects_wrong_code_and_times_out() {
        let lock = synthetic_lock();
        let (sender, mut receiver) = tokio::sync::broadcast::channel(4);
        let wrong = await_operator_confirmation_with_timeout(
            async { Some("wrong-code".to_owned()) },
            "0123456789ab",
            &mut receiver,
            "attached-one",
            &lock,
            Duration::from_secs(1),
        )
        .await;
        assert!(matches!(
            wrong,
            Err(CollectorError::AccountConfirmationRejected)
        ));

        let timed_out = await_operator_confirmation_with_timeout(
            std::future::pending::<Option<String>>(),
            "0123456789ab",
            &mut receiver,
            "attached-one",
            &lock,
            Duration::from_millis(5),
        )
        .await;
        assert!(matches!(
            timed_out,
            Err(CollectorError::AccountConfirmationTimedOut)
        ));
        drop(sender);
    }
}
