#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Immutable mapping for one normalized dataset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DatasetSpec {
    /// Stable dataset name.
    pub name: &'static str,
    /// Package-relative NDJSON path.
    pub path: &'static str,
    /// Record type required in the envelope.
    pub record_type: &'static str,
}

impl DatasetSpec {
    /// Creates a compile-time dataset mapping.
    #[must_use]
    pub const fn new(name: &'static str, path: &'static str, record_type: &'static str) -> Self {
        Self {
            name,
            path,
            record_type,
        }
    }
}

/// Acquisition component identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentDto {
    pub name: String,
    pub version: String,
    pub sha256: String,
}

/// Operating-system metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OsDto {
    pub family: String,
    pub version: String,
    pub architecture: String,
}

/// Browser metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserDto {
    pub family: String,
    pub version: String,
    pub profile_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_reference_sha256: Option<String>,
    pub debug_transport: String,
}

/// Captured runtime environment.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentDto {
    pub os: OsDto,
    pub browser: BrowserDto,
    pub whatsapp_build: String,
    pub locale: String,
    pub time_zone: String,
}

/// Operator metadata (not a cryptographic identity claim).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorDto {
    pub operator_id: String,
    pub display_name: Option<String>,
}

/// Recorded authorization confirmation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationDto {
    pub reference: String,
    pub confirmed_at_utc: String,
}

/// Inclusive observation window.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationWindowDto {
    pub started_at_utc: String,
    pub ended_at_utc: String,
}

/// Acquisition mode switches.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquisitionModeDto {
    pub baseline: bool,
    pub enrichment_requested: bool,
    pub ui_fallback_allowed: bool,
}

/// Final acquisition-log binding.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquisitionLogDto {
    pub path: String,
    pub event_count: u64,
    pub terminal_event_hash: String,
}

/// Privacy declaration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyDto {
    pub normalized_whitelist: bool,
    pub omitted_field_classes: Vec<String>,
    pub restricted_raw_included: bool,
}

/// Acquisition metadata written to `data/acquisition.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquisitionDto {
    pub schema_version: String,
    pub wa_evidence_bag_version: String,
    pub evidence_id: Uuid,
    pub acquisition_id: Uuid,
    pub source_id: Uuid,
    pub synthetic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixture: Option<Value>,
    pub collector: ComponentDto,
    pub injector: ComponentDto,
    pub adapter: ComponentDto,
    pub environment: EnvironmentDto,
    pub operator: OperatorDto,
    pub authorization: AuthorizationDto,
    pub portable_configuration: PortableConfigurationDto,
    pub observation_window: ObservationWindowDto,
    pub acquisition_mode: AcquisitionModeDto,
    pub log: AcquisitionLogDto,
    pub privacy: PrivacyDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Value>,
}

/// Workstation-provisioned task/configuration summary. No full public key or
/// private material is permitted here.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableConfigurationDto {
    /// Workstation-created portable bundle identity.
    pub bundle_id: Uuid,
    /// SHA-256 of the complete signed bundle manifest.
    pub bundle_manifest_sha256: String,
    /// Selected signed task identifier.
    pub assignment_id: String,
    /// SHA-256 of the complete signed assignment document.
    pub assignment_sha256: String,
    /// Trusted Workstation configuration-signing key fingerprint.
    pub workstation_key_fingerprint_sha256: String,
}

/// Dataset capability classification.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetCapability {
    Supported,
    Unsupported,
    Unknown,
}

/// Whether collection was requested.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestState {
    Requested,
    NotRequested,
}

/// Observed dataset result.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetResult {
    NotRequested,
    Unsupported,
    Empty,
    CompleteAsObserved,
    Partial,
    Failed,
}

/// Caller-supplied semantic state; byte and record counts come from the writer.
#[derive(Clone, Debug)]
pub struct DatasetDisposition {
    pub capability: DatasetCapability,
    pub request_state: RequestState,
    pub result: DatasetResult,
    pub observation_window: Option<ObservationWindowDto>,
    pub reason_codes: Vec<String>,
}

