//! End-to-end passive T0 acquisition over an explicitly authorized CDP endpoint.

use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{Read, Write};
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use browser_cdp::{
    BrowserCdpError, BrowserVersion, CdpEndpoint, CdpEvent, CdpSession, CdpTarget, get_version,
    is_whatsapp_web_url, list_whatsapp_targets, operating_system_version,
    verify_dedicated_profile_binding,
};
use chrono::{SecondsFormat, Utc};
use page_bridge::{
    AckOutcome, BridgeError, CapabilityPayload, DatasetCapabilityResult, DatasetKind, ErrorPayload,
    Frame, FrameKind, FrameValidator, MediaEndPayload, MediaStartPayload, OperationKind,
    ProbeResultPayload, ProgressPayload, ReceiveOutcome, RecordBatchPayload, StreamEndPayload,
    StreamStartPayload, media_chunk_bytes,
};
use portable_config::{AcquisitionMode, MediaPolicy, MediaPolicyMode};
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
    LogEventType, MediaCountsDto, MediaStream, ObservationWindowDto, OperatorDto, OsDto,
    PortableConfigurationDto, PrivacyDto, RequestState, SCHEMA_VERSION, SealOptions, SealedBag,
    WAEB_VERSION, WaebError, WaebWriter, sha256_hex,
};

use crate::COLLECTOR_VERSION;
use crate::checkpoint::{
    AcquisitionCheckpoint, CheckpointCleanup, CheckpointError, CheckpointPhase,
    CheckpointSourceBinding, CheckpointStore, CurrentAssetCheckpoint, capture_staging_manifest,
    checkpoint_evidence_ids, restore_staging_manifest,
};
use crate::normalize::{
    ActiveMediaBinding, NormalizationError, NormalizationMode, NormalizationSummary, Normalizer,
    detect_media,
};
use crate::progress::{AcquisitionProgress, bounded_original_file_name, normalized_output_path};
use crate::state::{AcquisitionState, StateError, StateMachine};

const INJECTOR: &str = include_str!("../../../injector/dist/collector.iife.js");
const DISPATCH_FUNCTION: &str = "function(request){ return this.dispatch(request); }";
const NEXT_FUNCTION: &str = "function(){ return this.next(); }";
const ACK_FUNCTION: &str = "function(sequence){ return this.ack(sequence); }";
const CHECK_ACCOUNT_BINDING_FUNCTION: &str = "function(){ return this.checkAccountBinding(); }";
const MEDIA_CONTROL_FUNCTION: &str = "function(command){ return this.controlMedia(command); }";
const CANCEL_FUNCTION: &str = "function(){ return this.cancel(); }";
const ORIGIN_EXPRESSION: &str = "window.location.origin";
const MAX_OUTPUT_MARKER_BYTES: usize = 64;
const ACK_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
const ACCOUNT_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(120);
const MEDIA_PREFIX_BYTES: usize = 4096;
const MAX_MEDIA_ASSET_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MEDIA_SPACE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;
const MEDIA_SPACE_RECHECK_BYTES: u64 = 64 * 1024 * 1024;
const MEDIA_PROGRESS_REPORT_BYTES: u64 = 4 * 1024 * 1024;
const MEDIA_CHECKPOINT_CHUNKS: u64 = 32;
const SNAPSHOT_CHECKPOINT_DOMAIN: &[u8] = b"WAFC-STRUCTURED-SNAPSHOT-v1\0";

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
    /// UTC time at which the Collector requested a normal profile launch. It
    /// is absent when the operator confirmed an already-open page.
    pub browser_opened_at_utc: Option<String>,
    /// UTC time at which the selected page became ready for extension pairing.
    pub browser_page_ready_at_utc: String,
    /// Fixed preparation route: `collector_requested_open` or
    /// `operator_confirmed_already_open`.
    pub browser_page_preparation: String,
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
    /// Workstation-signed acquisition policy.
    pub acquisition_mode: AcquisitionMode,
    /// Workstation-signed media limits and retry policy.
    pub media_policy: MediaPolicy,
    /// Required explicit operator consent for the signed policy.
    pub operator_consent: bool,
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
    /// Explicit operator-selected incomplete acquisition to resume. `None`
    /// always creates a new evidence/source identity and never appends to an
    /// existing staging directory.
    pub resume_evidence_id: Option<Uuid>,
}

/// Non-content summary of an authenticated, task-matching recovery point.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    /// Existing Evidence Bag identity retained across the resumed session.
    pub evidence_id: Uuid,
    /// UTC timestamp of the latest authenticated checkpoint generation.
    pub updated_at_utc: String,
    /// Plain-language recovery phase code for the native UI.
    pub phase: String,
    /// Media tasks that already reached a terminal, recorded outcome.
    pub completed_media: u64,
    /// Total media tasks in the source-bound plan.
    pub requested_media: u64,
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
#[allow(clippy::struct_excessive_bools)]
pub struct TargetReadinessReport {
    /// Whether this exact attached page currently satisfies passive T0's fixed
    /// adapter and capability contract.
    pub ready_for_passive_t0: bool,
    /// Whether this exact attached page also satisfies comprehensive v0.2's
    /// fixed Store-history and media-reader capability contract.
    pub ready_for_comprehensive_readonly_v02: bool,
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
    /// Free space visible on the fixed portable evidence volume.
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
    /// Non-content summary of what the sealed package can and cannot claim.
    pub completeness: AcquisitionCompletenessSummary,
    /// State reached by the core. The app must now invoke the independent verifier.
    pub lifecycle_state: AcquisitionState,
    #[serde(skip)]
    sealed_bag: Option<SealedBag>,
    #[serde(skip)]
    checkpoint_cleanup: Option<CheckpointCleanup>,
}

/// Operator-facing, non-content completeness summary copied from the exact
/// values written into `data/completeness.json`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionCompletenessSummary {
    /// `complete_as_observed` or `partial`; never account-level absolute completeness.
    pub overall: String,
    /// Local snapshot result reported by the fixed Adapter.
    pub local_snapshot: String,
    /// Store-only history observation boundary.
    pub history_scope: String,
    /// Requested media observation boundary.
    pub media_scope: String,
    /// Fixed reason codes explaining every partial result.
    pub reason_codes: Vec<String>,
    /// Detailed media outcomes copied from the host-observed index counts.
    pub media_counts: AcquisitionMediaSummary,
}

/// Operator-facing media outcome counts. These values are derived by Rust from
/// committed streams and terminal media records, never trusted from page totals
/// alone.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionMediaSummary {
    /// Total media tasks discovered for the signed mode.
    pub requested: u64,
    /// Assets committed to the content-addressed store.
    pub available: u64,
    /// Assets reported missing by the observable client state.
    pub missing: u64,
    /// Assets whose observable download source had expired.
    pub expired: u64,
    /// Assets whose observable decryption failed.
    pub decrypt_error: u64,
    /// Assets stopped by the per-attempt or overall duration limit.
    pub download_timeout: u64,
    /// Assets stopped after the signed no-progress interval.
    pub no_progress_timeout: u64,
    /// Assets exceeding the signed per-file byte limit.
    pub too_large: u64,
    /// Assets skipped when the fixed evidence volume lacked safe headroom.
    pub disk_space_insufficient: u64,
    /// Assets rejected after a host-side digest inconsistency.
    pub hash_mismatch: u64,
    /// Assets interrupted by loss of the paired local transport.
    pub transport_interrupted: u64,
    /// Assets stopped following operator cancellation.
    pub canceled: u64,
    /// Assets ending in another fixed, non-content unavailable state.
    pub unavailable: u64,
    /// Assets deliberately not requested by policy or a queue limit.
    pub not_attempted: u64,
}

/// Thread-safe operator cancellation handle shared by the GUI and acquisition
/// worker. Cancellation is observed only at verified frame boundaries so a
/// partially received media chunk is never treated as committed evidence.
#[derive(Clone, Debug, Default)]
pub struct AcquisitionCancellation {
    requested: Arc<AtomicBool>,
}

impl AcquisitionCancellation {
    /// Creates a cancellation handle in the non-cancelled state.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Requests a safe stop. This is idempotent and does not claim that a
    /// browser-owned network request can be interrupted immediately.
    pub fn cancel(&self) {
        self.requested.store(true, Ordering::Release);
    }

    /// Reports whether the operator has requested cancellation.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }
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
        if let Some(cleanup) = self.checkpoint_cleanup.take() {
            cleanup.remove_all()?;
        }
        Ok(())
    }
}