/// One generated dataset inventory row.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetInventoryItemDto {
    pub name: String,
    pub path: String,
    pub record_type: String,
    pub capability: DatasetCapability,
    pub request_state: RequestState,
    pub result: DatasetResult,
    pub record_count: u64,
    pub byte_length: u64,
    pub observation_window: Option<ObservationWindowDto>,
    pub reason_codes: Vec<String>,
}

/// Dataset inventory root DTO.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetInventoryDto {
    pub schema_version: String,
    pub source_id: Uuid,
    pub generated_at_utc: String,
    pub datasets: Vec<DatasetInventoryItemDto>,
}

/// Media completeness counters.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaCountsDto {
    pub requested: u64,
    pub available: u64,
    pub full: u64,
    pub thumbnail: u64,
    pub missing: u64,
    pub expired: u64,
    pub decrypt_error: u64,
    pub download_timeout: u64,
    pub no_progress_timeout: u64,
    pub too_large: u64,
    pub disk_space_insufficient: u64,
    pub hash_mismatch: u64,
    pub transport_interrupted: u64,
    pub canceled: u64,
    pub unavailable: u64,
    pub not_attempted: u64,
}

/// Deterministic cross-check results.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossChecksDto {
    pub inventory_counts_match: bool,
    pub media_index_matches_cas: bool,
    pub normalized_refs_resolved: bool,
    pub differences: Vec<String>,
}

/// Acquisition completeness root DTO.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletenessDto {
    pub schema_version: String,
    pub source_id: Uuid,
    pub evaluated_at_utc: String,
    pub overall: String,
    pub local_snapshot: String,
    pub history_scope: String,
    pub media_scope: String,
    pub account_scope: String,
    pub dataset_inventory_path: String,
    pub chat_completeness_path: String,
    pub media_counts: MediaCountsDto,
    pub cross_checks: CrossChecksDto,
    pub reason_codes: Vec<String>,
}

/// Capability probe row.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDto {
    pub name: String,
    pub result: String,
    pub adapter: Option<String>,
    pub reason_codes: Vec<String>,
}

/// Capability probe root DTO.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitiesDto {
    pub schema_version: String,
    pub source_id: Uuid,
    pub probed_at_utc: String,
    pub whatsapp_build: String,
    pub capabilities: Vec<CapabilityDto>,
}

/// Permitted raw capture phase.
#[derive(Clone, Copy, Debug)]
pub enum RawPhase {
    Baseline,
    Enriched,
}

impl RawPhase {
    pub(crate) const fn path(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Enriched => "enriched",
        }
    }
}

/// Permitted raw provider directory.
#[derive(Clone, Copy, Debug)]
pub enum RawProvider {
    Store,
    IndexedDb,
    Dom,
    Status,
    Calls,
    Channels,
    Communities,
}

impl RawProvider {
    pub(crate) const fn path(self) -> &'static str {
        match self {
            Self::Store => "store",
            Self::IndexedDb => "indexeddb",
            Self::Dom => "dom",
            Self::Status => "status",
            Self::Calls => "calls",
            Self::Channels => "channels",
            Self::Communities => "communities",
        }
    }
}

/// Permitted raw logical stream file.
#[derive(Clone, Copy, Debug)]
pub enum RawStream {
    Accounts,
    Contacts,
    Chats,
    Messages,
    Entities,
    Events,
    Metadata,
}

impl RawStream {
    pub(crate) const fn path(self) -> &'static str {
        match self {
            Self::Accounts => "accounts.ndjson",
            Self::Contacts => "contacts.ndjson",
            Self::Chats => "chats.ndjson",
            Self::Messages => "messages.ndjson",
            Self::Entities => "entities.ndjson",
            Self::Events => "events.ndjson",
            Self::Metadata => "metadata.ndjson",
        }
    }
}

/// Acquisition log event kind.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogEventType {
    AcquisitionStarted,
    AcquisitionResumed,
    CapabilityProbeCompleted,
    PhaseStarted,
    DatasetCompleted,
    MediaAttempt,
    CheckpointWritten,
    Warning,
    AcquisitionCompleted,
}