/// Failures from preflight, strict CDP, bridge validation, normalization, or sealing.
#[derive(Debug, Error)]
pub enum CollectorError {
    /// Preflight or operator input was invalid.
    #[error("preflight failed: {0}")]
    Preflight(String),
    /// Operator did not explicitly authorize the signed acquisition mode.
    #[error("the signed acquisition mode requires explicit operator consent")]
    ConsentRequired,
    /// Operator rejected, abandoned, or mistyped the one-time visual confirmation.
    #[error("operator did not confirm the selected WhatsApp Web page")]
    AccountConfirmationRejected,
    /// Operator confirmation did not arrive within the fixed safety window.
    #[error("operator confirmation timed out")]
    AccountConfirmationTimedOut,
    /// Operator requested a safe stop after collection had begun.
    #[error("acquisition cancelled by operator")]
    CancelledByOperator,
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
    /// Authenticated acquisition-checkpoint failure.
    #[error("checkpoint failed closed: {0}")]
    Checkpoint(String),
    /// A selected recovery point could not be bound to the live page before
    /// any append to the authenticated staging prefix was authorized.
    #[error("recovery source revalidation failed closed")]
    RecoverySourceMismatch,
    /// Internal lifecycle transition failure.
    #[error(transparent)]
    State(#[from] StateError),
    /// Local I/O failure outside the Evidence Bag writer.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl From<CheckpointError> for CollectorError {
    fn from(error: CheckpointError) -> Self {
        Self::Checkpoint(error.to_string())
    }
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

/// Lists authenticated, current-task recovery points without exposing evidence
/// content or stable account identifiers. Corrupt, foreign-key, other-task,
/// non-media, or already terminal checkpoints are never offered for resume.
/// The selected candidate is revalidated again against the live browser,
/// Profile, extension, Adapter, `WhatsApp` build, and page observation before any
/// append is allowed.
///
/// # Errors
///
/// Returns an error when the fixed staging root or request is unsafe. An
/// individual checkpoint that cannot be authenticated is ignored rather than
/// weakening the validation of any other candidate.
pub fn list_recovery_candidates(
    request: &AcquisitionRequest,
    keystore_passphrase: &str,
) -> Result<Vec<RecoveryCandidate>, CollectorError> {
    validate_request(request)?;
    if !request.acquisition_mode.requests_enrichment() {
        return Ok(Vec::new());
    }
    let staging = canonical_portable_directory(&request.evidence_staging_dir, "staging output")?;
    let mut candidates = Vec::new();
    for evidence_id in checkpoint_evidence_ids(&staging)? {
        let Ok(Some(loaded)) = CheckpointStore::load_latest::<AcquisitionCheckpoint>(
            &staging,
            evidence_id,
            keystore_passphrase,
        ) else {
            continue;
        };
        let checkpoint = loaded.payload;
        if checkpoint.validate(evidence_id).is_err()
            || !checkpoint_matches_portable_task(&checkpoint, request)
            || !checkpoint_phase_is_resumable(checkpoint.phase)
        {
            continue;
        }
        let Some(normalizer_checkpoint) = checkpoint.normalizer.clone() else {
            continue;
        };
        let Ok(normalizer) = Normalizer::restore(
            normalizer_checkpoint,
            checkpoint.source_id,
            checkpoint.acquisition_mode,
        ) else {
            continue;
        };
        let summary = normalizer.summary();
        let Ok(completed_media) = normalizer.terminal_media_count() else {
            continue;
        };
        if !checkpoint_has_resumable_media(&checkpoint, &summary, completed_media) {
            continue;
        }
        candidates.push(RecoveryCandidate {
            evidence_id,
            updated_at_utc: checkpoint.updated_at_utc,
            phase: recovery_phase_label(checkpoint.phase).to_owned(),
            completed_media,
            requested_media: summary.media.requested,
        });
    }
    candidates.sort_by(|left, right| {
        right
            .updated_at_utc
            .as_bytes()
            .cmp(left.updated_at_utc.as_bytes())
            .then_with(|| left.evidence_id.cmp(&right.evidence_id))
    });
    Ok(candidates)
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
    let mut command = Command::new(executable);
    configure_hidden_windows_command(&mut command);
    let output = command
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

#[cfg(windows)]
fn configure_hidden_windows_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
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
        validate_probe(&attached_probe.probe, AcquisitionMode::PassiveT0)?;
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
    let ready_for_comprehensive_readonly_v02 = attached_probe.probe.supported
        && validate_probe(
            &attached_probe.probe,
            AcquisitionMode::ComprehensiveReadonlyV02,
        )
        .is_ok();
    Ok(TargetReadinessReport {
        ready_for_passive_t0: attached_probe.probe.supported,
        ready_for_comprehensive_readonly_v02,
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

/// Runs the signed task's source-bound read-only acquisition and creates a WAEB v1 bag.
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
pub async fn collect<F, Fut>(
    request: &AcquisitionRequest,
    keystore_passphrase: &str,
    confirmation_gate: F,
) -> Result<AcquisitionResult, CollectorError>
where
    F: FnOnce(AccountConfirmationChallenge) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    collect_with_progress(request, keystore_passphrase, confirmation_gate, |_| {}).await
}

/// Runs collection while publishing bounded, non-content progress snapshots.
///
/// # Errors
///
/// Returns the same fail-closed acquisition errors as [`collect`].
pub async fn collect_with_progress<F, Fut, P>(
    request: &AcquisitionRequest,
    keystore_passphrase: &str,
    confirmation_gate: F,
    progress: P,
) -> Result<AcquisitionResult, CollectorError>
where
    F: FnOnce(AccountConfirmationChallenge) -> Fut,
    Fut: Future<Output = Option<String>>,
    P: Fn(AcquisitionProgress) + Send + Sync,
{
    collect_with_progress_and_cancel(
        request,
        keystore_passphrase,
        confirmation_gate,
        AcquisitionCancellation::new(),
        progress,
    )
    .await
}

/// Runs collection with progress publication and a safe operator cancellation
/// handle. The handle is checked before evidence creation, at every verified
/// bridge-frame boundary, and again before finalization.
///
/// # Errors
///
/// Returns [`CollectorError::CancelledByOperator`] for an observed cancellation
/// request, or the same fail-closed acquisition errors as [`collect`].
#[allow(clippy::too_many_lines)]
pub async fn collect_with_progress_and_cancel<F, Fut, P>(
    request: &AcquisitionRequest,
    keystore_passphrase: &str,
    confirmation_gate: F,
    cancellation: AcquisitionCancellation,
    progress: P,
) -> Result<AcquisitionResult, CollectorError>
where
    F: FnOnce(AccountConfirmationChallenge) -> Fut,
    Fut: Future<Output = Option<String>>,
    P: Fn(AcquisitionProgress) + Send + Sync,
{
    progress(AcquisitionProgress::without_item(
        "preparing",
        "validating_source",
        0,
    ));
    if cancellation.is_cancelled() {
        return Err(CollectorError::CancelledByOperator);
    }
    let mut state = StateMachine::default();
    state.transition(AcquisitionState::Preflight)?;
    let report = preflight(request)?;

    let version = get_version(&request.endpoint).await?;
    state.transition(AcquisitionState::EndpointAuthorized)?;
    let target = find_selected_target(request).await?;
    state.transition(AcquisitionState::TargetSelected)?;
    if !request.operator_consent {
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
        request.acquisition_mode,
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

    if cancellation.is_cancelled() {
        cancel_controller(&session, &attached_id, &prepared.object_id).await?;
        cleanup_attached_session(
            &session,
            &attached_id,
            Some(&prepared.object_id),
            "operator cancellation before evidence creation",
        )
        .await?;
        return Err(CollectorError::CancelledByOperator);
    }

    let initialized = (|| -> Result<_, CollectorError> {
        let signing_key = unlock(&request.keystore_path, keystore_passphrase)?;
        validate_unlocked_keystore(request, &signing_key)?;
        let started = Instant::now();
        let collector_hash = current_executable_sha256()?;
        let injector_hash = sha256_hex(INJECTOR.as_bytes());
        if let Some(evidence_id) = request.resume_evidence_id {
            let loaded = load_resume_runtime(
                request,
                &report,
                &version,
                &prepared,
                evidence_id,
                keystore_passphrase,
                &injector_hash,
            )?;
            let writer = loaded.writer;
            let checkpoint = loaded.checkpoint;
            let acquisition_id = checkpoint.state.acquisition_id;
            let source_id = checkpoint.state.source_id;
            let log_session_id = checkpoint.state.log_session_id;
            let monotonic_base_ns = writer
                .log_state()?
                .last_monotonic_offset_ns
                .saturating_add(1);
            let audit = build_audit_context(
                request,
                &report,
                &version,
                &prepared,
                evidence_id,
                acquisition_id,
                source_id,
                collector_hash.clone(),
                injector_hash.clone(),
                monotonic_base_ns,
            );
            return Ok((
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
                checkpoint,
            ));
        }
        let evidence_id = Uuid::new_v4();
        let acquisition_id = Uuid::new_v4();
        let source_id = Uuid::new_v4();
        let log_session_id = Uuid::new_v4();
        let audit = build_audit_context(
            request,
            &report,
            &version,
            &prepared,
            evidence_id,
            acquisition_id,
            source_id,
            collector_hash.clone(),
            injector_hash.clone(),
            0,
        );
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
                "mode": request.acquisition_mode.as_str(),
                "claim_scope": "browser_page_observation",
                "account_authenticity": "unverified",
                "profile_original_state": audit.browser_profile_original_state,
                "browser_opened_at_utc": audit.browser_opened_at_utc,
                "browser_page_ready_at_utc": request.existing_profile.as_ref().map(|context| context.browser_page_ready_at_utc.clone()),
                "browser_page_preparation": request.existing_profile.as_ref().map(|context| context.browser_page_preparation.clone()),
                "extension_installation": request.existing_profile.as_ref().map(|_| "operator_loaded_unpacked_extension_in_selected_profile"),
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
        let mut checkpoint = new_checkpoint_runtime(
            request,
            &report,
            &version,
            &prepared,
            &audit,
            log_session_id,
            &writer,
            keystore_passphrase,
        )?;
        append_log(
            &mut writer,
            &audit,
            log_session_id,
            started,
            LogEventType::CheckpointWritten,
            &json!({
                "phase": "initialized",
                "reason": "evidence_staging_created",
            }),
        )?;
        checkpoint.persist(
            &writer,
            CheckpointPhase::Initialized,
            None,
            None,
            None,
            None,
            0,
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
            checkpoint,
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
        mut checkpoint,
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
        request.acquisition_mode,
        request.media_policy,
        &cancellation,
        &progress,
        &mut checkpoint,
        request.resume_evidence_id.is_some(),
    )
    .await;
    let session_outcome = if cancellation.is_cancelled() {
        Err(CollectorError::CancelledByOperator)
    } else {
        session_outcome
    };
    if request.resume_evidence_id.is_some() && !checkpoint.resume_append_authorized {
        let error = session_outcome.err().unwrap_or_else(|| {
            CollectorError::Protocol(
                "resumed stream completed before source revalidation".to_owned(),
            )
        });
        let _ = session.detach_from_target(&attached_id).await;
        let _ = session.close().await;
        return Err(error);
    }

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
                &json!({"code": "acquisition_failed", "detail": bounded_error(&error)}),
            );
            let phase = match &error {
                CollectorError::CancelledByOperator => CheckpointPhase::Cancelled,
                CollectorError::Browser(_)
                | CollectorError::Bridge(_)
                | CollectorError::TargetInvalidated(_) => CheckpointPhase::TransportInterrupted,
                _ => CheckpointPhase::FailedStaging,
            };
            let _ = checkpoint.persist_existing(&writer, phase);
            return Err(error);
        }
    };
    progress(AcquisitionProgress {
        phase: "finalizing".to_owned(),
        status_code: "building_evidence_bag".to_owned(),
        completed: 0,
        total: 0,
        media_index: None,
        media_total: None,
        attempt: None,
        current_asset_bytes: 0,
        total_media_bytes: session_outcome.media_bytes_written,
        elapsed_seconds: started.elapsed().as_secs(),
        current_dataset: None,
        current_output_path: Some("manifest-sha256.txt".to_owned()),
        current_media_kind: None,
        current_file_name: None,
    });
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
            "mode": request.acquisition_mode.as_str(),
            "history_scope": history_scope_label(session_outcome.stream_end.completeness.history_scope),
            "media_scope": media_scope_label(session_outcome.stream_end.completeness.media_scope),
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
    let dispositions = dataset_dispositions(
        &session_outcome.normalization,
        &session_outcome.probe,
        &observation_window,
    );
    writer.write_dataset_inventory(source_id, &finished_at, &dispositions)?;

    let references_resolved = session_outcome.normalization.unresolved_reference_count == 0;
    let completeness = AcquisitionCompletenessSummary {
        overall: completeness_overall(&session_outcome).to_owned(),
        local_snapshot: local_snapshot_label(
            session_outcome.stream_end.completeness.local_snapshot,
        )
        .to_owned(),
        history_scope: history_scope_label(session_outcome.stream_end.completeness.history_scope)
            .to_owned(),
        media_scope: media_scope_label(session_outcome.stream_end.completeness.media_scope)
            .to_owned(),
        reason_codes: completeness_reason_codes(&session_outcome, request.acquisition_mode),
        media_counts: AcquisitionMediaSummary {
            requested: session_outcome.normalization.media.requested,
            available: session_outcome.normalization.media.available,
            missing: session_outcome.normalization.media.missing,
            expired: session_outcome.normalization.media.expired,
            decrypt_error: session_outcome.normalization.media.decrypt_error,
            download_timeout: session_outcome.normalization.media.download_timeout,
            no_progress_timeout: session_outcome.normalization.media.no_progress_timeout,
            too_large: session_outcome.normalization.media.too_large,
            disk_space_insufficient: session_outcome.normalization.media.disk_space_insufficient,
            hash_mismatch: session_outcome.normalization.media.hash_mismatch,
            transport_interrupted: session_outcome.normalization.media.transport_interrupted,
            canceled: session_outcome.normalization.media.canceled,
            unavailable: session_outcome.normalization.media.unavailable,
            not_attempted: session_outcome.normalization.media.not_attempted,
        },
    };
    writer.write_completeness(&CompletenessDto {
        schema_version: SCHEMA_VERSION.to_owned(),
        source_id,
        evaluated_at_utc: finished_at.clone(),
        overall: completeness.overall.clone(),
        local_snapshot: completeness.local_snapshot.clone(),
        history_scope: completeness.history_scope.clone(),
        media_scope: completeness.media_scope.clone(),
        account_scope: "unverifiable".to_owned(),
        dataset_inventory_path: "data/dataset-inventory.json".to_owned(),
        chat_completeness_path: "data/completeness/chats.ndjson".to_owned(),
        media_counts: completeness_media_counts(&session_outcome.normalization.media),
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
        reason_codes: completeness.reason_codes.clone(),
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
                .map_or_else(|| "2.5.3".to_owned(), |context| context.adapter_version.clone()),
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
            enrichment_requested: request.acquisition_mode.requests_enrichment(),
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
                    "browserPageReadyAtUtc": context.browser_page_ready_at_utc,
                    "browserPagePreparation": context.browser_page_preparation,
                    "extensionInstallation": "operator_loaded_unpacked_extension_in_selected_profile",
                    "extensionActivation": "operator_clicked_current_whatsapp_tab",
                    "extensionPairedAtUtc": context.extension_paired_at_utc,
                    "extensionVersion": context.extension_version,
                    "adapterId": context.adapter_id,
                    "adapterVersion": context.adapter_version,
                    "adapterSha256": context.adapter_sha256,
                    "possibleProfileImpacts": original_profile_impacts(context),
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
    checkpoint.persist_sealed(&sealed.path)?;
    state.transition(AcquisitionState::ExternalVerify)?;
    progress(AcquisitionProgress {
        phase: "verifying".to_owned(),
        status_code: "running_independent_verifier".to_owned(),
        completed: 0,
        total: 0,
        media_index: None,
        media_total: None,
        attempt: None,
        current_asset_bytes: 0,
        total_media_bytes: session_outcome.media_bytes_written,
        elapsed_seconds: started.elapsed().as_secs(),
        current_dataset: None,
        current_output_path: Some("Evidence Bag（全部文件）".to_owned()),
        current_media_kind: None,
        current_file_name: None,
    });
    Ok(acquisition_result(
        sealed,
        source_id,
        session_outcome.normalization,
        completeness,
        state.current(),
        checkpoint.cleanup_handle(),
    ))
}

struct SessionOutcome {
    probe: ProbeResultPayload,
    probed_at: String,
    stream_start: StreamStartPayload,
    stream_end: StreamEndPayload,
    normalization: NormalizationSummary,
    media_bytes_written: u64,
    runtime_object_released: bool,
}

struct ActiveMediaWrite {
    binding: ActiveMediaBinding,
    stream: MediaStream,
    prefix: Vec<u8>,
    byte_length: u64,
    last_space_check_bytes: u64,
    chunks_since_checkpoint: u64,
}

struct CheckpointRuntime {
    store: CheckpointStore,
    state: AcquisitionCheckpoint,
    resumed_generation: Option<u64>,
    resumed_previous_phase: Option<CheckpointPhase>,
    resume_append_authorized: bool,
}

struct LoadedResumeRuntime {
    writer: WaebWriter,
    checkpoint: CheckpointRuntime,
}

impl CheckpointRuntime {
    #[allow(clippy::too_many_arguments)]
    fn authorize_resume_append(
        &mut self,
        writer: &mut WaebWriter,
        audit: &AuditContext,
        log_session_id: Uuid,
        started: Instant,
        probe: &ProbeResultPayload,
        probe_ack_retried: bool,
        acquisition_mode: AcquisitionMode,
    ) -> Result<(), CollectorError> {
        if self.resume_append_authorized {
            return Err(CollectorError::Protocol(
                "recovery append authorization was repeated".to_owned(),
            ));
        }
        let generation = self.resumed_generation.ok_or_else(|| {
            CollectorError::Checkpoint(
                "selected recovery omitted its authenticated generation".to_owned(),
            )
        })?;
        let previous_phase = self.resumed_previous_phase.ok_or_else(|| {
            CollectorError::Checkpoint("selected recovery omitted its previous phase".to_owned())
        })?;
        append_log(
            writer,
            audit,
            log_session_id,
            started,
            LogEventType::AcquisitionResumed,
            &json!({
                "checkpoint_generation": generation,
                "previous_phase": recovery_phase_label(previous_phase),
                "completed_media": self.state.source_binding.media_start_index,
                "source_revalidated_before_append": true,
            }),
        )?;
        append_current_probe_logs(
            writer,
            audit,
            log_session_id,
            started,
            probe,
            probe_ack_retried,
        )?;
        append_acquisition_phase_started(
            writer,
            audit,
            log_session_id,
            started,
            acquisition_mode,
            true,
        )?;
        append_log(
            writer,
            audit,
            log_session_id,
            started,
            LogEventType::PhaseStarted,
            &json!({
                "phase": "resume_source_revalidated",
                "same_evidence_id": true,
                "same_source_id": true,
                "media_start_index": self.state.source_binding.media_start_index,
            }),
        )?;
        self.persist_existing(writer, previous_phase)?;
        self.resume_append_authorized = true;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn persist(
        &mut self,
        writer: &WaebWriter,
        phase: CheckpointPhase,
        stream_start: Option<&StreamStartPayload>,
        stream_end: Option<&StreamEndPayload>,
        normalizer: Option<&Normalizer>,
        current_asset: Option<&ActiveMediaWrite>,
        total_media_bytes: u64,
    ) -> Result<u64, CollectorError> {
        self.state.phase = phase;
        self.state.updated_at_utc = utc_now();
        if let Some(stream_start) = stream_start {
            self.state.stream_start = Some(stream_start.clone());
        }
        if let Some(stream_end) = stream_end {
            self.state.stream_end = Some(stream_end.clone());
        }
        if let Some(normalizer) = normalizer {
            self.state.normalizer = Some(normalizer.checkpoint());
            self.state.completed_asset_ids = normalizer.completed_asset_ids();
            self.state.remaining_asset_ids = normalizer.remaining_asset_ids();
            if self.state.acquisition_mode == NormalizationMode::ComprehensiveReadonlyV02 {
                self.state.source_binding.media_start_index = normalizer.terminal_media_count()?;
            }
        }
        self.state.current_asset = current_asset.map(|active| CurrentAssetCheckpoint {
            asset_id: active.binding.asset_id().to_owned(),
            received_bytes: active.byte_length,
        });
        self.state.total_media_bytes = total_media_bytes;
        self.state.files = capture_staging_manifest(writer.staging_path())?;
        self.state.validate(self.state.evidence_id)?;
        self.store.write(&self.state).map_err(CollectorError::from)
    }

    fn cleanup_handle(&self) -> CheckpointCleanup {
        self.store.cleanup_handle()
    }

    fn persist_existing(
        &mut self,
        writer: &WaebWriter,
        phase: CheckpointPhase,
    ) -> Result<u64, CollectorError> {
        self.state.phase = phase;
        self.state.updated_at_utc = utc_now();
        self.state.files = capture_staging_manifest(writer.staging_path())?;
        self.state.validate(self.state.evidence_id)?;
        self.store.write(&self.state).map_err(CollectorError::from)
    }

    fn persist_sealed(&mut self, sealed_path: &std::path::Path) -> Result<u64, CollectorError> {
        self.state.phase = CheckpointPhase::SealedPendingVerification;
        self.state.updated_at_utc = utc_now();
        self.state.current_asset = None;
        self.state.files = capture_staging_manifest(sealed_path)?;
        self.state.validate(self.state.evidence_id)?;
        self.store.write(&self.state).map_err(CollectorError::from)
    }
}

#[derive(Clone, Debug)]
struct MediaScheduleState {
    started_at: Instant,
    last_progress_at: Instant,
    attempt_started_at: Instant,
    last_status_code: String,
    last_attempt: u32,
    last_bytes: u64,
    media_index: u64,
    media_total: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MediaControlAction {
    BeginDownload,
    RetryCurrent,
    Terminate(&'static str),
    StopQueue(&'static str),
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
    adapter_id: Option<String>,
    adapter_version: Option<String>,
    whatsapp_build: Option<String>,
    monotonic_base_ns: u64,
}

#[allow(clippy::too_many_arguments)]
fn build_audit_context(
    request: &AcquisitionRequest,
    report: &PreflightReport,
    version: &BrowserVersion,
    prepared: &PreparedT0,
    evidence_id: Uuid,
    acquisition_id: Uuid,
    source_id: Uuid,
    collector_hash: String,
    injector_hash: String,
    monotonic_base_ns: u64,
) -> AuditContext {
    AuditContext {
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
        collector_sha256: collector_hash,
        injector_version: page_bridge::CONTROLLER_VERSION.to_owned(),
        injector_sha256: injector_hash,
        browser_family: browser_family(version).to_owned(),
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
            .and_then(|context| context.browser_opened_at_utc.clone()),
        adapter_id: prepared.probe.adapter_id.clone(),
        adapter_version: Some(request.existing_profile.as_ref().map_or_else(
            || "2.5.3".to_owned(),
            |context| context.adapter_version.clone(),
        )),
        whatsapp_build: Some(bounded_label(&prepared.probe.build, 160)),
        monotonic_base_ns,
    }
}

fn append_current_probe_logs(
    writer: &mut WaebWriter,
    audit: &AuditContext,
    log_session_id: Uuid,
    started: Instant,
    probe: &ProbeResultPayload,
    probe_ack_retried: bool,
) -> Result<(), CollectorError> {
    if probe_ack_retried {
        append_log(
            writer,
            audit,
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
        writer,
        audit,
        log_session_id,
        started,
        LogEventType::CapabilityProbeCompleted,
        &json!({
            "supported": probe.supported,
            "adapter": probe.adapter_id.clone().unwrap_or_default(),
            "build": probe.build.clone(),
        }),
    )
}

fn append_acquisition_phase_started(
    writer: &mut WaebWriter,
    audit: &AuditContext,
    log_session_id: Uuid,
    started: Instant,
    acquisition_mode: AcquisitionMode,
    resumed: bool,
) -> Result<(), CollectorError> {
    append_log(
        writer,
        audit,
        log_session_id,
        started,
        LogEventType::PhaseStarted,
        &json!({
            "phase": acquisition_mode.as_str(),
            "resumed": resumed,
            "network_actions": acquisition_mode.requests_enrichment(),
            "dom_writes": false,
            "ui_fallback": false,
        }),
    )
}

#[allow(clippy::too_many_arguments)]
fn new_checkpoint_runtime(
    request: &AcquisitionRequest,
    report: &PreflightReport,
    version: &BrowserVersion,
    prepared: &PreparedT0,
    audit: &AuditContext,
    log_session_id: Uuid,
    writer: &WaebWriter,
    passphrase: &str,
) -> Result<CheckpointRuntime, CollectorError> {
    let mut challenge = [0_u8; 32];
    getrandom::fill(&mut challenge)
        .map_err(|_| CollectorError::Checkpoint("checkpoint entropy source failed".to_owned()))?;
    let created_at = utc_now();
    let existing = request.existing_profile.as_ref();
    let source_binding = CheckpointSourceBinding {
        browser_family: browser_family(version).to_owned(),
        browser_version: bounded_label(&version.browser, 120),
        profile_reference_sha256: report.profile_reference_sha256.clone().unwrap_or_else(|| {
            sha256_hex(format!("WAFC-UNRESUMABLE-PROFILE-v1\0{}", audit.evidence_id).as_bytes())
        }),
        extension_version: existing.map_or_else(
            || page_bridge::CONTROLLER_VERSION.to_owned(),
            |context| context.extension_version.clone(),
        ),
        adapter_id: prepared.probe.adapter_id.clone().ok_or_else(|| {
            CollectorError::Checkpoint("adapter binding is unavailable".to_owned())
        })?,
        adapter_version: existing.map_or_else(
            || "2.5.3".to_owned(),
            |context| context.adapter_version.clone(),
        ),
        adapter_sha256: existing.map_or_else(
            || audit.injector_sha256.clone(),
            |context| context.adapter_sha256.clone(),
        ),
        injector_sha256: audit.injector_sha256.clone(),
        whatsapp_build: prepared.probe.build.clone(),
        resume_challenge_hex: hex::encode(challenge),
        resume_binding_sha256: None,
        media_plan_sha256: None,
        media_start_index: 0,
    };
    let state = AcquisitionCheckpoint {
        schema_version: "wafc-acquisition-checkpoint/1".to_owned(),
        phase: CheckpointPhase::Initialized,
        evidence_id: audit.evidence_id,
        acquisition_id: audit.acquisition_id,
        source_id: audit.source_id,
        log_session_id,
        created_at_utc: created_at.clone(),
        updated_at_utc: created_at,
        portable_bundle_id: audit.portable_bundle_id,
        portable_manifest_sha256: audit.portable_manifest_sha256.clone(),
        assignment_id: audit.assignment_id.clone(),
        assignment_sha256: audit.assignment_sha256.clone(),
        operator_key_fingerprint_sha256: audit.operator_key_fingerprint_sha256.clone(),
        key_id: request.key_id.clone(),
        acquisition_mode: normalization_mode(request.acquisition_mode),
        source_binding,
        snapshot_sha256: None,
        stream_start: None,
        stream_end: None,
        normalizer: None,
        completed_asset_ids: Vec::new(),
        remaining_asset_ids: Vec::new(),
        current_asset: None,
        total_media_bytes: 0,
        files: capture_staging_manifest(writer.staging_path())?,
    };
    state.validate(audit.evidence_id)?;
    Ok(CheckpointRuntime {
        store: CheckpointStore::create(
            &report.evidence_staging_dir,
            audit.evidence_id,
            passphrase,
        )?,
        state,
        resumed_generation: None,
        resumed_previous_phase: None,
        resume_append_authorized: true,
    })
}

#[allow(clippy::too_many_arguments)]
fn load_resume_runtime(
    request: &AcquisitionRequest,
    report: &PreflightReport,
    version: &BrowserVersion,
    prepared: &PreparedT0,
    evidence_id: Uuid,
    passphrase: &str,
    injector_hash: &str,
) -> Result<LoadedResumeRuntime, CollectorError> {
    let loaded = CheckpointStore::load_latest::<AcquisitionCheckpoint>(
        &report.evidence_staging_dir,
        evidence_id,
        passphrase,
    )?
    .ok_or_else(|| {
        CollectorError::Checkpoint("selected recovery checkpoint is unavailable".to_owned())
    })?;
    let generation = loaded.generation;
    let checkpoint = loaded.payload;
    checkpoint.validate(evidence_id)?;
    let previous_phase = checkpoint.phase;
    if !checkpoint_matches_portable_task(&checkpoint, request)
        || !checkpoint_phase_is_resumable(previous_phase)
        || checkpoint.source_binding.browser_family != browser_family(version)
        || checkpoint.source_binding.browser_version != bounded_label(&version.browser, 120)
        || checkpoint.source_binding.injector_sha256 != injector_hash
        || checkpoint.source_binding.whatsapp_build != prepared.probe.build
        || checkpoint.source_binding.adapter_id.as_str()
            != prepared.probe.adapter_id.as_deref().unwrap_or_default()
        || report.profile_reference_sha256.as_deref()
            != Some(checkpoint.source_binding.profile_reference_sha256.as_str())
    {
        return Err(CollectorError::Checkpoint(
            "the incomplete acquisition does not match the current task, Profile, browser, extension, Adapter, or WhatsApp page"
                .to_owned(),
        ));
    }
    let normalizer_checkpoint = checkpoint.normalizer.clone().ok_or_else(|| {
        CollectorError::Checkpoint("recovery checkpoint has no structured snapshot".to_owned())
    })?;
    let normalizer = Normalizer::restore(
        normalizer_checkpoint,
        checkpoint.source_id,
        checkpoint.acquisition_mode,
    )?;
    let summary = normalizer.summary();
    let completed_media = normalizer.terminal_media_count()?;
    if !checkpoint_has_resumable_media(&checkpoint, &summary, completed_media) {
        return Err(CollectorError::Checkpoint(
            "recovery checkpoint is not at a safe media boundary".to_owned(),
        ));
    }
    let package = report
        .evidence_staging_dir
        .join(format!("waeb-{evidence_id}.partial"))
        .join(format!("waeb-{evidence_id}"));
    restore_staging_manifest(&package, &checkpoint.files)?;
    let writer = WaebWriter::reopen_with_roots(
        &report.evidence_staging_dir,
        &report.evidence_sealed_dir,
        evidence_id,
        checkpoint.source_id,
    )?;
    Ok(LoadedResumeRuntime {
        writer,
        checkpoint: CheckpointRuntime {
            store: loaded.store,
            state: checkpoint,
            resumed_generation: Some(generation),
            resumed_previous_phase: Some(previous_phase),
            resume_append_authorized: false,
        },
    })
}

const fn normalization_mode(mode: AcquisitionMode) -> NormalizationMode {
    match mode {
        AcquisitionMode::PassiveT0 => NormalizationMode::PassiveT0,
        AcquisitionMode::ComprehensiveReadonlyV02 => NormalizationMode::ComprehensiveReadonlyV02,
    }
}

fn checkpoint_matches_portable_task(
    checkpoint: &AcquisitionCheckpoint,
    request: &AcquisitionRequest,
) -> bool {
    let Some(profile) = request.existing_profile.as_ref() else {
        return false;
    };
    checkpoint.portable_bundle_id == request.portable_configuration.bundle_id
        && checkpoint.portable_manifest_sha256
            == request.portable_configuration.bundle_manifest_sha256
        && checkpoint.assignment_id == request.portable_configuration.assignment_id
        && checkpoint.assignment_sha256 == request.portable_configuration.assignment_sha256
        && checkpoint.operator_key_fingerprint_sha256
            == request
                .portable_configuration
                .operator_key_fingerprint_sha256
        && checkpoint.key_id == request.key_id
        && checkpoint.acquisition_mode == normalization_mode(request.acquisition_mode)
        && checkpoint.source_binding.profile_reference_sha256 == profile.profile_reference_sha256
        && checkpoint.source_binding.browser_family == profile.browser_family
        && checkpoint.source_binding.extension_version == profile.extension_version
        && checkpoint.source_binding.adapter_id == profile.adapter_id
        && checkpoint.source_binding.adapter_version == profile.adapter_version
        && checkpoint.source_binding.adapter_sha256 == profile.adapter_sha256
        && checkpoint.source_binding.injector_sha256 == sha256_hex(INJECTOR.as_bytes())
}

const fn checkpoint_phase_is_resumable(phase: CheckpointPhase) -> bool {
    matches!(
        phase,
        CheckpointPhase::StructuredComplete
            | CheckpointPhase::MediaInProgress
            | CheckpointPhase::Cancelled
            | CheckpointPhase::TransportInterrupted
    )
}

const fn recovery_phase_label(phase: CheckpointPhase) -> &'static str {
    match phase {
        CheckpointPhase::StructuredComplete => "structured_complete",
        CheckpointPhase::MediaInProgress => "media_in_progress",
        CheckpointPhase::Cancelled => "cancelled",
        CheckpointPhase::TransportInterrupted => "connection_interrupted",
        CheckpointPhase::Initialized
        | CheckpointPhase::StreamComplete
        | CheckpointPhase::FailedStaging
        | CheckpointPhase::SealedPendingVerification => "not_resumable",
    }
}

fn checkpoint_has_resumable_media(
    checkpoint: &AcquisitionCheckpoint,
    summary: &NormalizationSummary,
    completed_media: u64,
) -> bool {
    let Some(stream_start) = checkpoint.stream_start.as_ref() else {
        return false;
    };
    checkpoint
        .snapshot_sha256
        .as_deref()
        .is_some_and(valid_lower_sha256)
        && checkpoint
            .source_binding
            .resume_binding_sha256
            .as_deref()
            .is_some_and(valid_lower_sha256)
        && checkpoint
            .source_binding
            .media_plan_sha256
            .as_deref()
            .is_some_and(valid_lower_sha256)
        && checkpoint.source_binding.media_plan_sha256.as_deref()
            == Some(stream_start.media_plan_sha256.as_str())
        && checkpoint.source_binding.media_start_index == completed_media
        && summary.media.requested > completed_media
        && u64::try_from(checkpoint.completed_asset_ids.len()).ok() == Some(completed_media)
        && u64::try_from(checkpoint.remaining_asset_ids.len()).ok()
            == summary.media.requested.checked_sub(completed_media)
}

fn valid_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[allow(clippy::too_many_arguments)]
fn ensure_structured_checkpoint(
    written: &mut bool,
    writer: &mut WaebWriter,
    checkpoint: &mut CheckpointRuntime,
    normalizer: &Normalizer,
    stream_start: &StreamStartPayload,
    snapshot_hasher: &Sha256,
    audit: &AuditContext,
    log_session_id: Uuid,
    started: Instant,
    total_media_bytes: u64,
) -> Result<(), CollectorError> {
    if *written {
        return Ok(());
    }
    validate_structured_counts(stream_start, &normalizer.summary())?;
    normalizer.validate_reference_closure()?;
    normalizer.write_chat_completeness(writer)?;
    checkpoint.state.snapshot_sha256 = Some(hex::encode(snapshot_hasher.clone().finalize()));
    append_log(
        writer,
        audit,
        log_session_id,
        started,
        LogEventType::CheckpointWritten,
        &json!({
            "phase": "structured_complete",
            "reason": "all_declared_record_batches_committed",
        }),
    )?;
    checkpoint.persist(
        writer,
        CheckpointPhase::StructuredComplete,
        Some(stream_start),
        None,
        Some(normalizer),
        None,
        total_media_bytes,
    )?;
    *written = true;
    Ok(())
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
            &[json!({"value": {
                "command": "probe",
                "protocol": page_bridge::PROTOCOL,
                "controllerVersion": page_bridge::CONTROLLER_VERSION,
            }})],
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
    acquisition_mode: AcquisitionMode,
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
        validate_probe(&attached_probe.probe, acquisition_mode)?;
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
            instruction: match acquisition_mode {
                AcquisitionMode::PassiveT0 => "请核对当前 WhatsApp 页面与本次任务；确认后仅采集当前已驻留的可观察数据。",
                AcquisitionMode::ComprehensiveReadonlyV02 => "请核对当前 WhatsApp 页面与本次任务，并确认允许只读历史和媒体加载可能产生网络同步及缓存变化。",
            }.to_owned(),
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
    acquisition_mode: AcquisitionMode,
    media_policy: MediaPolicy,
    cancellation: &AcquisitionCancellation,
    progress: &(dyn Fn(AcquisitionProgress) + Send + Sync),
    checkpoint: &mut CheckpointRuntime,
    resume_existing: bool,
) -> Result<SessionOutcome, CollectorError> {
    let PreparedT0 {
        target_lock,
        object_id,
        controller_session_id,
        mut validator,
        probe,
        probed_at,
        account_binding,
        probe_ack_retried,
    } = prepared;
    let controller_result: Result<SessionOutcome, CollectorError> = async {
        state.transition(AcquisitionState::T0)?;
        let normalization_mode = if acquisition_mode.requests_enrichment() {
            NormalizationMode::ComprehensiveReadonlyV02
        } else {
            NormalizationMode::PassiveT0
        };
        let mut normalizer = if resume_existing {
            Normalizer::restore(
                checkpoint.state.normalizer.clone().ok_or_else(|| {
                    CollectorError::Checkpoint(
                        "selected recovery has no structured snapshot".to_owned(),
                    )
                })?,
                source_id,
                normalization_mode,
            )?
        } else {
            Normalizer::new(source_id, normalization_mode)
        };
        let expected_resume_binding = if resume_existing {
            Some(decode_account_binding(
                checkpoint
                    .state
                    .source_binding
                    .resume_binding_sha256
                    .as_deref()
                    .ok_or_else(|| {
                        CollectorError::Checkpoint(
                            "selected recovery has no page-continuity binding".to_owned(),
                        )
                    })?,
            )?)
        } else {
            None
        };
        if resume_existing {
            progress(AcquisitionProgress {
                phase: "recovering".to_owned(),
                status_code: "revalidating_recovery_source".to_owned(),
                completed: checkpoint.state.source_binding.media_start_index,
                total: normalizer.summary().media.requested,
                media_index: None,
                media_total: None,
                attempt: None,
                current_asset_bytes: 0,
                total_media_bytes: checkpoint.state.total_media_bytes,
                elapsed_seconds: started.elapsed().as_secs(),
                current_dataset: Some("media".to_owned()),
                current_output_path: Some("data/media/sha256/<resume>".to_owned()),
                current_media_kind: None,
                current_file_name: None,
            });
        }
        if !resume_existing {
            append_acquisition_phase_started(
                writer,
                audit,
                log_session_id,
                started,
                acquisition_mode,
                false,
            )?;
        }
        let dispatch = call_value(
            session,
            attached_id,
            DISPATCH_FUNCTION,
            &object_id,
            &[json!({"value": if acquisition_mode.requests_enrichment() {
                json!({
                    "command": "start_comprehensive",
                    "protocol": page_bridge::PROTOCOL,
                    "controllerVersion": page_bridge::CONTROLLER_VERSION,
                    "mediaPolicy": media_policy,
                    "resume": resume_request(&checkpoint.state, &normalizer, resume_existing)?,
                })
            } else {
                json!({
                    "command": "start_t0",
                    "protocol": page_bridge::PROTOCOL,
                    "controllerVersion": page_bridge::CONTROLLER_VERSION,
                    "resume": resume_request(&checkpoint.state, &normalizer, false)?,
                })
            }})],
        )
        .await?;
        let (t0_session_id, resume_binding) = successful_start_dispatch(&dispatch)?;
        if t0_session_id != controller_session_id {
            return Err(CollectorError::Protocol(
                "controller session changed between probe and passive T0".to_owned(),
            ));
        }
        if expected_resume_binding
            .as_ref()
            .is_some_and(|expected| !bool::from(expected.ct_eq(&resume_binding)))
        {
            return Err(CollectorError::RecoverySourceMismatch);
        }
        checkpoint.state.source_binding.resume_binding_sha256 =
            Some(hex::encode(resume_binding));
        let mut stream_start = None;
        let mut stream_end = None;
        let mut active_media: Option<ActiveMediaWrite> = None;
        let mut media_schedule: Option<MediaScheduleState> = None;
        let mut total_media_bytes = checkpoint.state.total_media_bytes;
        let mut snapshot_hasher = Sha256::new();
        snapshot_hasher.update(SNAPSHOT_CHECKPOINT_DOMAIN);
        let mut structured_checkpoint_written = resume_existing;
        loop {
            if cancellation.is_cancelled() {
                cancel_controller(session, attached_id, &object_id).await?;
                if !resume_existing || checkpoint.resume_append_authorized {
                    append_log(
                        writer,
                        audit,
                        log_session_id,
                        started,
                        LogEventType::Warning,
                        &json!({
                            "code": "operator_cancelled",
                            "browser_network_stop_guaranteed": false,
                        }),
                    )?;
                    checkpoint.persist(
                        writer,
                        CheckpointPhase::Cancelled,
                        stream_start.as_ref(),
                        stream_end.as_ref(),
                        Some(&normalizer),
                        active_media.as_ref(),
                        total_media_bytes,
                    )?;
                }
                return Err(CollectorError::CancelledByOperator);
            }
            let mut post_ack_media_action: Option<MediaControlAction> = None;
            let mut post_ack_delay = None;
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
                    validate_stream_start(
                        &payload,
                        &account_binding,
                        &resume_binding,
                        acquisition_mode,
                        resume_existing,
                        resume_existing
                            .then_some(checkpoint.state.source_binding.media_plan_sha256.as_deref())
                            .flatten(),
                        resume_existing
                            .then_some(checkpoint.state.source_binding.media_start_index),
                    )?;
                    if resume_existing {
                        validate_structured_counts(&payload, &normalizer.summary())?;
                        checkpoint.authorize_resume_append(
                            writer,
                            audit,
                            log_session_id,
                            started,
                            &probe,
                            probe_ack_retried,
                            acquisition_mode,
                        )?;
                    }
                    checkpoint.state.source_binding.media_plan_sha256 =
                        Some(payload.media_plan_sha256.clone());
                    checkpoint.state.source_binding.media_start_index =
                        payload.media_start_index;
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
                    snapshot_hasher.update(frame.payload_bytes.to_be_bytes());
                    snapshot_hasher.update(frame.payload.as_bytes());
                    let accepted = normalizer
                        .summary()
                        .record_counts
                        .values()
                        .copied()
                        .sum::<u64>();
                    let declared = start
                        .datasets
                        .iter()
                        .map(|item| item.observed_records)
                        .sum::<u64>();
                    progress(AcquisitionProgress {
                        phase: "records".to_owned(),
                        status_code: "records_streaming".to_owned(),
                        completed: accepted,
                        total: declared,
                        media_index: None,
                        media_total: None,
                        attempt: None,
                        current_asset_bytes: 0,
                        total_media_bytes,
                        elapsed_seconds: started.elapsed().as_secs(),
                        current_dataset: Some(payload.dataset.as_str().to_owned()),
                        current_output_path: Some(normalized_output_path(payload.dataset.as_str())),
                        current_media_kind: None,
                        current_file_name: None,
                    });
                }
                FrameKind::Progress => {
                    if stream_end.is_some() {
                        return Err(CollectorError::Protocol(
                            "progress appeared in an invalid stream phase".to_owned(),
                        ));
                    }
                    let payload: ProgressPayload =
                        serde_json::from_str(&frame.payload).map_err(|_| {
                            CollectorError::Protocol("invalid progress payload".to_owned())
                        })?;
                    if payload.phase == "media" {
                        let schedule = media_schedule.as_mut().ok_or_else(|| {
                            CollectorError::Protocol(
                                "media progress appeared without an active scheduler".to_owned(),
                            )
                        })?;
                        if active_media.is_none()
                            || payload.media_index != Some(schedule.media_index)
                            || payload.media_total != Some(schedule.media_total)
                        {
                            return Err(CollectorError::Protocol(
                                "media progress position changed unexpectedly".to_owned(),
                            ));
                        }
                        let now = Instant::now();
                        let observed_attempt = payload.attempt.unwrap_or(0);
                        let observed_bytes = payload.bytes_observed.unwrap_or(0);
                        if payload.status_code != schedule.last_status_code
                            || observed_attempt != schedule.last_attempt
                            || observed_bytes > schedule.last_bytes
                        {
                            schedule.last_progress_at = now;
                            if observed_attempt != schedule.last_attempt {
                                schedule.attempt_started_at = now;
                            }
                            schedule.last_status_code.clone_from(&payload.status_code);
                            schedule.last_attempt = observed_attempt;
                            schedule.last_bytes = observed_bytes;
                        }
                        post_ack_media_action = media_policy_action(
                            media_policy,
                            schedule,
                            &payload,
                            now,
                        );
                        post_ack_delay = payload.retry_after_ms.map(Duration::from_millis);
                        progress(AcquisitionProgress {
                            phase: "media".to_owned(),
                            status_code: payload.status_code.clone(),
                            completed: payload.completed,
                            total: payload.total,
                            media_index: payload.media_index,
                            media_total: payload.media_total,
                            attempt: payload.attempt,
                            current_asset_bytes: active_media
                                .as_ref()
                                .map_or(0, |value| value.byte_length),
                            total_media_bytes,
                            elapsed_seconds: started.elapsed().as_secs(),
                            current_dataset: Some("media".to_owned()),
                            current_output_path: Some("data/media/sha256/<hash-pending>".to_owned()),
                            current_media_kind: active_media
                                .as_ref()
                                .map(|value| value.binding.kind().to_owned()),
                            current_file_name: active_media.as_ref().and_then(|value| {
                                bounded_original_file_name(value.binding.original_file_name())
                            }),
                        });
                    } else if active_media.is_some() || media_schedule.is_some() {
                        return Err(CollectorError::Protocol(
                            "non-media progress appeared during a media task".to_owned(),
                        ));
                    } else {
                        progress(AcquisitionProgress {
                            phase: payload.phase.clone(),
                            status_code: payload.status_code.clone(),
                            completed: payload.completed,
                            total: payload.total,
                            media_index: None,
                            media_total: None,
                            attempt: None,
                            current_asset_bytes: 0,
                            total_media_bytes,
                            elapsed_seconds: started.elapsed().as_secs(),
                            current_dataset: None,
                            current_output_path: None,
                            current_media_kind: None,
                            current_file_name: None,
                        });
                    }
                    if payload.status_code == "history_chat_complete"
                        || payload.status_code == "snapshot_ready"
                    {
                        append_log(
                            writer,
                            audit,
                            log_session_id,
                            started,
                            LogEventType::CheckpointWritten,
                            &json!({
                                "phase": payload.phase,
                                "completed": payload.completed,
                                "total": payload.total,
                                "status_code": payload.status_code,
                            }),
                        )?;
                    }
                }
                FrameKind::MediaStart => {
                    if stream_start.is_none()
                        || stream_end.is_some()
                        || active_media.is_some()
                        || !acquisition_mode.requests_enrichment()
                    {
                        return Err(CollectorError::Protocol(
                            "media_start appeared outside comprehensive media phase".to_owned(),
                        ));
                    }
                    let payload: MediaStartPayload =
                        serde_json::from_str(&frame.payload).map_err(|_| {
                            CollectorError::Protocol("invalid media_start payload".to_owned())
                        })?;
                    let start = stream_start.as_ref().ok_or_else(|| {
                        CollectorError::Protocol("media_start preceded stream_start".to_owned())
                    })?;
                    ensure_structured_checkpoint(
                        &mut structured_checkpoint_written,
                        writer,
                        checkpoint,
                        &normalizer,
                        start,
                        &snapshot_hasher,
                        audit,
                        log_session_id,
                        started,
                        total_media_bytes,
                    )?;
                    let binding = normalizer.begin_media(&payload)?;
                    let summary = normalizer.summary();
                    let media_index = media_terminal_count(&summary.media) + 1;
                    let media_total = summary.media.requested;
                    if media_index == 0 || media_index > media_total {
                        return Err(CollectorError::Protocol(
                            "media_start position exceeds discovered media tasks".to_owned(),
                        ));
                    }
                    active_media = Some(ActiveMediaWrite {
                        binding,
                        stream: writer.start_media()?,
                        prefix: Vec::with_capacity(MEDIA_PREFIX_BYTES),
                        byte_length: 0,
                        last_space_check_bytes: 0,
                        chunks_since_checkpoint: 0,
                    });
                    let now = Instant::now();
                    media_schedule = Some(MediaScheduleState {
                        started_at: now,
                        last_progress_at: now,
                        attempt_started_at: now,
                        last_status_code: "media_start".to_owned(),
                        last_attempt: payload.attempts,
                        last_bytes: 0,
                        media_index,
                        media_total,
                    });
                    post_ack_media_action = media_start_limit_action(
                        media_policy,
                        total_media_bytes,
                        payload.expected_size,
                        available_space_bytes(writer.staging_path()),
                    );
                    progress(AcquisitionProgress {
                        phase: "media".to_owned(),
                        status_code: "media_start".to_owned(),
                        completed: media_index.saturating_sub(1),
                        total: media_total,
                        media_index: Some(media_index),
                        media_total: Some(media_total),
                        attempt: Some(payload.attempts),
                        current_asset_bytes: 0,
                        total_media_bytes,
                        elapsed_seconds: started.elapsed().as_secs(),
                        current_dataset: Some("media".to_owned()),
                        current_output_path: Some("data/media/sha256/<hash-pending>".to_owned()),
                        current_media_kind: Some(payload.kind.clone()),
                        current_file_name: bounded_original_file_name(
                            payload.original_file_name.as_deref(),
                        ),
                    });
                    append_log(
                        writer,
                        audit,
                        log_session_id,
                        started,
                        LogEventType::MediaAttempt,
                        &json!({
                            "status": "started",
                            "method": payload.method,
                            "attempts": payload.attempts,
                            "declared_size": payload.expected_size,
                        }),
                    )?;
                }
                FrameKind::MediaChunk => {
                    let active = active_media.as_mut().ok_or_else(|| {
                        CollectorError::Protocol("media chunk has no active asset".to_owned())
                    })?;
                    let bytes = media_chunk_bytes(&frame)?;
                    let previous_length = active.byte_length;
                    active.byte_length = checked_media_stream_length(
                        active.byte_length,
                        bytes.len(),
                    )?;
                    append_media_detection_prefix(&mut active.prefix, &bytes);
                    active.stream.write_chunk(&bytes)?;
                    active.chunks_since_checkpoint = active
                        .chunks_since_checkpoint
                        .checked_add(1)
                        .ok_or_else(|| {
                            CollectorError::Protocol("media checkpoint counter overflow".to_owned())
                        })?;
                    if active.byte_length / MEDIA_SPACE_RECHECK_BYTES
                        > active.last_space_check_bytes / MEDIA_SPACE_RECHECK_BYTES
                    {
                        active.last_space_check_bytes = active.byte_length;
                        if available_space_bytes(writer.staging_path())
                            .is_some_and(|available| available < MEDIA_SPACE_RESERVE_BYTES)
                        {
                            post_ack_media_action = Some(MediaControlAction::StopQueue(
                                "media_disk_space_insufficient",
                            ));
                        }
                    }
                    let schedule = media_schedule.as_mut().ok_or_else(|| {
                        CollectorError::Protocol(
                            "media chunk appeared without an active scheduler".to_owned(),
                        )
                    })?;
                    schedule.last_progress_at = Instant::now();
                    schedule.last_bytes = active.byte_length;
                    "media_streaming".clone_into(&mut schedule.last_status_code);
                    if active.byte_length > media_policy.max_asset_bytes {
                        post_ack_media_action =
                            Some(MediaControlAction::Terminate("media_too_large"));
                    } else if total_media_bytes.saturating_add(active.byte_length)
                        > media_policy.max_total_bytes
                    {
                        post_ack_media_action = Some(MediaControlAction::StopQueue(
                            "media_total_limit_reached",
                        ));
                    }
                    if previous_length == 0
                        || previous_length / MEDIA_PROGRESS_REPORT_BYTES
                            != active.byte_length / MEDIA_PROGRESS_REPORT_BYTES
                    {
                        progress(AcquisitionProgress {
                            phase: "media".to_owned(),
                            status_code: "media_streaming".to_owned(),
                            completed: schedule.media_index.saturating_sub(1),
                            total: schedule.media_total,
                            media_index: Some(schedule.media_index),
                            media_total: Some(schedule.media_total),
                            attempt: Some(schedule.last_attempt),
                            current_asset_bytes: active.byte_length,
                            total_media_bytes,
                            elapsed_seconds: started.elapsed().as_secs(),
                            current_dataset: Some("media".to_owned()),
                            current_output_path: Some("data/media/sha256/<hash-pending>".to_owned()),
                            current_media_kind: Some(active.binding.kind().to_owned()),
                            current_file_name: bounded_original_file_name(
                                active.binding.original_file_name(),
                            ),
                        });
                    }
                    if active.chunks_since_checkpoint >= MEDIA_CHECKPOINT_CHUNKS {
                        append_log(
                            writer,
                            audit,
                            log_session_id,
                            started,
                            LogEventType::CheckpointWritten,
                            &json!({
                                "phase": "media_in_progress",
                                "reason": "fixed_chunk_interval",
                                "received_bytes": active.byte_length,
                            }),
                        )?;
                        checkpoint.persist(
                            writer,
                            CheckpointPhase::MediaInProgress,
                            stream_start.as_ref(),
                            None,
                            Some(&normalizer),
                            Some(active),
                            total_media_bytes,
                        )?;
                        active.chunks_since_checkpoint = 0;
                    }
                }
                FrameKind::MediaEnd => {
                    let payload: MediaEndPayload =
                        serde_json::from_str(&frame.payload).map_err(|_| {
                            CollectorError::Protocol("invalid media_end payload".to_owned())
                        })?;
                    let active = active_media.take().ok_or_else(|| {
                        CollectorError::Protocol("media_end has no active asset".to_owned())
                    })?;
                    let available = payload.status == "available";
                    if (available && active.byte_length != payload.total_bytes)
                        || (!available && payload.total_bytes != 0)
                    {
                        return Err(CollectorError::Protocol(
                            "media_end byte count differs from Rust writes".to_owned(),
                        ));
                    }
                    let detected = available.then(|| {
                        detect_media(&active.prefix, active.binding.declared_mime.as_deref())
                    });
                    let asset = if available {
                        Some(active.stream.commit()?)
                    } else {
                        drop(active.stream);
                        None
                    };
                    normalizer.finish_media(
                        &active.binding,
                        &payload,
                        asset.as_ref(),
                        detected.as_ref(),
                        writer,
                    )?;
                    let schedule = media_schedule.take().ok_or_else(|| {
                        CollectorError::Protocol(
                            "media_end appeared without an active scheduler".to_owned(),
                        )
                    })?;
                    if available {
                        total_media_bytes = total_media_bytes
                            .checked_add(payload.total_bytes)
                            .ok_or_else(|| {
                                CollectorError::Protocol(
                                    "total media byte count overflow".to_owned(),
                                )
                            })?;
                    } else if !media_policy.continue_on_failure {
                        post_ack_media_action = Some(MediaControlAction::StopQueue(
                            "media_policy_stop_after_failure",
                        ));
                    }
                    progress(AcquisitionProgress {
                        phase: "media".to_owned(),
                        status_code: if available {
                            "media_asset_complete".to_owned()
                        } else {
                            "media_asset_unavailable".to_owned()
                        },
                        completed: schedule.media_index,
                        total: schedule.media_total,
                        media_index: Some(schedule.media_index),
                        media_total: Some(schedule.media_total),
                        attempt: Some(payload.attempts),
                        current_asset_bytes: if available { payload.total_bytes } else { 0 },
                        total_media_bytes,
                        elapsed_seconds: started.elapsed().as_secs(),
                        current_dataset: Some("media".to_owned()),
                        current_output_path: asset.as_ref().map_or_else(
                            || "data/indexes/media.ndjson".to_owned(),
                            |value| value.relative_path.clone(),
                        ).into(),
                        current_media_kind: Some(active.binding.kind().to_owned()),
                        current_file_name: bounded_original_file_name(
                            active.binding.original_file_name(),
                        ),
                    });
                    append_log(
                        writer,
                        audit,
                        log_session_id,
                        started,
                        LogEventType::MediaAttempt,
                        &json!({
                            "status": payload.status,
                            "byte_length": payload.total_bytes,
                            "error_code": payload.error_code,
                        }),
                    )?;
                    append_log(
                        writer,
                        audit,
                        log_session_id,
                        started,
                        LogEventType::CheckpointWritten,
                        &json!({
                            "phase": "media",
                            "completed": schedule.media_index,
                            "total": schedule.media_total,
                            "status_code": if available { "media_asset_complete" } else { "media_asset_unavailable" },
                            "total_committed_bytes": total_media_bytes,
                        }),
                    )?;
                    checkpoint.persist(
                        writer,
                        CheckpointPhase::MediaInProgress,
                        stream_start.as_ref(),
                        None,
                        Some(&normalizer),
                        None,
                        total_media_bytes,
                    )?;
                }
                FrameKind::StreamEnd => {
                    if stream_start.is_none()
                        || stream_end.is_some()
                        || active_media.is_some()
                        || media_schedule.is_some()
                    {
                        return Err(CollectorError::Protocol(
                            "invalid stream_end ordering".to_owned(),
                        ));
                    }
                    let payload: StreamEndPayload =
                        serde_json::from_str(&frame.payload).map_err(|error| {
                            CollectorError::Protocol(format!("invalid stream_end payload: {error}"))
                        })?;
                    let start = stream_start.as_ref().ok_or_else(|| {
                        CollectorError::Protocol("stream_end preceded stream_start".to_owned())
                    })?;
                    ensure_structured_checkpoint(
                        &mut structured_checkpoint_written,
                        writer,
                        checkpoint,
                        &normalizer,
                        start,
                        &snapshot_hasher,
                        audit,
                        log_session_id,
                        started,
                        total_media_bytes,
                    )?;
                    validate_stream_end(
                        &payload,
                        &normalizer.summary(),
                        &account_binding,
                        &resume_binding,
                        start,
                        acquisition_mode,
                        media_policy,
                    )?;
                    append_log(
                        writer,
                        audit,
                        log_session_id,
                        started,
                        LogEventType::CheckpointWritten,
                        &json!({
                            "phase": "stream_complete",
                            "reason": "stream_end_validated",
                        }),
                    )?;
                    checkpoint.persist(
                        writer,
                        CheckpointPhase::StreamComplete,
                        Some(start),
                        Some(&payload),
                        Some(&normalizer),
                        None,
                        total_media_bytes,
                    )?;
                    stream_end = Some(payload);
                }
                FrameKind::Error => {
                    let payload: ErrorPayload =
                        serde_json::from_str(&frame.payload).map_err(|_| {
                            CollectorError::Protocol("invalid page error frame".to_owned())
                        })?;
                    if payload.message != payload.code
                        || !matches!(
                            payload.code.as_str(),
                            "snapshot_failed" | "history_failed" | "media_protocol_failed"
                        )
                    {
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
                FrameKind::ProbeResult => {
                    return Err(CollectorError::Protocol(
                        "unexpected probe frame during acquisition".to_owned(),
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
            if let Some(action) = post_ack_media_action {
                apply_media_control(session, attached_id, &object_id, action).await?;
            }
            if let Some(delay) = post_ack_delay {
                tokio::time::sleep(delay).await;
            }
            if stream_end.is_some() {
                break;
            }
        }
        if cancellation.is_cancelled() {
            cancel_controller(session, attached_id, &object_id).await?;
            append_log(
                writer,
                audit,
                log_session_id,
                started,
                LogEventType::Warning,
                &json!({
                    "code": "operator_cancelled_before_finalization",
                    "browser_network_stop_guaranteed": false,
                }),
            )?;
            checkpoint.persist(
                writer,
                CheckpointPhase::Cancelled,
                stream_start.as_ref(),
                stream_end.as_ref(),
                Some(&normalizer),
                active_media.as_ref(),
                total_media_bytes,
            )?;
            return Err(CollectorError::CancelledByOperator);
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
        Ok(SessionOutcome {
            probe,
            probed_at,
            stream_start,
            stream_end,
            normalization: normalizer.summary(),
            media_bytes_written: total_media_bytes,
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
            if !resume_existing || checkpoint.resume_append_authorized {
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
            }
            Err(release_error.into())
        }
        (Err(controller_error), release) => {
            if let Err(release_error) = release
                && (!resume_existing || checkpoint.resume_append_authorized)
            {
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

fn media_policy_action(
    policy: MediaPolicy,
    schedule: &MediaScheduleState,
    payload: &ProgressPayload,
    now: Instant,
) -> Option<MediaControlAction> {
    if now.duration_since(schedule.started_at)
        >= Duration::from_secs(u64::from(policy.max_asset_duration_seconds))
    {
        return Some(MediaControlAction::Terminate("media_download_timeout"));
    }
    if payload.status_code == "media_checking_cache"
        && now.duration_since(schedule.started_at)
            >= Duration::from_secs(u64::from(policy.cache_lookup_timeout_seconds))
    {
        return Some(
            if matches!(policy.mode, MediaPolicyMode::NetworkBestEffort) {
                MediaControlAction::BeginDownload
            } else {
                MediaControlAction::Terminate("media_cache_miss_network_disallowed")
            },
        );
    }
    if payload.status_code == "media_cache_miss" {
        return Some(
            if matches!(policy.mode, MediaPolicyMode::NetworkBestEffort) {
                MediaControlAction::BeginDownload
            } else {
                MediaControlAction::Terminate("media_cache_miss_network_disallowed")
            },
        );
    }
    if payload.status_code == "media_retrying" {
        return Some(if schedule.last_attempt < u32::from(policy.max_attempts) {
            MediaControlAction::RetryCurrent
        } else {
            MediaControlAction::Terminate("media_download_timeout")
        });
    }
    if schedule.last_attempt > 0
        && matches!(
            payload.status_code.as_str(),
            "media_requesting_download" | "media_waiting_download"
        )
        && now.duration_since(schedule.attempt_started_at)
            >= Duration::from_secs(u64::from(policy.attempt_timeout_seconds))
    {
        return Some(if schedule.last_attempt < u32::from(policy.max_attempts) {
            MediaControlAction::RetryCurrent
        } else {
            MediaControlAction::Terminate("media_download_timeout")
        });
    }
    if now.duration_since(schedule.last_progress_at)
        >= Duration::from_secs(u64::from(policy.no_progress_timeout_seconds))
    {
        return Some(if schedule.last_attempt < u32::from(policy.max_attempts) {
            MediaControlAction::RetryCurrent
        } else {
            MediaControlAction::Terminate("media_no_progress_timeout")
        });
    }
    None
}

fn media_start_limit_action(
    policy: MediaPolicy,
    total_media_bytes: u64,
    expected_size: Option<u64>,
    available_space: Option<u64>,
) -> Option<MediaControlAction> {
    if total_media_bytes >= policy.max_total_bytes {
        return Some(MediaControlAction::StopQueue("media_total_limit_reached"));
    }
    if expected_size.is_some_and(|value| value > policy.max_asset_bytes) {
        return Some(MediaControlAction::Terminate("media_too_large"));
    }
    let required = MEDIA_SPACE_RESERVE_BYTES.saturating_add(expected_size.unwrap_or(0));
    if available_space.is_some_and(|available| available < required) {
        return Some(MediaControlAction::StopQueue(
            "media_disk_space_insufficient",
        ));
    }
    None
}

fn checked_media_stream_length(current: u64, chunk_length: usize) -> Result<u64, CollectorError> {
    current
        .checked_add(
            u64::try_from(chunk_length)
                .map_err(|_| CollectorError::Protocol("media chunk length overflow".to_owned()))?,
        )
        .filter(|value| *value <= MAX_MEDIA_ASSET_BYTES)
        .ok_or_else(|| {
            CollectorError::Protocol("media stream exceeded the fixed asset limit".to_owned())
        })
}

fn append_media_detection_prefix(prefix: &mut Vec<u8>, chunk: &[u8]) {
    if prefix.len() >= MEDIA_PREFIX_BYTES {
        return;
    }
    let remaining = MEDIA_PREFIX_BYTES - prefix.len();
    prefix.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
}

async fn apply_media_control(
    session: &CdpSession,
    attached_id: &str,
    object_id: &str,
    action: MediaControlAction,
) -> Result<(), CollectorError> {
    let command = match action {
        MediaControlAction::BeginDownload => json!({"action": "begin_download"}),
        MediaControlAction::RetryCurrent => json!({"action": "retry_current"}),
        MediaControlAction::Terminate(reason) => {
            json!({"action": "terminate_current", "reason": reason})
        }
        MediaControlAction::StopQueue(reason) => {
            json!({"action": "stop_media_queue", "reason": reason})
        }
    };
    let value = call_value(
        session,
        attached_id,
        MEDIA_CONTROL_FUNCTION,
        object_id,
        &[json!({"value": command})],
    )
    .await?;
    if value.as_bool() != Some(true) {
        return Err(CollectorError::Protocol(
            "Adapter rejected a fixed media scheduling command".to_owned(),
        ));
    }
    Ok(())
}

async fn cancel_controller(
    session: &CdpSession,
    attached_id: &str,
    object_id: &str,
) -> Result<(), CollectorError> {
    let value = call_value(session, attached_id, CANCEL_FUNCTION, object_id, &[]).await?;
    if value.as_bool() != Some(true) {
        return Err(CollectorError::Protocol(
            "Adapter did not confirm the fixed cancellation command".to_owned(),
        ));
    }
    Ok(())
}

const fn media_terminal_count(media: &crate::normalize::NormalizedMediaCounts) -> u64 {
    media.available
        + media.missing
        + media.expired
        + media.decrypt_error
        + media.download_timeout
        + media.no_progress_timeout
        + media.too_large
        + media.disk_space_insufficient
        + media.hash_mismatch
        + media.transport_interrupted
        + media.canceled
        + media.unavailable
        + media.not_attempted
}

const fn completeness_media_counts(
    media: &crate::normalize::NormalizedMediaCounts,
) -> MediaCountsDto {
    MediaCountsDto {
        requested: media.requested,
        available: media.available,
        full: media.full,
        thumbnail: media.thumbnail,
        missing: media.missing,
        expired: media.expired,
        decrypt_error: media.decrypt_error,
        download_timeout: media.download_timeout,
        no_progress_timeout: media.no_progress_timeout,
        too_large: media.too_large,
        disk_space_insufficient: media.disk_space_insufficient,
        hash_mismatch: media.hash_mismatch,
        transport_interrupted: media.transport_interrupted,
        canceled: media.canceled,
        unavailable: media.unavailable,
        not_attempted: media.not_attempted,
    }
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
        FrameKind::Progress => "progress",
        FrameKind::MediaStart => "media_start",
        FrameKind::MediaEnd => "media_end",
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
        let message = match value.get("code").and_then(Value::as_str) {
            Some("unsupported_build") => {
                "controller stopped because this WhatsApp build or read capability is unsupported"
            }
            Some("account_binding_failed") => {
                "controller stopped because the observed WhatsApp page account changed or became unavailable"
            }
            Some("conversation_discovery_failed") => {
                "controller stopped because conversation discovery failed closed"
            }
            Some("history_initialization_failed") => {
                "controller stopped because read-only history initialization failed closed"
            }
            Some("snapshot_preparation_failed") => {
                "controller stopped because snapshot preparation failed closed"
            }
            Some("protocol_mismatch") => "collector and page controller protocol versions differ",
            Some("unsupported_command") => "collector and page controller command contracts differ",
            Some("crypto_unavailable") => "page controller cryptographic capability is unavailable",
            Some("invalid_state") => "controller rejected the command in its current state",
            _ => "controller rejected fixed command",
        };
        return Err(CollectorError::Protocol(message.to_owned()));
    }
    value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            CollectorError::Protocol("dispatch omitted controller session ID".to_owned())
        })
}

fn successful_start_dispatch(value: &Value) -> Result<(String, [u8; 32]), CollectorError> {
    let session_id = successful_dispatch_session(value)?;
    if value.get("protocol").and_then(Value::as_str) != Some(page_bridge::PROTOCOL)
        || value.as_object().is_none_or(|object| {
            let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
            keys.sort_unstable();
            keys != ["ok", "protocol", "resumeBindingSha256", "sessionId"]
        })
    {
        return Err(CollectorError::Protocol(
            "start dispatch result violated the fixed resume contract".to_owned(),
        ));
    }
    let binding = value
        .get("resumeBindingSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| CollectorError::Protocol("start dispatch omitted resume binding".to_owned()))
        .and_then(decode_account_binding)?;
    Ok((session_id, binding))
}

fn resume_request(
    checkpoint: &AcquisitionCheckpoint,
    normalizer: &Normalizer,
    existing: bool,
) -> Result<Value, CollectorError> {
    let media_totals = if existing {
        serde_json::to_value(normalizer.summary().media).map_err(|_| {
            CollectorError::Checkpoint("recovery media totals could not be encoded".to_owned())
        })?
    } else {
        json!({
            "requested": 0,
            "available": 0,
            "missing": 0,
            "expired": 0,
            "decryptError": 0,
            "downloadTimeout": 0,
            "noProgressTimeout": 0,
            "tooLarge": 0,
            "diskSpaceInsufficient": 0,
            "hashMismatch": 0,
            "transportInterrupted": 0,
            "canceled": 0,
            "unavailable": 0,
            "notAttempted": 0,
        })
    };
    Ok(json!({
        "challengeHex": checkpoint.source_binding.resume_challenge_hex,
        "existing": existing,
        "mediaPlanSha256": if existing {
            checkpoint
                .source_binding
                .media_plan_sha256
                .clone()
                .map_or(Value::Null, Value::String)
        } else {
            Value::Null
        },
        "mediaStartIndex": if existing {
            checkpoint.source_binding.media_start_index
        } else {
            0
        },
        "mediaTotals": media_totals,
    }))
}

fn validate_probe(
    probe: &ProbeResultPayload,
    acquisition_mode: AcquisitionMode,
) -> Result<(), CollectorError> {
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
        comprehensive_readonly_v02,
        accounts,
        contacts,
        chats,
        messages,
        media,
        history_loading,
        network_actions,
        dom_writes,
        ref datasets,
    } = probe.capabilities;
    let base_datasets_supported = [
        DatasetKind::Accounts,
        DatasetKind::Contacts,
        DatasetKind::Chats,
        DatasetKind::Messages,
    ]
    .iter()
    .all(|expected| {
        datasets.iter().any(|item| {
            item.dataset == *expected && matches!(item.result, DatasetCapabilityResult::Supported)
        })
    });
    if !passive_t0
        || !accounts
        || !contacts
        || !chats
        || !messages
        || dom_writes
        || !base_datasets_supported
    {
        return Err(CollectorError::Protocol(
            "injector capability matrix misses the fixed read-only base contract".to_owned(),
        ));
    }
    if acquisition_mode.requests_enrichment()
        && (!comprehensive_readonly_v02 || (!media && !history_loading) || !network_actions)
    {
        let mut reason_codes = Vec::new();
        if !history_loading {
            reason_codes.push("history_loader_signature_mismatch".to_owned());
        }
        if !media {
            reason_codes.push("media_reader_signature_mismatch".to_owned());
        }
        if reason_codes.is_empty() {
            reason_codes.push("unknown_build".to_owned());
        }
        return Err(CollectorError::UnsupportedWhatsAppVersion {
            build: bounded_label(&probe.build, 160),
            reason_codes,
        });
    }
    Ok(())
}

fn validate_stream_start(
    payload: &StreamStartPayload,
    account_binding: &[u8; 32],
    resume_binding: &[u8; 32],
    acquisition_mode: AcquisitionMode,
    resume_existing: bool,
    expected_media_plan_sha256: Option<&str>,
    expected_media_start_index: Option<u64>,
) -> Result<(), CollectorError> {
    let names = payload
        .datasets
        .iter()
        .map(|item| item.dataset)
        .collect::<Vec<_>>();
    let expected_operation = if acquisition_mode.requests_enrichment() {
        OperationKind::ComprehensiveReadonlyV02
    } else {
        OperationKind::T0
    };
    if names != DatasetKind::ALL
        || payload.operation != expected_operation
        || !account_binding_matches(account_binding, &payload.account_binding_sha256)?
        || !account_binding_matches(resume_binding, &payload.resume_binding_sha256)?
        || decode_account_binding(&payload.media_plan_sha256).is_err()
        || (!resume_existing && payload.media_start_index != 0)
        || expected_media_plan_sha256.is_some_and(|expected| expected != payload.media_plan_sha256)
        || expected_media_start_index.is_some_and(|expected| expected != payload.media_start_index)
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
    resume_binding: &[u8; 32],
    stream_start: &StreamStartPayload,
    acquisition_mode: AcquisitionMode,
    media_policy: MediaPolicy,
) -> Result<(), CollectorError> {
    let counts_match = DatasetKind::ALL.iter().all(|dataset| {
        dataset_total(&payload.totals, *dataset)
            == summary
                .record_counts
                .get(dataset.as_str())
                .copied()
                .unwrap_or(0)
    });
    let has_snapshot_omission = payload
        .completeness
        .reasons
        .iter()
        .any(|reason| reason.ends_with("_omitted"));
    let snapshot_consistent = match payload.completeness.local_snapshot {
        page_bridge::LocalSnapshotCompleteness::Verified => !has_snapshot_omission,
        page_bridge::LocalSnapshotCompleteness::Partial => has_snapshot_omission,
        page_bridge::LocalSnapshotCompleteness::Failed => false,
    };
    let base_complete = snapshot_consistent
        && matches!(
            payload.completeness.account_scope,
            page_bridge::AccountCompleteness::Unverifiable
        )
        && account_binding_matches(resume_binding, &payload.resume_binding_sha256)?
        && payload.media_plan_sha256 == stream_start.media_plan_sha256
        && payload.media_start_index == stream_start.media_start_index;
    let media_counts_match = payload.media.requested == summary.media.requested
        && payload.media.available == summary.media.available
        && payload.media.missing == summary.media.missing
        && payload.media.expired == summary.media.expired
        && payload.media.decrypt_error == summary.media.decrypt_error
        && payload.media.download_timeout == summary.media.download_timeout
        && payload.media.no_progress_timeout == summary.media.no_progress_timeout
        && payload.media.too_large == summary.media.too_large
        && payload.media.disk_space_insufficient == summary.media.disk_space_insufficient
        && payload.media.hash_mismatch == summary.media.hash_mismatch
        && payload.media.transport_interrupted == summary.media.transport_interrupted
        && payload.media.canceled == summary.media.canceled
        && payload.media.unavailable == summary.media.unavailable
        && payload.media.not_attempted == summary.media.not_attempted;
    let mode_complete = if acquisition_mode.requests_enrichment() {
        payload.operation == OperationKind::ComprehensiveReadonlyV02
            && !matches!(
                payload.completeness.history_scope,
                page_bridge::HistoryCompleteness::NotRun
            )
            && match media_policy.mode {
                MediaPolicyMode::MetadataOnly => {
                    matches!(
                        payload.completeness.media_scope,
                        page_bridge::MediaCompleteness::NotRequested
                    ) && summary.media.not_attempted == summary.media.requested
                }
                MediaPolicyMode::CachedOnly | MediaPolicyMode::NetworkBestEffort => matches!(
                    payload.completeness.media_scope,
                    page_bridge::MediaCompleteness::Complete
                        | page_bridge::MediaCompleteness::Partial
                ),
            }
            && media_counts_match
    } else {
        payload.operation == OperationKind::T0
            && matches!(
                payload.completeness.history_scope,
                page_bridge::HistoryCompleteness::NotRun
            )
            && matches!(
                payload.completeness.media_scope,
                page_bridge::MediaCompleteness::NotRequested
            )
            && summary.media.not_attempted == summary.media.requested
            && media_counts_match
    };
    if payload.totals.accounts != 1
        || summary.record_counts.get("accounts").copied() != Some(1)
        || !account_binding_matches(account_binding, &payload.account_binding_sha256)?
        || !counts_match
        || !base_complete
        || !mode_complete
        || summary.pending_media_count != 0
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

const fn dataset_total(totals: &page_bridge::DatasetTotalsPayload, dataset: DatasetKind) -> u64 {
    match dataset {
        DatasetKind::Accounts => totals.accounts,
        DatasetKind::Contacts => totals.contacts,
        DatasetKind::Chats => totals.chats,
        DatasetKind::ChatLists => totals.chat_lists,
        DatasetKind::Participants => totals.participants,
        DatasetKind::Messages => totals.messages,
        DatasetKind::MessageEvents => totals.message_events,
        DatasetKind::Reactions => totals.reactions,
        DatasetKind::Receipts => totals.receipts,
        DatasetKind::PollVotes => totals.poll_votes,
        DatasetKind::GroupEvents => totals.group_events,
        DatasetKind::Statuses => totals.statuses,
        DatasetKind::Calls => totals.calls,
        DatasetKind::Channels => totals.channels,
        DatasetKind::ChannelEvents => totals.channel_events,
        DatasetKind::Communities => totals.communities,
        DatasetKind::CommunityRelations => totals.community_relations,
        DatasetKind::PresenceSnapshots => totals.presence_snapshots,
    }
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
        _ => payload.account_binding_sha256.is_none(),
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
    if DatasetKind::ALL
        .iter()
        .any(|dataset| observed(*dataset) != Some(dataset_total(&end.totals, *dataset)))
        || end.totals.accounts != 1
        || start.observed_at != end.observed_at
        || start.resume_binding_sha256 != end.resume_binding_sha256
        || start.media_plan_sha256 != end.media_plan_sha256
        || start.media_start_index != end.media_start_index
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
    let expected = DatasetKind::ALL.iter().find_map(|kind| {
        let observed = observed_records(start, *kind)?;
        let accepted = summary
            .record_counts
            .get(kind.as_str())
            .copied()
            .unwrap_or(0);
        (accepted < observed).then_some((*kind, observed, accepted))
    });
    let Some((expected_kind, observed, accepted)) = expected else {
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

fn validate_structured_counts(
    start: &StreamStartPayload,
    summary: &NormalizationSummary,
) -> Result<(), CollectorError> {
    if DatasetKind::ALL.iter().all(|dataset| {
        observed_records(start, *dataset)
            == Some(
                summary
                    .record_counts
                    .get(dataset.as_str())
                    .copied()
                    .unwrap_or(0),
            )
    }) {
        Ok(())
    } else {
        Err(CollectorError::Protocol(
            "structured snapshot ended before all declared records were committed".to_owned(),
        ))
    }
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
    let mut capabilities = probe
        .capabilities
        .datasets
        .iter()
        .map(|value| CapabilityDto {
            name: value.dataset.as_str().to_owned(),
            result: dataset_capability_result_label(value.result).to_owned(),
            adapter: matches!(
                value.result,
                DatasetCapabilityResult::Supported | DatasetCapabilityResult::Degraded
            )
            .then(|| adapter.clone())
            .flatten(),
            reason_codes: value.reason_codes.clone(),
        })
        .collect::<Vec<_>>();
    capabilities.push(CapabilityDto {
        name: "media".to_owned(),
        result: if probe.capabilities.media {
            "supported".to_owned()
        } else {
            "unsupported".to_owned()
        },
        adapter: probe.capabilities.media.then(|| adapter.clone()).flatten(),
        reason_codes: if probe.capabilities.media {
            Vec::new()
        } else {
            vec!["media_reader_unavailable".to_owned()]
        },
    });
    debug_assert_eq!(capabilities.len(), CAPABILITY_NAMES.len());
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
    probe: &ProbeResultPayload,
    window: &ObservationWindowDto,
) -> Vec<DatasetDisposition> {
    DATASETS
        .iter()
        .map(|dataset| {
            let observed = probe
                .capabilities
                .datasets
                .iter()
                .find(|value| value.dataset.as_str() == dataset.name);
            let count = summary
                .record_counts
                .get(dataset.name)
                .copied()
                .unwrap_or(0);
            match observed.map(|value| value.result) {
                Some(DatasetCapabilityResult::Supported) => DatasetDisposition {
                    capability: DatasetCapability::Supported,
                    request_state: RequestState::Requested,
                    result: if count == 0 {
                        DatasetResult::Empty
                    } else {
                        DatasetResult::CompleteAsObserved
                    },
                    observation_window: Some(window.clone()),
                    reason_codes: Vec::new(),
                },
                Some(DatasetCapabilityResult::Degraded) => DatasetDisposition {
                    capability: DatasetCapability::Supported,
                    request_state: RequestState::Requested,
                    result: DatasetResult::Partial,
                    observation_window: Some(window.clone()),
                    reason_codes: observed.map_or_else(
                        || vec!["reader_error".to_owned()],
                        |value| value.reason_codes.clone(),
                    ),
                },
                Some(DatasetCapabilityResult::Unsupported) => DatasetDisposition {
                    capability: DatasetCapability::Unsupported,
                    request_state: RequestState::Requested,
                    result: DatasetResult::Unsupported,
                    observation_window: None,
                    reason_codes: observed.map_or_else(
                        || vec!["optional_collection_unavailable".to_owned()],
                        |value| value.reason_codes.clone(),
                    ),
                },
                Some(DatasetCapabilityResult::Error) | None => DatasetDisposition {
                    capability: DatasetCapability::Unknown,
                    request_state: RequestState::Requested,
                    result: DatasetResult::Failed,
                    observation_window: None,
                    reason_codes: observed.map_or_else(
                        || vec!["reader_error".to_owned()],
                        |value| value.reason_codes.clone(),
                    ),
                },
            }
        })
        .collect()
}

const fn dataset_capability_result_label(result: DatasetCapabilityResult) -> &'static str {
    match result {
        DatasetCapabilityResult::Supported => "supported",
        DatasetCapabilityResult::Degraded => "degraded",
        DatasetCapabilityResult::Unsupported => "unsupported",
        DatasetCapabilityResult::Error => "error",
    }
}

const fn local_snapshot_label(value: page_bridge::LocalSnapshotCompleteness) -> &'static str {
    match value {
        page_bridge::LocalSnapshotCompleteness::Verified => "verified",
        page_bridge::LocalSnapshotCompleteness::Partial => "partial",
        page_bridge::LocalSnapshotCompleteness::Failed => "failed",
    }
}

const fn history_scope_label(value: page_bridge::HistoryCompleteness) -> &'static str {
    match value {
        page_bridge::HistoryCompleteness::TerminalObserved => "terminal_observed",
        page_bridge::HistoryCompleteness::StableNoGrowth => "stable_no_growth",
        page_bridge::HistoryCompleteness::LimitReached => "limit_reached",
        page_bridge::HistoryCompleteness::LoaderError => "loader_error",
        page_bridge::HistoryCompleteness::NotRun => "not_run",
    }
}

const fn media_scope_label(value: page_bridge::MediaCompleteness) -> &'static str {
    match value {
        page_bridge::MediaCompleteness::Complete => "complete",
        page_bridge::MediaCompleteness::Partial => "partial",
        page_bridge::MediaCompleteness::NotRequested => "not_requested",
    }
}

fn completeness_overall(outcome: &SessionOutcome) -> &'static str {
    let all_datasets_supported = outcome
        .probe
        .capabilities
        .datasets
        .iter()
        .all(|value| value.result == DatasetCapabilityResult::Supported);
    if all_datasets_supported
        && matches!(
            outcome.stream_end.completeness.local_snapshot,
            page_bridge::LocalSnapshotCompleteness::Verified
        )
        && matches!(
            outcome.stream_end.completeness.history_scope,
            page_bridge::HistoryCompleteness::TerminalObserved
        )
        && matches!(
            outcome.stream_end.completeness.media_scope,
            page_bridge::MediaCompleteness::Complete
        )
        && outcome.normalization.unresolved_reference_count == 0
    {
        "complete_as_observed"
    } else {
        "partial"
    }
}

fn completeness_reason_codes(
    outcome: &SessionOutcome,
    acquisition_mode: AcquisitionMode,
) -> Vec<String> {
    let mut reasons = outcome.stream_end.completeness.reasons.clone();
    reasons.push("account_scope_unverifiable".to_owned());
    if acquisition_mode.requests_enrichment() {
        reasons.push("store_only_no_ui_fallback".to_owned());
    } else {
        reasons.extend([
            "passive_t0_only".to_owned(),
            "history_not_run".to_owned(),
            "media_not_requested".to_owned(),
        ]);
    }
    match outcome.stream_end.completeness.history_scope {
        page_bridge::HistoryCompleteness::StableNoGrowth => {
            reasons.push("history_stable_no_growth".to_owned());
        }
        page_bridge::HistoryCompleteness::LimitReached => {
            reasons.push("history_limit_reached".to_owned());
        }
        page_bridge::HistoryCompleteness::LoaderError => {
            reasons.push("history_loader_error".to_owned());
        }
        page_bridge::HistoryCompleteness::TerminalObserved
        | page_bridge::HistoryCompleteness::NotRun => {}
    }
    if matches!(
        outcome.stream_end.completeness.media_scope,
        page_bridge::MediaCompleteness::Partial
    ) {
        reasons.push("media_partial".to_owned());
    }
    if outcome.normalization.unresolved_reference_count > 0 {
        reasons.push("normalized_references_unresolved".to_owned());
    }
    if outcome
        .probe
        .capabilities
        .datasets
        .iter()
        .any(|value| value.result == DatasetCapabilityResult::Degraded)
    {
        reasons.push("one_or_more_datasets_degraded".to_owned());
    }
    if outcome
        .probe
        .capabilities
        .datasets
        .iter()
        .any(|value| value.result == DatasetCapabilityResult::Unsupported)
    {
        reasons.push("one_or_more_datasets_unsupported".to_owned());
    }
    reasons.sort();
    reasons.dedup();
    reasons
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
    let monotonic = audit
        .monotonic_base_ns
        .saturating_add(u64::try_from(elapsed).unwrap_or(u64::MAX));
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
    if !valid_media_policy(request.acquisition_mode, request.media_policy) {
        return Err(CollectorError::Preflight(
            "signed assignment media policy is invalid".to_owned(),
        ));
    }
    if request
        .resume_evidence_id
        .is_some_and(|value| value.is_nil())
        || (request.resume_evidence_id.is_some() && !request.acquisition_mode.requests_enrichment())
    {
        return Err(CollectorError::Preflight(
            "only comprehensive read-only tasks can resume a non-nil evidence identity".to_owned(),
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

fn valid_media_policy(acquisition_mode: AcquisitionMode, policy: MediaPolicy) -> bool {
    (acquisition_mode.requests_enrichment() || matches!(policy.mode, MediaPolicyMode::MetadataOnly))
        && (1..=MAX_MEDIA_ASSET_BYTES).contains(&policy.max_asset_bytes)
        && policy.max_total_bytes >= policy.max_asset_bytes
        && policy.max_total_bytes <= 32 * 1024 * 1024 * 1024 * 1024
        && (1..=300).contains(&policy.cache_lookup_timeout_seconds)
        && (5..=3_600).contains(&policy.no_progress_timeout_seconds)
        && (5..=7_200).contains(&policy.attempt_timeout_seconds)
        && policy.max_asset_duration_seconds >= policy.attempt_timeout_seconds
        && policy.max_asset_duration_seconds <= 86_400
        && (1..=5).contains(&policy.max_attempts)
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
        Some(context.browser_page_ready_at_utc.as_str()),
        Some(context.extension_paired_at_utc.as_str()),
        context.browser_opened_at_utc.as_deref(),
    ]
    .into_iter()
    .flatten()
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
        || !matches!(
            context.browser_page_preparation.as_str(),
            "collector_requested_open" | "operator_confirmed_already_open"
        )
        || (context.browser_page_preparation == "collector_requested_open"
            && context.browser_opened_at_utc.is_none())
        || (context.browser_page_preparation == "operator_confirmed_already_open"
            && context.browser_opened_at_utc.is_some())
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

fn original_profile_impacts(context: &ExistingProfileContext) -> Vec<&'static str> {
    vec![
        if context.browser_page_preparation == "collector_requested_open" {
            "original_profile_open_requested_by_collector"
        } else {
            "original_profile_already_open_operator_confirmed"
        },
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
    completeness: AcquisitionCompletenessSummary,
    lifecycle_state: AcquisitionState,
    checkpoint_cleanup: CheckpointCleanup,
) -> AcquisitionResult {
    AcquisitionResult {
        evidence_bag_path: sealed.path.clone(),
        evidence_id: sealed.evidence_id,
        source_id,
        manifest_root_sha256: sealed.manifest_root_sha256.clone(),
        signer_fingerprint: sealed.signer_fingerprint.clone(),
        record_counts: normalization.record_counts,
        unresolved_reference_count: normalization.unresolved_reference_count,
        completeness,
        lifecycle_state,
        sealed_bag: Some(sealed),
        checkpoint_cleanup: Some(checkpoint_cleanup),
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

    #[test]
    fn completeness_keeps_available_avatars_out_of_full_attachment_count() {
        let observed = crate::normalize::NormalizedMediaCounts {
            requested: 11,
            available: 5,
            full: 3,
            no_progress_timeout: 3,
            unavailable: 3,
            ..Default::default()
        };
        let declared = completeness_media_counts(&observed);
        assert_eq!(declared.available, 5);
        assert_eq!(declared.full, 3);
        assert_eq!(declared.thumbnail, 0);
        assert_eq!(declared.no_progress_timeout, 3);
        assert_eq!(declared.unavailable, 3);
    }

    fn synthetic_stream_end(local_snapshot: &str, reasons: &[&str]) -> StreamEndPayload {
        let parsed = serde_json::from_value(json!({
            "operation": "comprehensive_readonly_v02",
            "observedAt": "2026-08-09T00:00:00.000Z",
            "completedAt": "2026-08-09T00:00:01.000Z",
            "accountBindingSha256": "aa".repeat(32),
            "resumeBindingSha256": "bb".repeat(32),
            "mediaPlanSha256": "cc".repeat(32),
            "mediaStartIndex": 0,
            "totals": {
                "accounts": 1,
                "contacts": 0,
                "chats": 0,
                "chatLists": 0,
                "participants": 0,
                "messages": 0,
                "messageEvents": 0,
                "reactions": 0,
                "receipts": 0,
                "pollVotes": 0,
                "groupEvents": 0,
                "statuses": 0,
                "calls": 0,
                "channels": 0,
                "channelEvents": 0,
                "communities": 0,
                "communityRelations": 0,
                "presenceSnapshots": 0
            },
            "media": {
                "requested": 0,
                "available": 0,
                "missing": 0,
                "expired": 0,
                "decryptError": 0,
                "downloadTimeout": 0,
                "noProgressTimeout": 0,
                "tooLarge": 0,
                "diskSpaceInsufficient": 0,
                "hashMismatch": 0,
                "transportInterrupted": 0,
                "canceled": 0,
                "unavailable": 0,
                "notAttempted": 0
            },
            "completeness": {
                "localSnapshot": local_snapshot,
                "historyScope": "stable_no_growth",
                "mediaScope": "complete",
                "accountScope": "unverifiable",
                "reasons": reasons
            }
        }));
        match parsed {
            Ok(value) => value,
            Err(error) => panic!("synthetic stream_end did not parse: {error}"),
        }
    }

    fn synthetic_stream_start() -> StreamStartPayload {
        serde_json::from_value(json!({
            "operation": "comprehensive_readonly_v02",
            "observedAt": "2026-08-09T00:00:00.000Z",
            "accountBindingSha256": "aa".repeat(32),
            "resumeBindingSha256": "bb".repeat(32),
            "mediaPlanSha256": "cc".repeat(32),
            "mediaStartIndex": 0,
            "datasets": DatasetKind::ALL.map(|dataset| json!({
                "dataset": dataset,
                "observedRecords": u64::from(dataset == DatasetKind::Accounts),
            }))
        }))
        .unwrap_or_else(|error| panic!("synthetic stream_start did not parse: {error}"))
    }

    #[test]
    fn host_accepts_honest_partial_snapshots_but_not_failed_or_unjustified_ones() {
        let mut summary = NormalizationSummary::default();
        summary.record_counts.insert("accounts".to_owned(), 1);
        let binding = [0xaa; 32];
        let resume_binding = [0xbb; 32];
        let stream_start = synthetic_stream_start();
        let reasons = vec![
            "account_scope_unverifiable",
            "store_only_no_ui_fallback",
            "message_native_id_unavailable_omitted",
        ];

        let partial = synthetic_stream_end("partial", &reasons);
        assert!(
            validate_stream_end(
                &partial,
                &summary,
                &binding,
                &resume_binding,
                &stream_start,
                AcquisitionMode::ComprehensiveReadonlyV02,
                MediaPolicy::for_acquisition_mode(AcquisitionMode::ComprehensiveReadonlyV02),
            )
            .is_ok()
        );

        let failed = synthetic_stream_end("failed", &reasons);
        assert!(
            validate_stream_end(
                &failed,
                &summary,
                &binding,
                &resume_binding,
                &stream_start,
                AcquisitionMode::ComprehensiveReadonlyV02,
                MediaPolicy::for_acquisition_mode(AcquisitionMode::ComprehensiveReadonlyV02),
            )
            .is_err()
        );

        let unjustified = synthetic_stream_end(
            "partial",
            &["account_scope_unverifiable", "store_only_no_ui_fallback"],
        );
        assert!(
            validate_stream_end(
                &unjustified,
                &summary,
                &binding,
                &resume_binding,
                &stream_start,
                AcquisitionMode::ComprehensiveReadonlyV02,
                MediaPolicy::for_acquisition_mode(AcquisitionMode::ComprehensiveReadonlyV02),
            )
            .is_err()
        );
    }

    #[test]
    fn dispatch_rejections_use_only_fixed_allowlisted_diagnostics() {
        let known = successful_dispatch_session(&json!({
            "ok": false,
            "code": "history_initialization_failed",
        }));
        assert!(matches!(
            known,
            Err(CollectorError::Protocol(message))
                if message == "controller stopped because read-only history initialization failed closed"
        ));

        let mismatch = successful_dispatch_session(&json!({
            "ok": false,
            "code": "protocol_mismatch",
        }));
        assert!(matches!(
            mismatch,
            Err(CollectorError::Protocol(message))
                if message == "collector and page controller protocol versions differ"
        ));

        let hostile_marker = "15551234567@c.us SYNTHETIC-CHAT-CONTENT";
        let unknown = successful_dispatch_session(&json!({
            "ok": false,
            "code": hostile_marker,
            "message": hostile_marker,
        }));
        assert!(matches!(
            unknown,
            Err(CollectorError::Protocol(message))
                if message == "controller rejected fixed command"
                    && !message.contains(hostile_marker)
        ));
    }

    fn supported_probe() -> ProbeResultPayload {
        ProbeResultPayload {
            protocol: page_bridge::PROTOCOL.to_owned(),
            controller_version: page_bridge::CONTROLLER_VERSION.to_owned(),
            supported: true,
            adapter_id: Some("wa-private-collections-v2".to_owned()),
            build: "test".to_owned(),
            account_binding_sha256: Some("a".repeat(64)),
            reasons: Vec::new(),
            capabilities: CapabilityPayload {
                passive_t0: true,
                comprehensive_readonly_v02: true,
                accounts: true,
                contacts: true,
                chats: true,
                messages: true,
                media: true,
                history_loading: true,
                network_actions: true,
                dom_writes: false,
                datasets: DatasetKind::ALL
                    .into_iter()
                    .map(|dataset| page_bridge::DatasetCapabilityPayload {
                        dataset,
                        result: DatasetCapabilityResult::Supported,
                        reason_codes: Vec::new(),
                    })
                    .collect(),
            },
        }
    }

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
            acquisition_mode: AcquisitionMode::PassiveT0,
            media_policy: MediaPolicy::for_acquisition_mode(AcquisitionMode::PassiveT0),
            operator_consent: true,
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
            resume_evidence_id: None,
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
        let dispositions = dataset_dispositions(&summary, &supported_probe(), &window);
        assert_eq!(dispositions.len(), 18);
        assert!(matches!(
            dispositions[0].result,
            DatasetResult::CompleteAsObserved
        ));
        assert!(matches!(dispositions[4].result, DatasetResult::Empty));
    }

    #[test]
    fn unsupported_capabilities_never_claim_an_adapter() {
        let mut probe = supported_probe();
        probe.capabilities.media = false;
        probe.capabilities.datasets[4].result = DatasetCapabilityResult::Unsupported;
        probe.capabilities.datasets[4].reason_codes =
            vec!["optional_collection_unavailable".to_owned()];
        let dto = capabilities_dto(Uuid::new_v4(), &probe, "2026-08-08T00:00:00.000Z");
        assert_eq!(dto.capabilities.len(), 19);
        assert!(dto.capabilities[0].adapter.is_some());
        assert!(dto.capabilities[4].adapter.is_none());
    }

    #[test]
    fn comprehensive_mode_keeps_the_observable_enrichment_dimension() {
        let mut history_only = supported_probe();
        history_only.capabilities.media = false;
        assert!(validate_probe(&history_only, AcquisitionMode::ComprehensiveReadonlyV02).is_ok());

        let mut media_only = supported_probe();
        media_only.capabilities.history_loading = false;
        assert!(validate_probe(&media_only, AcquisitionMode::ComprehensiveReadonlyV02).is_ok());

        let mut neither = supported_probe();
        neither.capabilities.media = false;
        neither.capabilities.history_loading = false;
        neither.capabilities.comprehensive_readonly_v02 = false;
        neither.capabilities.network_actions = false;
        assert!(validate_probe(&neither, AcquisitionMode::ComprehensiveReadonlyV02).is_err());
    }

    #[test]
    fn rust_scheduler_owns_cache_miss_retry_and_terminal_timeout_decisions()
    -> Result<(), &'static str> {
        let attempt_started_at = Instant::now();
        let now = attempt_started_at
            .checked_add(Duration::from_secs(601))
            .ok_or("test instant must permit a short addition")?;
        let policy = MediaPolicy::for_acquisition_mode(AcquisitionMode::ComprehensiveReadonlyV02);
        let mut schedule = MediaScheduleState {
            started_at: now,
            last_progress_at: now,
            attempt_started_at,
            last_status_code: "media_cache_miss".to_owned(),
            last_attempt: 0,
            last_bytes: 0,
            media_index: 1,
            media_total: 2,
        };
        let mut payload = ProgressPayload {
            phase: "media".to_owned(),
            completed: 0,
            total: 2,
            status_code: "media_cache_miss".to_owned(),
            media_index: Some(1),
            media_total: Some(2),
            retry_after_ms: Some(1_000),
            attempt: Some(0),
            bytes_observed: Some(0),
            elapsed_ms: Some(1),
        };
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, now),
            Some(MediaControlAction::BeginDownload)
        );

        schedule.last_attempt = 1;
        schedule.last_status_code = "media_waiting_download".to_owned();
        payload.status_code = "media_waiting_download".to_owned();
        payload.attempt = Some(1);
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, now),
            Some(MediaControlAction::RetryCurrent)
        );

        schedule.last_attempt = u32::from(policy.max_attempts);
        payload.attempt = Some(u32::from(policy.max_attempts));
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, now),
            Some(MediaControlAction::Terminate("media_download_timeout"))
        );
        Ok(())
    }

    #[test]
    fn media_stream_accounting_exceeds_one_gib_without_buffering_the_asset()
    -> Result<(), CollectorError> {
        const CHUNK_BYTES: usize = 192 * 1024;
        const ONE_GIB: u64 = 1024 * 1024 * 1024;
        let chunk = vec![0x5a; CHUNK_BYTES];
        let mut byte_length = 0_u64;
        let mut detection_prefix = Vec::with_capacity(MEDIA_PREFIX_BYTES);

        while byte_length <= ONE_GIB {
            byte_length = checked_media_stream_length(byte_length, chunk.len())?;
            append_media_detection_prefix(&mut detection_prefix, &chunk);
        }

        assert!(byte_length > ONE_GIB);
        assert_eq!(detection_prefix.len(), MEDIA_PREFIX_BYTES);
        assert_eq!(detection_prefix.capacity(), MEDIA_PREFIX_BYTES);
        assert_eq!(detection_prefix, vec![0x5a; MEDIA_PREFIX_BYTES]);
        assert!(checked_media_stream_length(MAX_MEDIA_ASSET_BYTES, 1).is_err());
        Ok(())
    }

    #[test]
    fn scheduler_distinguishes_slow_progress_from_stall_and_overall_timeout()
    -> Result<(), &'static str> {
        let origin = Instant::now();
        let policy = MediaPolicy::for_acquisition_mode(AcquisitionMode::ComprehensiveReadonlyV02);
        let mut schedule = MediaScheduleState {
            started_at: origin,
            last_progress_at: origin,
            attempt_started_at: origin,
            last_status_code: "media_waiting_download".to_owned(),
            last_attempt: 1,
            last_bytes: 0,
            media_index: 1,
            media_total: 1,
        };
        let payload = ProgressPayload {
            phase: "media".to_owned(),
            completed: 0,
            total: 1,
            status_code: "media_waiting_download".to_owned(),
            media_index: Some(1),
            media_total: Some(1),
            retry_after_ms: Some(1_000),
            attempt: Some(1),
            bytes_observed: Some(0),
            elapsed_ms: Some(1),
        };

        let after_forty_seconds = origin
            .checked_add(Duration::from_secs(40))
            .ok_or("test instant must permit forty seconds")?;
        schedule.last_progress_at = after_forty_seconds;
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, after_forty_seconds),
            None
        );

        let after_five_minutes = origin
            .checked_add(Duration::from_secs(300))
            .ok_or("test instant must permit five minutes")?;
        schedule.last_progress_at = after_five_minutes;
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, after_five_minutes),
            None
        );

        let stalled = after_five_minutes
            .checked_add(Duration::from_secs(u64::from(
                policy.no_progress_timeout_seconds,
            )))
            .ok_or("test instant must permit the no-progress timeout")?;
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, stalled),
            Some(MediaControlAction::RetryCurrent)
        );

        schedule.last_attempt = u32::from(policy.max_attempts);
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, stalled),
            Some(MediaControlAction::Terminate("media_no_progress_timeout"))
        );

        let overall_timeout = origin
            .checked_add(Duration::from_secs(u64::from(
                policy.max_asset_duration_seconds,
            )))
            .ok_or("test instant must permit the overall timeout")?;
        schedule.last_progress_at = overall_timeout;
        assert_eq!(
            media_policy_action(policy, &schedule, &payload, overall_timeout),
            Some(MediaControlAction::Terminate("media_download_timeout"))
        );
        Ok(())
    }

    #[test]
    fn media_start_limits_fail_closed_before_any_asset_bytes_are_written() {
        let policy = MediaPolicy::for_acquisition_mode(AcquisitionMode::ComprehensiveReadonlyV02);
        assert_eq!(
            media_start_limit_action(policy, policy.max_total_bytes, Some(1), Some(u64::MAX)),
            Some(MediaControlAction::StopQueue("media_total_limit_reached"))
        );
        assert_eq!(
            media_start_limit_action(
                policy,
                0,
                Some(policy.max_asset_bytes + 1),
                Some(MEDIA_SPACE_RESERVE_BYTES),
            ),
            Some(MediaControlAction::Terminate("media_too_large"))
        );
        assert_eq!(
            media_start_limit_action(
                policy,
                0,
                Some(1024),
                Some(MEDIA_SPACE_RESERVE_BYTES + 1023),
            ),
            Some(MediaControlAction::StopQueue(
                "media_disk_space_insufficient"
            ))
        );
        assert_eq!(
            media_start_limit_action(
                policy,
                0,
                None,
                Some(MEDIA_SPACE_RESERVE_BYTES.saturating_sub(1)),
            ),
            Some(MediaControlAction::StopQueue(
                "media_disk_space_insufficient"
            ))
        );
        assert_eq!(
            media_start_limit_action(
                policy,
                0,
                Some(1024),
                Some(MEDIA_SPACE_RESERVE_BYTES + 1024),
            ),
            None
        );
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

    #[test]
    fn cancellation_handle_is_shared_and_idempotent() {
        let cancellation = AcquisitionCancellation::new();
        let worker_view = cancellation.clone();
        assert!(!cancellation.is_cancelled());
        worker_view.cancel();
        worker_view.cancel();
        assert!(cancellation.is_cancelled());
    }
}
