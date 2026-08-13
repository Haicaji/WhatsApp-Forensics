//! Deterministic conversion from the strict page whitelist to WAEB v1 envelopes.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{SecondsFormat, Utc};
use page_bridge::{DatasetKind, HistoryCompleteness, MediaEndPayload, MediaStartPayload};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use waeb_writer::{
    MediaAsset, RawPhase, RawProvider, RawStream, SCHEMA_VERSION, WaebError, WaebWriter,
    canonicalize, sha256_hex,
};

mod reference_rules;

use reference_rules::{actor_record_type, recipient_record_type};

const OMITTED_FIELDS: [&str; 6] = [
    "mediaKey",
    "directPath",
    "accessToken",
    "cookies",
    "credentials",
    "debugSecrets",
];

/// Host-side whitelist/normalization failure.
#[derive(Debug, Error)]
pub enum NormalizationError {
    /// A page record is not an object or has an unexpected field/type.
    #[error("invalid {dataset} record: {reason}")]
    InvalidRecord {
        /// Dataset name.
        dataset: &'static str,
        /// Stable diagnostic without record content.
        reason: String,
    },
    /// The same deterministic ID appeared more than once.
    #[error("duplicate normalized record ID: {0}")]
    DuplicateRecord(String),
    /// Media control frames do not match normalized message metadata.
    #[error("invalid media stream contract")]
    InvalidMediaContract,
    /// An encrypted checkpoint did not describe a valid resumable normalizer state.
    #[error("invalid acquisition checkpoint normalization state")]
    InvalidCheckpoint,
    /// The WAEB streaming writer rejected the record.
    #[error(transparent)]
    Writer(#[from] WaebError),
    /// A normalized record points to an entity absent from the same snapshot.
    #[error("normalized reference closure is incomplete ({0} missing target(s))")]
    UnresolvedReferences(usize),
}

/// Media counts computed from Rust-observed terminal results.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedMediaCounts {
    /// Assets requested by comprehensive mode.
    pub requested: u64,
    /// Assets committed to CAS.
    pub available: u64,
    /// Available primary attachment assets. Profile avatars are deliberately
    /// excluded because WAEB completeness reports them separately by role.
    pub full: u64,
    /// Available thumbnail assets.
    pub thumbnail: u64,
    /// Missing assets.
    pub missing: u64,
    /// Expired assets.
    pub expired: u64,
    /// Assets that failed decryption/read.
    pub decrypt_error: u64,
    pub download_timeout: u64,
    pub no_progress_timeout: u64,
    pub too_large: u64,
    pub disk_space_insufficient: u64,
    pub hash_mismatch: u64,
    pub transport_interrupted: u64,
    pub canceled: u64,
    pub unavailable: u64,
    /// Assets intentionally not requested in passive T0.
    pub not_attempted: u64,
}

/// Counts and reference checks produced by host-side normalization.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizationSummary {
    /// Accepted normalized records per dataset.
    pub record_counts: BTreeMap<String, u64>,
    /// References whose targets were not part of the observed snapshot.
    pub unresolved_reference_count: usize,
    /// Media acquisition counts.
    pub media: NormalizedMediaCounts,
    /// Number of normalized media-bearing records still lacking a terminal result.
    pub pending_media_count: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NormalizationMode {
    PassiveT0,
    ComprehensiveReadonlyV02,
}

impl NormalizationMode {
    const fn raw_phase(self) -> RawPhase {
        match self {
            Self::PassiveT0 => RawPhase::Baseline,
            Self::ComprehensiveReadonlyV02 => RawPhase::Enriched,
        }
    }

    const fn phase_label(self) -> &'static str {
        match self {
            Self::PassiveT0 => "baseline",
            Self::ComprehensiveReadonlyV02 => "enriched",
        }
    }

    const fn requests_media(self) -> bool {
        matches!(self, Self::ComprehensiveReadonlyV02)
    }
}

/// Host-detected media type information; never controls the CAS path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DetectedMedia {
    pub(crate) mime: String,
    pub(crate) suggested_extension: Option<String>,
}

/// Metadata fixed by the normalized message and a matching `media_start`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ActiveMediaBinding {
    asset_key: String,
    asset_id: String,
    source_record_id: String,
    role: String,
    kind: String,
    pub(crate) declared_mime: Option<String>,
    original_file_name: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    duration_ms: Option<u64>,
}

impl ActiveMediaBinding {
    pub(crate) fn asset_id(&self) -> &str {
        &self.asset_id
    }

    pub(crate) fn kind(&self) -> &str {
        &self.kind
    }

    pub(crate) fn original_file_name(&self) -> Option<&str> {
        self.original_file_name.as_deref()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingMedia {
    asset_id: String,
    source_record_id: String,
    role: String,
    kind: String,
    declared_mime: Option<String>,
    original_file_name: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatObservation {
    page_initial: u64,
    page_final: u64,
    history_scope: HistoryCompleteness,
    rounds: u32,
    returned_count: u64,
    page_new_count: u64,
    empty_rounds: u32,
    stagnant_rounds: u32,
    reason_code: String,
    message_count: u64,
    earliest_utc: Option<String>,
    latest_utc: Option<String>,
}

impl Default for ChatObservation {
    fn default() -> Self {
        Self {
            page_initial: 0,
            page_final: 0,
            history_scope: HistoryCompleteness::NotRun,
            rounds: 0,
            returned_count: 0,
            page_new_count: 0,
            empty_rounds: 0,
            stagnant_rounds: 0,
            reason_code: "history_not_requested".to_owned(),
            message_count: 0,
            earliest_utc: None,
            latest_utc: None,
        }
    }
}

struct MessageParties {
    from_me: bool,
    sender_id: Option<String>,
    author_id: Option<String>,
    recipient_ids: Vec<String>,
}

/// Stateful normalizer for exactly one source/acquisition.
pub(crate) struct Normalizer {
    source_id: Uuid,
    mode: NormalizationMode,
    self_native_id: Option<String>,
    seen_record_ids: BTreeSet<String>,
    observed_reference_ids: BTreeSet<String>,
    referenced_ids: BTreeSet<String>,
    counts: BTreeMap<String, u64>,
    chat_native_ids: BTreeSet<String>,
    community_native_ids: BTreeSet<String>,
    chat_stats: BTreeMap<String, ChatObservation>,
    pending_media: BTreeMap<String, PendingMedia>,
    completed_media: BTreeSet<String>,
    media_counts: NormalizedMediaCounts,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NormalizerCheckpoint {
    schema_version: String,
    source_id: Uuid,
    mode: NormalizationMode,
    self_native_id: Option<String>,
    seen_record_ids: BTreeSet<String>,
    observed_reference_ids: BTreeSet<String>,
    referenced_ids: BTreeSet<String>,
    counts: BTreeMap<String, u64>,
    chat_native_ids: BTreeSet<String>,
    community_native_ids: BTreeSet<String>,
    chat_stats: BTreeMap<String, ChatObservation>,
    pending_media: BTreeMap<String, PendingMedia>,
    completed_media: BTreeSet<String>,
    media_counts: NormalizedMediaCounts,
}

impl Normalizer {
    pub(crate) fn new(source_id: Uuid, mode: NormalizationMode) -> Self {
        Self {
            source_id,
            mode,
            self_native_id: None,
            seen_record_ids: BTreeSet::new(),
            observed_reference_ids: BTreeSet::new(),
            referenced_ids: BTreeSet::new(),
            counts: BTreeMap::new(),
            chat_native_ids: BTreeSet::new(),
            community_native_ids: BTreeSet::new(),
            chat_stats: BTreeMap::new(),
            pending_media: BTreeMap::new(),
            completed_media: BTreeSet::new(),
            media_counts: NormalizedMediaCounts::default(),
        }
    }

    pub(crate) fn ingest_batch(
        &mut self,
        dataset: DatasetKind,
        records: &[Value],
        captured_at_utc: &str,
        writer: &mut WaebWriter,
    ) -> Result<(), NormalizationError> {
        for value in records {
            self.ingest_one(dataset, value, captured_at_utc, writer)?;
        }
        Ok(())
    }

    pub(crate) fn summary(&self) -> NormalizationSummary {
        NormalizationSummary {
            record_counts: self.counts.clone(),
            unresolved_reference_count: self
                .referenced_ids
                .difference(&self.observed_reference_ids)
                .count(),
            media: self.media_counts.clone(),
            pending_media_count: self.pending_media.len(),
        }
    }

    pub(crate) fn validate_reference_closure(&self) -> Result<(), NormalizationError> {
        let missing = self
            .referenced_ids
            .difference(&self.observed_reference_ids)
            .count();
        if missing == 0 {
            Ok(())
        } else {
            Err(NormalizationError::UnresolvedReferences(missing))
        }
    }

    pub(crate) fn checkpoint(&self) -> NormalizerCheckpoint {
        NormalizerCheckpoint {
            schema_version: "wafc-normalizer-checkpoint/2".to_owned(),
            source_id: self.source_id,
            mode: self.mode,
            self_native_id: self.self_native_id.clone(),
            seen_record_ids: self.seen_record_ids.clone(),
            observed_reference_ids: self.observed_reference_ids.clone(),
            referenced_ids: self.referenced_ids.clone(),
            counts: self.counts.clone(),
            chat_native_ids: self.chat_native_ids.clone(),
            community_native_ids: self.community_native_ids.clone(),
            chat_stats: self.chat_stats.clone(),
            pending_media: self.pending_media.clone(),
            completed_media: self.completed_media.clone(),
            media_counts: self.media_counts.clone(),
        }
    }

    pub(crate) fn restore(
        checkpoint: NormalizerCheckpoint,
        source_id: Uuid,
        mode: NormalizationMode,
    ) -> Result<Self, NormalizationError> {
        let terminal_media = media_terminal_total(&checkpoint.media_counts);
        let seen_count = checkpoint.counts.values().copied().sum::<u64>();
        let role_available = checkpoint
            .media_counts
            .full
            .checked_add(checkpoint.media_counts.thumbnail);
        let valid = checkpoint.schema_version == "wafc-normalizer-checkpoint/2"
            && checkpoint.source_id == source_id
            && checkpoint.mode == mode
            && usize::try_from(seen_count).ok() == Some(checkpoint.seen_record_ids.len())
            && checkpoint
                .seen_record_ids
                .is_subset(&checkpoint.observed_reference_ids)
            && checkpoint
                .pending_media
                .keys()
                .all(|key| !checkpoint.completed_media.contains(key))
            && terminal_media.and_then(|value| {
                value.checked_add(u64::try_from(checkpoint.pending_media.len()).unwrap_or(u64::MAX))
            }) == Some(checkpoint.media_counts.requested)
            && role_available.is_some_and(|value| value <= checkpoint.media_counts.available)
            && checkpoint
                .counts
                .keys()
                .all(|name| waeb_writer::DATASETS.iter().any(|item| item.name == name));
        if !valid {
            return Err(NormalizationError::InvalidCheckpoint);
        }
        Ok(Self {
            source_id,
            mode,
            self_native_id: checkpoint.self_native_id,
            seen_record_ids: checkpoint.seen_record_ids,
            observed_reference_ids: checkpoint.observed_reference_ids,
            referenced_ids: checkpoint.referenced_ids,
            counts: checkpoint.counts,
            chat_native_ids: checkpoint.chat_native_ids,
            community_native_ids: checkpoint.community_native_ids,
            chat_stats: checkpoint.chat_stats,
            pending_media: checkpoint.pending_media,
            completed_media: checkpoint.completed_media,
            media_counts: checkpoint.media_counts,
        })
    }

    pub(crate) fn completed_asset_ids(&self) -> Vec<String> {
        let mut values = self
            .completed_media
            .iter()
            .filter_map(|asset_key| {
                let asset_id = deterministic_record_id(self.source_id, "asset", asset_key);
                (!asset_id.is_empty()).then_some(asset_id)
            })
            .collect::<Vec<_>>();
        values.sort();
        values
    }

    pub(crate) fn remaining_asset_ids(&self) -> Vec<String> {
        let mut values = self
            .pending_media
            .values()
            .map(|pending| pending.asset_id.clone())
            .collect::<Vec<_>>();
        values.sort();
        values
    }

    pub(crate) fn terminal_media_count(&self) -> Result<u64, NormalizationError> {
        media_terminal_total(&self.media_counts).ok_or(NormalizationError::InvalidCheckpoint)
    }

    pub(crate) fn begin_media(
        &self,
        payload: &MediaStartPayload,
    ) -> Result<ActiveMediaBinding, NormalizationError> {
        let pending = self
            .pending_media
            .get(&payload.asset_key)
            .ok_or(NormalizationError::InvalidMediaContract)?;
        let metadata_matches = if pending.role == "avatar" {
            payload.original_file_name.is_none()
                && payload.duration_ms.is_none()
                && payload
                    .declared_mime
                    .as_deref()
                    .is_none_or(|value| value.starts_with("image/"))
        } else {
            payload.declared_mime == pending.declared_mime
                && payload.original_file_name == pending.original_file_name
                && payload.width == pending.width
                && payload.height == pending.height
                && payload.duration_ms == pending.duration_ms
        };
        if self.completed_media.contains(&payload.asset_key)
            || payload.role != pending.role
            || payload.kind != pending.kind
            || !metadata_matches
            || !matches!(
                payload.method.as_str(),
                "cache_lookup" | "media_download" | "not_attempted"
            )
            || payload.attempts > 5
            || payload.network_action_attempted != (payload.attempts > 0)
        {
            return Err(NormalizationError::InvalidMediaContract);
        }
        Ok(ActiveMediaBinding {
            asset_key: payload.asset_key.clone(),
            asset_id: pending.asset_id.clone(),
            source_record_id: pending.source_record_id.clone(),
            role: pending.role.clone(),
            kind: pending.kind.clone(),
            declared_mime: if pending.role == "avatar" {
                payload.declared_mime.clone()
            } else {
                pending.declared_mime.clone()
            },
            original_file_name: if pending.role == "avatar" {
                payload.original_file_name.clone()
            } else {
                pending.original_file_name.clone()
            },
            width: if pending.role == "avatar" {
                payload.width
            } else {
                pending.width
            },
            height: if pending.role == "avatar" {
                payload.height
            } else {
                pending.height
            },
            duration_ms: if pending.role == "avatar" {
                payload.duration_ms
            } else {
                pending.duration_ms
            },
        })
    }

    #[allow(clippy::too_many_lines)]
    pub(crate) fn finish_media(
        &mut self,
        binding: &ActiveMediaBinding,
        payload: &MediaEndPayload,
        asset: Option<&MediaAsset>,
        detected: Option<&DetectedMedia>,
        writer: &mut WaebWriter,
    ) -> Result<(), NormalizationError> {
        if payload.asset_key != binding.asset_key
            || self.completed_media.contains(&payload.asset_key)
            || !self.pending_media.contains_key(&payload.asset_key)
        {
            return Err(NormalizationError::InvalidMediaContract);
        }
        let available = payload.status == "available";
        if available != asset.is_some()
            || available != detected.is_some()
            || asset.is_some_and(|value| value.byte_length != payload.total_bytes)
            || (!available && payload.total_bytes != 0)
        {
            return Err(NormalizationError::InvalidMediaContract);
        }
        let (status, error_code) = match payload.status.as_str() {
            "available" => {
                self.media_counts.available += 1;
                match binding.role.as_str() {
                    "full" => self.media_counts.full += 1,
                    "thumbnail" => self.media_counts.thumbnail += 1,
                    _ => {}
                }
                ("available", None)
            }
            "missing" => {
                self.media_counts.missing += 1;
                ("missing", payload.error_code.clone())
            }
            "expired" => {
                self.media_counts.expired += 1;
                ("expired", payload.error_code.clone())
            }
            "decrypt_error" => {
                self.media_counts.decrypt_error += 1;
                ("decrypt_error", payload.error_code.clone())
            }
            "download_timeout" => {
                self.media_counts.download_timeout += 1;
                ("download_timeout", payload.error_code.clone())
            }
            "no_progress_timeout" => {
                self.media_counts.no_progress_timeout += 1;
                ("no_progress_timeout", payload.error_code.clone())
            }
            "too_large" => {
                self.media_counts.too_large += 1;
                ("too_large", payload.error_code.clone())
            }
            "disk_space_insufficient" => {
                self.media_counts.disk_space_insufficient += 1;
                ("disk_space_insufficient", payload.error_code.clone())
            }
            "hash_mismatch" => {
                self.media_counts.hash_mismatch += 1;
                ("hash_mismatch", payload.error_code.clone())
            }
            "transport_interrupted" => {
                self.media_counts.transport_interrupted += 1;
                ("transport_interrupted", payload.error_code.clone())
            }
            "canceled" => {
                self.media_counts.canceled += 1;
                ("canceled", payload.error_code.clone())
            }
            "unavailable" => {
                self.media_counts.unavailable += 1;
                ("unavailable", payload.error_code.clone())
            }
            "not_attempted" => {
                self.media_counts.not_attempted += 1;
                ("not_attempted", payload.error_code.clone())
            }
            _ => return Err(NormalizationError::InvalidMediaContract),
        };
        let cas = asset.map(|value| {
            json!({
                "algorithm": "sha256",
                "digest": value.sha256,
                "path": value.relative_path,
                "byteLength": value.byte_length,
            })
        });
        writer.append_media_index(&json!({
            "schemaVersion": SCHEMA_VERSION,
            "assetId": binding.asset_id,
            "sourceId": self.source_id,
            "sourceRecordIds": [binding.source_record_id],
            "role": binding.role,
            "kind": binding.kind,
            "acquisitionStatus": status,
            "cas": cas,
            "declaredMime": binding.declared_mime,
            "detectedMime": detected.map(|value| value.mime.clone()),
            "detector": detected.map(|_| json!({"name": "wafc-magic", "version": "1"})),
            "suggestedExtension": detected.and_then(|value| value.suggested_extension.clone()),
            "originalFileName": binding.original_file_name,
            "width": binding.width,
            "height": binding.height,
            "durationMs": binding.duration_ms,
            "relatedAssetIds": [],
            "acquisition": {
                "method": payload.method,
                "attempts": payload.attempts,
                "capturedAtUtc": payload.captured_at_utc,
                "errorCode": error_code,
                "capturedByteLength": payload.total_bytes,
                "networkActionAttempted": payload.network_action_attempted,
            },
        }))?;
        self.pending_media.remove(&payload.asset_key);
        self.completed_media.insert(payload.asset_key.clone());
        Ok(())
    }

    pub(crate) fn write_chat_completeness(
        &self,
        writer: &mut WaebWriter,
    ) -> Result<(), NormalizationError> {
        for (chat_record_id, observation) in &self.chat_stats {
            let final_count = observation.message_count;
            let initial_count = match self.mode {
                NormalizationMode::PassiveT0 => final_count,
                NormalizationMode::ComprehensiveReadonlyV02 => {
                    observation.page_initial.min(final_count)
                }
            };
            let mut reasons = vec![observation.reason_code.clone()];
            let page_mismatch = observation.page_final != final_count;
            if page_mismatch {
                reasons.push("normalized_message_filter_applied".to_owned());
            }
            reasons.sort();
            reasons.dedup();
            let scope = if page_mismatch && self.mode == NormalizationMode::ComprehensiveReadonlyV02
            {
                "loader_error"
            } else {
                history_scope_label(observation.history_scope)
            };
            writer.append_chat_completeness(&json!({
                "schemaVersion": SCHEMA_VERSION,
                "sourceId": self.source_id,
                "chatRecordId": chat_record_id,
                "discoverySources": if self.mode == NormalizationMode::PassiveT0 {
                    vec!["store"]
                } else {
                    vec!["store", "history_loader"]
                },
                "initialMessageCount": initial_count,
                "finalMessageCount": final_count,
                "historyScope": scope,
                "loadMethod": if self.mode == NormalizationMode::PassiveT0 { "none" } else { "store_loader" },
                "rounds": observation.rounds,
                "returnedCount": observation.returned_count,
                "newCount": final_count.saturating_sub(initial_count).max(observation.page_new_count.min(final_count)),
                "emptyRounds": observation.empty_rounds,
                "stagnantRounds": observation.stagnant_rounds,
                "earliestObservedAtUtc": observation.earliest_utc,
                "latestObservedAtUtc": observation.latest_utc,
                "terminationEvidence": observation.reason_code,
                "reasonCodes": reasons,
            }))?;
        }
        Ok(())
    }

    fn ingest_one(
        &mut self,
        dataset: DatasetKind,
        value: &Value,
        captured_at_utc: &str,
        writer: &mut WaebWriter,
    ) -> Result<(), NormalizationError> {
        let object = value
            .as_object()
            .ok_or_else(|| invalid(dataset, "not an object"))?;
        ensure_allowed_fields(dataset, object)?;
        let native_id = required_string(dataset, object, "id", 512)?;
        let metadata = dataset_metadata(dataset, self.mode);
        let raw_id = deterministic_record_id(
            self.source_id,
            "raw",
            &format!("{}\0{native_id}", metadata.dataset_name),
        );
        let raw_hash = sha256_hex(&canonicalize(value)?);
        let native_type = optional_string(dataset, object, "type", 160)?
            .or(optional_string(dataset, object, "nativeType", 160)?)
            .unwrap_or_else(|| metadata.dataset_name.to_owned());
        writer.append_raw(
            self.mode.raw_phase(),
            RawProvider::Store,
            metadata.raw_stream,
            &json!({
                "schemaVersion": SCHEMA_VERSION,
                "recordId": raw_id,
                "provider": "store",
                "phase": self.mode.phase_label(),
                "capturedAtUtc": captured_at_utc,
                "nativeType": native_type,
                "value": value,
                "omittedFields": OMITTED_FIELDS,
                "contentSha256": raw_hash,
            }),
        )?;

        let record_id = deterministic_record_id(self.source_id, metadata.record_type, native_id);
        if !self.seen_record_ids.insert(record_id.clone()) {
            return Err(NormalizationError::DuplicateRecord(record_id));
        }
        let data = self.normalized_data(
            dataset,
            object,
            native_id,
            &record_id,
            captured_at_utc,
            writer,
        )?;
        let content_hash = sha256_hex(&canonicalize(&data)?);
        writer.append_normalized(
            metadata.dataset_name,
            &json!({
                "schemaVersion": SCHEMA_VERSION,
                "recordType": metadata.record_type,
                "recordId": record_id,
                "sourceId": self.source_id,
                "capturedAtUtc": captured_at_utc,
                "provenance": [{
                    "provider": "store",
                    "phase": self.mode.phase_label(),
                    "rawRef": {
                        "path": metadata.raw_path,
                        "recordId": raw_id,
                        "contentSha256": raw_hash,
                    }
                }],
                "contentSha256": content_hash,
                "data": data,
            }),
        )?;
        *self
            .counts
            .entry(metadata.dataset_name.to_owned())
            .or_default() += 1;
        self.observed_reference_ids.insert(record_id);
        if dataset == DatasetKind::Accounts && self.self_native_id.is_none() {
            self.self_native_id = Some(native_id.to_owned());
        }
        Ok(())
    }

    fn normalized_data(
        &mut self,
        dataset: DatasetKind,
        object: &Map<String, Value>,
        native_id: &str,
        record_id: &str,
        captured_at_utc: &str,
        writer: &mut WaebWriter,
    ) -> Result<Value, NormalizationError> {
        match dataset {
            DatasetKind::Accounts => {
                let profile_asset_ids =
                    self.profile_media_observation(dataset, object, native_id, record_id, writer)?;
                Self::account_data(object, native_id, &profile_asset_ids)
            }
            DatasetKind::Contacts => {
                let profile_asset_ids =
                    self.profile_media_observation(dataset, object, native_id, record_id, writer)?;
                self.contact_data(object, native_id, &profile_asset_ids)
            }
            DatasetKind::Chats => self.chat_data(object, native_id, record_id, captured_at_utc),
            DatasetKind::ChatLists => self.chat_list_data(object, native_id),
            DatasetKind::Participants => self.participant_data(object),
            DatasetKind::Messages | DatasetKind::Statuses | DatasetKind::ChannelEvents => self
                .message_data(
                    dataset,
                    object,
                    native_id,
                    record_id,
                    captured_at_utc,
                    writer,
                ),
            DatasetKind::MessageEvents
            | DatasetKind::Reactions
            | DatasetKind::Receipts
            | DatasetKind::PollVotes
            | DatasetKind::GroupEvents
            | DatasetKind::Calls
            | DatasetKind::PresenceSnapshots => self.event_data(dataset, object, captured_at_utc),
            DatasetKind::Channels | DatasetKind::Communities => {
                self.entity_data(dataset, object, native_id)
            }
            DatasetKind::CommunityRelations => self.relation_data(object, captured_at_utc),
        }
    }

    fn account_data(
        object: &Map<String, Value>,
        native_id: &str,
        profile_asset_ids: &[String],
    ) -> Result<Value, NormalizationError> {
        let business = optional_bool(DatasetKind::Accounts, object, "isBusiness")?.unwrap_or(false);
        Ok(json!({
            "nativeIdentities": [native_identity(native_id)],
            "displayName": optional_string(DatasetKind::Accounts, object, "displayName", 512)?,
            "accountKind": if business { "business" } else { "consumer" },
            "isBusiness": business,
            "verifiedName": optional_string(DatasetKind::Accounts, object, "verifiedName", 512)?,
            "profileAssetIds": profile_asset_ids,
            "observedDevice": {"deviceId": null, "isCompanion": true},
        }))
    }

    fn contact_data(
        &self,
        object: &Map<String, Value>,
        native_id: &str,
        profile_asset_ids: &[String],
    ) -> Result<Value, NormalizationError> {
        let formatted = optional_string(DatasetKind::Contacts, object, "formattedName", 512)?
            .or(optional_string(DatasetKind::Contacts, object, "name", 512)?);
        Ok(json!({
            "nativeIdentities": [native_identity(native_id)],
            "displayNames": {
                "formatted": formatted,
                "push": optional_string(DatasetKind::Contacts, object, "pushName", 512)?,
                "short": optional_string(DatasetKind::Contacts, object, "shortName", 512)?,
                "verified": optional_string(DatasetKind::Contacts, object, "verifiedName", 512)?,
            },
            "about": optional_string(DatasetKind::Contacts, object, "about", 2048)?,
            "isSelf": self.self_native_id.as_deref() == Some(native_id),
            "isAddressBookContact": optional_bool(DatasetKind::Contacts, object, "isMyContact")?.unwrap_or(false),
            "isWhatsAppUser": optional_bool(DatasetKind::Contacts, object, "isWhatsAppContact")?.unwrap_or(false),
            "isVerified": optional_bool(DatasetKind::Contacts, object, "isVerified")?.unwrap_or(false),
            "isDeactivated": optional_bool(DatasetKind::Contacts, object, "isDeactivated")?,
            "profileAssetIds": profile_asset_ids,
        }))
    }

    fn profile_media_observation(
        &mut self,
        dataset: DatasetKind,
        object: &Map<String, Value>,
        native_id: &str,
        source_record_id: &str,
        writer: &mut WaebWriter,
    ) -> Result<Vec<String>, NormalizationError> {
        if !optional_bool(dataset, object, "profileImageAvailable")?.unwrap_or(false) {
            return Ok(Vec::new());
        }
        let source_kind = match dataset {
            DatasetKind::Accounts => "account",
            DatasetKind::Contacts => "contact",
            _ => return Err(invalid(dataset, "invalid profile media dataset")),
        };
        let asset_key = media_asset_key(source_kind, native_id, "avatar");
        let asset_id = self.register_media_observation(
            asset_key,
            source_record_id,
            "avatar",
            "image",
            None,
            None,
            None,
            None,
            None,
            writer,
        )?;
        Ok(vec![asset_id])
    }

    fn chat_data(
        &mut self,
        object: &Map<String, Value>,
        native_id: &str,
        record_id: &str,
        captured_at_utc: &str,
    ) -> Result<Value, NormalizationError> {
        self.chat_native_ids.insert(native_id.to_owned());
        let initial =
            optional_nonnegative(DatasetKind::Chats, object, "initialMessageCount")?.unwrap_or(0);
        let final_count = optional_nonnegative(DatasetKind::Chats, object, "finalMessageCount")?
            .unwrap_or(initial);
        let history_scope = optional_history_scope(object.get("historyScope"))?;
        let reason_code = optional_string(DatasetKind::Chats, object, "historyReasonCode", 100)?
            .unwrap_or_else(|| "history_not_requested".to_owned());
        self.chat_stats.insert(
            record_id.to_owned(),
            ChatObservation {
                page_initial: initial,
                page_final: final_count,
                history_scope,
                rounds: optional_u32(DatasetKind::Chats, object, "historyRounds")?.unwrap_or(0),
                returned_count: optional_nonnegative(
                    DatasetKind::Chats,
                    object,
                    "historyReturnedCount",
                )?
                .unwrap_or(0),
                page_new_count: optional_nonnegative(
                    DatasetKind::Chats,
                    object,
                    "historyNewCount",
                )?
                .unwrap_or(0),
                empty_rounds: optional_u32(DatasetKind::Chats, object, "historyEmptyRounds")?
                    .unwrap_or(0),
                stagnant_rounds: optional_u32(DatasetKind::Chats, object, "historyStagnantRounds")?
                    .unwrap_or(0),
                reason_code,
                ..ChatObservation::default()
            },
        );
        let is_group = optional_bool(DatasetKind::Chats, object, "isGroup")?.unwrap_or(false)
            || native_id.ends_with("@g.us");
        let kind = if is_group {
            "group"
        } else if native_id.ends_with("@broadcast") {
            "broadcast"
        } else {
            "direct"
        };
        let muted = optional_integer(DatasetKind::Chats, object, "muteExpiration")?
            .filter(|value| *value > 0)
            .and_then(|value| timestamp_to_utc(value).ok());
        let ephemeral_duration =
            optional_nonnegative(DatasetKind::Chats, object, "ephemeralDurationSeconds")?;
        Ok(json!({
            "nativeIdentity": native_identity(native_id),
            "kind": kind,
            "title": optional_string(DatasetKind::Chats, object, "name", 512)?,
            "participantRecordIds": [],
            "state": {
                "archived": optional_bool(DatasetKind::Chats, object, "archived")?.unwrap_or(false),
                "pinned": optional_bool(DatasetKind::Chats, object, "pinned")?.unwrap_or(false),
                "readOnly": optional_bool(DatasetKind::Chats, object, "isReadOnly")?.unwrap_or(false),
                "unreadCount": optional_nonnegative(DatasetKind::Chats, object, "unreadCount")?.unwrap_or(0),
                "mutedUntilUtc": muted,
            },
            "ephemeral": {
                "enabled": ephemeral_duration.is_some_and(|value| value > 0),
                "durationSeconds": ephemeral_duration,
            },
            "firstObservedAtUtc": captured_at_utc,
            "lastObservedAtUtc": captured_at_utc,
        }))
    }

    fn chat_list_data(
        &mut self,
        object: &Map<String, Value>,
        native_id: &str,
    ) -> Result<Value, NormalizationError> {
        let kind = required_string(DatasetKind::ChatLists, object, "listKind", 32)?;
        if !matches!(kind, "favorites" | "custom") {
            return Err(invalid(DatasetKind::ChatLists, "invalid listKind"));
        }
        let chat_ids = string_array(DatasetKind::ChatLists, object, "chatIds", 512, 100_000)?;
        let record_ids = chat_ids
            .iter()
            .map(|id| {
                let record = deterministic_record_id(self.source_id, "chat", id);
                self.referenced_ids.insert(record.clone());
                record
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "nativeIdentity": if native_id.starts_with("derived:") { Value::Null } else { native_identity(native_id) },
            "listKind": kind,
            "name": required_string(DatasetKind::ChatLists, object, "name", 512)?,
            "order": required_nonnegative(DatasetKind::ChatLists, object, "order")?,
            "chatRecordIds": record_ids,
        }))
    }

    fn participant_data(
        &mut self,
        object: &Map<String, Value>,
    ) -> Result<Value, NormalizationError> {
        let container_native =
            required_string(DatasetKind::Participants, object, "containerId", 512)?;
        let subject_native = required_string(DatasetKind::Participants, object, "subjectId", 512)?;
        let container_id = deterministic_record_id(self.source_id, "chat", container_native);
        let subject_type = if self.self_native_id.as_deref() == Some(subject_native) {
            "account"
        } else {
            "contact"
        };
        let subject_id = deterministic_record_id(self.source_id, subject_type, subject_native);
        self.referenced_ids.insert(container_id.clone());
        self.referenced_ids.insert(subject_id.clone());
        let role = required_string(DatasetKind::Participants, object, "role", 32)?;
        if !matches!(
            role,
            "owner" | "admin" | "member" | "subscriber" | "unknown"
        ) {
            return Err(invalid(DatasetKind::Participants, "invalid role"));
        }
        let membership = required_string(DatasetKind::Participants, object, "membershipState", 32)?;
        if !matches!(membership, "active" | "left" | "removed" | "unknown") {
            return Err(invalid(
                DatasetKind::Participants,
                "invalid membershipState",
            ));
        }
        Ok(json!({
            "containerRecordId": container_id,
            "subjectRecordId": subject_id,
            "role": role,
            "membershipState": membership,
            "joinedAtUtc": optional_timestamp(DatasetKind::Participants, object, "joinedTimestamp")?,
            "leftAtUtc": optional_timestamp(DatasetKind::Participants, object, "leftTimestamp")?,
        }))
    }

    #[allow(clippy::too_many_lines)]
    fn message_data(
        &mut self,
        dataset: DatasetKind,
        object: &Map<String, Value>,
        native_id: &str,
        message_record_id: &str,
        captured_at_utc: &str,
        writer: &mut WaebWriter,
    ) -> Result<Value, NormalizationError> {
        let container_native = required_string(dataset, object, "chatId", 512)?;
        let (container_kind, container_type) = match dataset {
            DatasetKind::Messages => ("chat", "chat"),
            DatasetKind::Statuses => ("status_thread", "chat"),
            DatasetKind::ChannelEvents => ("channel", "channel"),
            _ => return Err(invalid(dataset, "not a message-like dataset")),
        };
        let container_id =
            deterministic_record_id(self.source_id, container_type, container_native);
        self.referenced_ids.insert(container_id.clone());
        let parties = self.message_parties(dataset, object, container_native)?;
        let native_type =
            optional_string(dataset, object, "type", 160)?.unwrap_or_else(|| "unknown".to_owned());
        let subtype = optional_string(dataset, object, "subtype", 160)?;
        let body = optional_string(dataset, object, "body", 1_048_576)?;
        let kind = message_kind(&native_type, subtype.as_deref(), body.is_some());
        let sent_at = observed_time(dataset, object.get("timestamp"), captured_at_utc)?;
        if dataset == DatasetKind::Messages {
            self.record_chat_observation(&container_id, &sent_at);
        }
        let quoted = optional_string(dataset, object, "quotedMessageId", 512)?.map(|native| {
            json!({
                "resolution": "unresolved",
                "messageRecordId": deterministic_record_id(self.source_id, dataset_metadata(dataset, self.mode).record_type, &native),
                "nativeIdentity": native_identity_unknown(&native),
                "participantRecordId": null,
            })
        });
        let acknowledgement = object
            .get("acknowledgement")
            .cloned()
            .unwrap_or(Value::Null);
        if !(acknowledgement.is_null()
            || acknowledgement.is_number()
            || acknowledgement.is_string())
        {
            return Err(invalid(dataset, "acknowledgement has invalid type"));
        }
        let mention_ids = string_array(dataset, object, "mentionIds", 512, 10_000)?
            .iter()
            .map(|native| {
                let record_type = if self.self_native_id.as_deref() == Some(native.as_str()) {
                    "account"
                } else {
                    "contact"
                };
                let record = deterministic_record_id(self.source_id, record_type, native);
                self.referenced_ids.insert(record.clone());
                record
            })
            .collect::<Vec<_>>();
        let attachment_ids = self.message_media_observation(
            dataset,
            object,
            native_id,
            message_record_id,
            kind,
            writer,
        )?;
        let location = optional_location(dataset, object)?;
        let poll = optional_poll(dataset, object)?;
        let event = optional_event(dataset, object)?;
        let unsupported_reason_codes =
            string_array(dataset, object, "unsupportedReasonCodes", 100, 16)?;
        if unsupported_reason_codes
            .iter()
            .any(|reason| !is_supported_message_reason_code(reason))
        {
            return Err(invalid(
                dataset,
                "unsupportedReasonCodes contains an unknown reason",
            ));
        }
        Ok(json!({
            "nativeIdentity": native_identity_unknown(native_id),
            "container": {"kind": container_kind, "recordId": container_id},
            "senderRecordId": parties.sender_id,
            "recipientRecordIds": parties.recipient_ids,
            "authorRecordId": parties.author_id,
            "sentAt": sent_at,
            "kind": kind,
            "nativeType": native_type,
            "text": body,
            "caption": optional_string(dataset, object, "caption", 1_048_576)?,
            "quoted": quoted,
            "mentionRecordIds": mention_ids,
            "flags": {
                "fromMe": parties.from_me,
                "forwarded": optional_bool(dataset, object, "isForwarded")?.unwrap_or(false),
                "starred": optional_bool(dataset, object, "isStarred")?.unwrap_or(false),
                "edited": optional_bool(dataset, object, "isEdited")?.unwrap_or(false),
                "revoked": optional_bool(dataset, object, "isRevoked")?.unwrap_or(false),
                "viewOnce": optional_bool(dataset, object, "isViewOnce")?.unwrap_or(false),
                "ephemeral": optional_bool(dataset, object, "isEphemeral")?.unwrap_or(false),
            },
            "acknowledgement": {
                "state": acknowledgement_state(&acknowledgement),
                "nativeValue": acknowledgement,
            },
            "attachmentAssetIds": attachment_ids,
            "location": location,
            "poll": poll,
            "event": event,
            "unsupportedReasonCodes": unsupported_reason_codes,
        }))
    }

    fn message_parties(
        &mut self,
        dataset: DatasetKind,
        object: &Map<String, Value>,
        container_native: &str,
    ) -> Result<MessageParties, NormalizationError> {
        let from_me = optional_bool(dataset, object, "fromMe")?.unwrap_or(false);
        let sender_native = optional_string(dataset, object, "senderId", 512)?
            .or(optional_string(dataset, object, "authorId", 512)?);
        let sender_id = if from_me {
            self.self_native_id
                .as_deref()
                .map(|native| deterministic_record_id(self.source_id, "account", native))
        } else {
            sender_native.as_deref().map(|native| {
                deterministic_record_id(
                    self.source_id,
                    actor_record_type(dataset, native, self.self_native_id.as_deref()),
                    native,
                )
            })
        };
        if let Some(reference) = &sender_id {
            self.referenced_ids.insert(reference.clone());
        }
        let author_id = optional_string(dataset, object, "authorId", 512)?.map(|native| {
            deterministic_record_id(
                self.source_id,
                actor_record_type(dataset, &native, self.self_native_id.as_deref()),
                &native,
            )
        });
        if let Some(reference) = &author_id {
            self.referenced_ids.insert(reference.clone());
        }
        let recipient_ids = optional_string(dataset, object, "recipientId", 512)?
            .and_then(|native| {
                recipient_record_type(
                    dataset,
                    &native,
                    container_native,
                    self.self_native_id.as_deref(),
                )
                .map(|record_type| deterministic_record_id(self.source_id, record_type, &native))
            })
            .into_iter()
            .collect::<Vec<_>>();
        self.referenced_ids.extend(recipient_ids.iter().cloned());
        Ok(MessageParties {
            from_me,
            sender_id,
            author_id,
            recipient_ids,
        })
    }

    fn message_media_observation(
        &mut self,
        dataset: DatasetKind,
        object: &Map<String, Value>,
        native_id: &str,
        message_record_id: &str,
        message_kind: &str,
        writer: &mut WaebWriter,
    ) -> Result<Vec<String>, NormalizationError> {
        let reports_media = optional_bool(dataset, object, "hasMedia")?.unwrap_or(false);
        let kind = match message_kind {
            "image" | "video" | "audio" | "voice" | "document" | "sticker" | "contact_card" => {
                message_kind
            }
            _ if reports_media => "other",
            _ => return Ok(Vec::new()),
        };
        let source_kind = dataset_metadata(dataset, self.mode).record_type;
        let asset_key = media_asset_key(source_kind, native_id, "full");
        let asset_id = self.register_media_observation(
            asset_key,
            message_record_id,
            "full",
            kind,
            optional_string(dataset, object, "mediaMimeType", 160)?,
            optional_string(dataset, object, "mediaFileName", 512)?,
            optional_nonnegative(dataset, object, "mediaWidth")?,
            optional_nonnegative(dataset, object, "mediaHeight")?,
            optional_duration_ms(dataset, object, "mediaDurationSeconds")?,
            writer,
        )?;
        Ok(vec![asset_id])
    }

    #[allow(clippy::too_many_arguments)]
    fn register_media_observation(
        &mut self,
        asset_key: String,
        source_record_id: &str,
        role: &str,
        kind: &str,
        declared_mime: Option<String>,
        original_file_name: Option<String>,
        width: Option<u64>,
        height: Option<u64>,
        duration_ms: Option<u64>,
        writer: &mut WaebWriter,
    ) -> Result<String, NormalizationError> {
        let asset_id = deterministic_record_id(self.source_id, "asset", &asset_key);
        let pending = PendingMedia {
            asset_id: asset_id.clone(),
            source_record_id: source_record_id.to_owned(),
            role: role.to_owned(),
            kind: kind.to_owned(),
            declared_mime,
            original_file_name,
            width,
            height,
            duration_ms,
        };
        if self.mode.requests_media() {
            if self.pending_media.insert(asset_key, pending).is_some() {
                return Err(NormalizationError::InvalidMediaContract);
            }
            self.media_counts.requested += 1;
        } else {
            self.media_counts.requested += 1;
            writer.append_media_index(&json!({
                "schemaVersion": SCHEMA_VERSION,
                "assetId": pending.asset_id,
                "sourceId": self.source_id,
                "sourceRecordIds": [pending.source_record_id],
                "role": pending.role,
                "kind": pending.kind,
                "acquisitionStatus": "not_attempted",
                "cas": null,
                "declaredMime": pending.declared_mime,
                "detectedMime": null,
                "detector": null,
                "suggestedExtension": null,
                "originalFileName": pending.original_file_name,
                "width": pending.width,
                "height": pending.height,
                "durationMs": pending.duration_ms,
                "relatedAssetIds": [],
                "acquisition": {
                    "method": "not_attempted",
                    "attempts": 0,
                    "capturedAtUtc": null,
                    "errorCode": "media_not_attempted",
                    "capturedByteLength": 0,
                    "networkActionAttempted": false,
                },
            }))?;
            self.media_counts.not_attempted += 1;
        }
        Ok(asset_id)
    }

    fn event_data(
        &mut self,
        dataset: DatasetKind,
        object: &Map<String, Value>,
        captured_at_utc: &str,
    ) -> Result<Value, NormalizationError> {
        let event_kind = required_string(dataset, object, "eventKind", 100)?;
        if !valid_code(event_kind) {
            return Err(invalid(dataset, "eventKind is not canonical"));
        }
        let native_type = required_string(dataset, object, "nativeType", 160)?;
        let subject_native = string_array(dataset, object, "subjectIds", 512, 10_000)?;
        let actor_native = string_array(dataset, object, "actorIds", 512, 10_000)?;
        let subject_type = match dataset {
            DatasetKind::MessageEvents
            | DatasetKind::Reactions
            | DatasetKind::Receipts
            | DatasetKind::PollVotes => "message",
            DatasetKind::GroupEvents | DatasetKind::Calls => "chat",
            DatasetKind::PresenceSnapshots => "contact",
            _ => return Err(invalid(dataset, "invalid event dataset")),
        };
        let subject_ids = subject_native
            .iter()
            .map(|native| {
                let record_type = if dataset == DatasetKind::PresenceSnapshots
                    && self.self_native_id.as_deref() == Some(native.as_str())
                {
                    "account"
                } else {
                    subject_type
                };
                let record = deterministic_record_id(self.source_id, record_type, native);
                self.referenced_ids.insert(record.clone());
                record
            })
            .collect::<Vec<_>>();
        let actor_ids = actor_native
            .iter()
            .map(|native| {
                let record_type = if self.self_native_id.as_deref() == Some(native.as_str()) {
                    "account"
                } else {
                    "contact"
                };
                let record = deterministic_record_id(self.source_id, record_type, native);
                self.referenced_ids.insert(record.clone());
                record
            })
            .collect::<Vec<_>>();
        let details = compact_json_object([
            (
                "state",
                optional_string(dataset, object, "state", 512)?.map(Value::String),
            ),
            (
                "marker",
                optional_string(dataset, object, "marker", 128)?.map(Value::String),
            ),
            (
                "option",
                optional_string(dataset, object, "option", 1024)?.map(Value::String),
            ),
            (
                "numericValue",
                optional_number(dataset, object, "numericValue")?.map(json_number),
            ),
            (
                "isVideo",
                optional_bool(dataset, object, "isVideo")?.map(Value::Bool),
            ),
            (
                "isGroup",
                optional_bool(dataset, object, "isGroup")?.map(Value::Bool),
            ),
            (
                "outgoing",
                optional_bool(dataset, object, "outgoing")?.map(Value::Bool),
            ),
        ]);
        Ok(json!({
            "eventKind": event_kind,
            "nativeType": native_type,
            "subjectRecordIds": subject_ids,
            "actorRecordIds": actor_ids,
            "occurredAtUtc": optional_timestamp(dataset, object, "timestamp")?
                .or_else(|| (dataset == DatasetKind::PresenceSnapshots).then(|| captured_at_utc.to_owned())),
            "details": {"org.whatsapp-forensics.wafc": details},
            "unsupportedReasonCodes": [],
        }))
    }

    fn entity_data(
        &mut self,
        dataset: DatasetKind,
        object: &Map<String, Value>,
        native_id: &str,
    ) -> Result<Value, NormalizationError> {
        let entity_kind = required_string(dataset, object, "entityKind", 32)?;
        let expected = if dataset == DatasetKind::Channels {
            "channel"
        } else {
            "community"
        };
        if entity_kind != expected {
            return Err(invalid(dataset, "entityKind does not match dataset"));
        }
        if dataset == DatasetKind::Communities {
            self.community_native_ids.insert(native_id.to_owned());
        }
        let state = compact_json_object([
            (
                "membershipState",
                optional_string(dataset, object, "membershipState", 160)?.map(Value::String),
            ),
            (
                "verified",
                optional_bool(dataset, object, "verified")?.map(Value::Bool),
            ),
            (
                "readOnly",
                optional_bool(dataset, object, "readOnly")?.map(Value::Bool),
            ),
            (
                "unreadCount",
                optional_nonnegative(dataset, object, "unreadCount")?.map(json_u64),
            ),
            (
                "creationTimestamp",
                optional_number(dataset, object, "creationTimestamp")?.map(json_number),
            ),
        ]);
        Ok(json!({
            "nativeIdentities": [native_identity(native_id)],
            "entityKind": entity_kind,
            "displayName": optional_string(dataset, object, "displayName", 512)?,
            "description": optional_string(dataset, object, "description", 65_536)?,
            "state": {"org.whatsapp-forensics.wafc": state},
            "mediaAssetIds": [],
            "unsupportedReasonCodes": [],
        }))
    }

    fn relation_data(
        &mut self,
        object: &Map<String, Value>,
        captured_at_utc: &str,
    ) -> Result<Value, NormalizationError> {
        let dataset = DatasetKind::CommunityRelations;
        let kind = required_string(dataset, object, "relationKind", 100)?;
        if !matches!(
            kind,
            "community_announcement_group"
                | "community_child_group"
                | "community_parent"
                | "unknown"
        ) {
            return Err(invalid(dataset, "invalid relationKind"));
        }
        let from_native = required_string(dataset, object, "fromId", 512)?;
        let from_type = if self.community_native_ids.contains(from_native) {
            "community"
        } else {
            "chat"
        };
        let from_id = deterministic_record_id(self.source_id, from_type, from_native);
        self.referenced_ids.insert(from_id.clone());
        let to_native = optional_string(dataset, object, "toId", 512)?;
        let (to_id, resolution) = to_native.map_or((None, "unresolved"), |native| {
            let observed_community = self.community_native_ids.contains(&native);
            let observed_chat = self.chat_native_ids.contains(&native);
            let target_type = if observed_community {
                "community"
            } else {
                "chat"
            };
            let record = deterministic_record_id(self.source_id, target_type, &native);
            if observed_community || observed_chat {
                self.referenced_ids.insert(record.clone());
                (Some(record), "resolved")
            } else {
                (Some(record), "unresolved")
            }
        });
        Ok(json!({
            "relationKind": kind,
            "fromRecordId": from_id,
            "toRecordId": to_id,
            "resolution": resolution,
            "observedAtUtc": captured_at_utc,
            "details": {},
        }))
    }

    fn record_chat_observation(&mut self, chat_id: &str, sent_at: &Value) {
        if let Some(observed_utc) = sent_at.get("utc").and_then(Value::as_str) {
            let observation = self.chat_stats.entry(chat_id.to_owned()).or_default();
            observation.message_count += 1;
            if observation
                .earliest_utc
                .as_ref()
                .is_none_or(|current| observed_utc < current.as_str())
            {
                observation.earliest_utc = Some(observed_utc.to_owned());
            }
            if observation
                .latest_utc
                .as_ref()
                .is_none_or(|current| observed_utc > current.as_str())
            {
                observation.latest_utc = Some(observed_utc.to_owned());
            }
        }
    }
}

fn is_supported_message_reason_code(reason: &str) -> bool {
    matches!(
        reason,
        "message_model_fields_unavailable" | "media_inline_preview_omitted"
    )
}

fn media_asset_key(source_kind: &str, native_id: &str, role: &str) -> String {
    format!("{source_kind}:{native_id}:{role}")
}

#[derive(Clone, Copy)]
struct DatasetMetadata {
    dataset_name: &'static str,
    record_type: &'static str,
    raw_stream: RawStream,
    raw_path: &'static str,
}

#[allow(clippy::too_many_lines)]
fn dataset_metadata(dataset: DatasetKind, mode: NormalizationMode) -> DatasetMetadata {
    let (dataset_name, record_type, raw_stream, file) = match dataset {
        DatasetKind::Accounts => (
            "accounts",
            "account",
            RawStream::Accounts,
            "accounts.ndjson",
        ),
        DatasetKind::Contacts => (
            "contacts",
            "contact",
            RawStream::Contacts,
            "contacts.ndjson",
        ),
        DatasetKind::Chats => ("chats", "chat", RawStream::Chats, "chats.ndjson"),
        DatasetKind::ChatLists => (
            "chat_lists",
            "chat_list",
            RawStream::Metadata,
            "metadata.ndjson",
        ),
        DatasetKind::Participants => (
            "participants",
            "participant",
            RawStream::Entities,
            "entities.ndjson",
        ),
        DatasetKind::Messages => (
            "messages",
            "message",
            RawStream::Messages,
            "messages.ndjson",
        ),
        DatasetKind::MessageEvents => (
            "message_events",
            "message_event",
            RawStream::Events,
            "events.ndjson",
        ),
        DatasetKind::Reactions => ("reactions", "reaction", RawStream::Events, "events.ndjson"),
        DatasetKind::Receipts => ("receipts", "receipt", RawStream::Events, "events.ndjson"),
        DatasetKind::PollVotes => (
            "poll_votes",
            "poll_vote",
            RawStream::Events,
            "events.ndjson",
        ),
        DatasetKind::GroupEvents => (
            "group_events",
            "group_event",
            RawStream::Events,
            "events.ndjson",
        ),
        DatasetKind::Statuses => ("statuses", "status", RawStream::Messages, "messages.ndjson"),
        DatasetKind::Calls => ("calls", "call", RawStream::Events, "events.ndjson"),
        DatasetKind::Channels => (
            "channels",
            "channel",
            RawStream::Entities,
            "entities.ndjson",
        ),
        DatasetKind::ChannelEvents => (
            "channel_events",
            "channel_event",
            RawStream::Messages,
            "messages.ndjson",
        ),
        DatasetKind::Communities => (
            "communities",
            "community",
            RawStream::Entities,
            "entities.ndjson",
        ),
        DatasetKind::CommunityRelations => (
            "community_relations",
            "community_relation",
            RawStream::Events,
            "events.ndjson",
        ),
        DatasetKind::PresenceSnapshots => (
            "presence_snapshots",
            "presence_snapshot",
            RawStream::Events,
            "events.ndjson",
        ),
    };
    let raw_path = match (mode, file) {
        (NormalizationMode::PassiveT0, "accounts.ndjson") => {
            "data/raw/baseline/store/accounts.ndjson"
        }
        (NormalizationMode::PassiveT0, "contacts.ndjson") => {
            "data/raw/baseline/store/contacts.ndjson"
        }
        (NormalizationMode::PassiveT0, "chats.ndjson") => "data/raw/baseline/store/chats.ndjson",
        (NormalizationMode::PassiveT0, "messages.ndjson") => {
            "data/raw/baseline/store/messages.ndjson"
        }
        (NormalizationMode::PassiveT0, "entities.ndjson") => {
            "data/raw/baseline/store/entities.ndjson"
        }
        (NormalizationMode::PassiveT0, "events.ndjson") => "data/raw/baseline/store/events.ndjson",
        (NormalizationMode::PassiveT0, _) => "data/raw/baseline/store/metadata.ndjson",
        (NormalizationMode::ComprehensiveReadonlyV02, "accounts.ndjson") => {
            "data/raw/enriched/store/accounts.ndjson"
        }
        (NormalizationMode::ComprehensiveReadonlyV02, "contacts.ndjson") => {
            "data/raw/enriched/store/contacts.ndjson"
        }
        (NormalizationMode::ComprehensiveReadonlyV02, "chats.ndjson") => {
            "data/raw/enriched/store/chats.ndjson"
        }
        (NormalizationMode::ComprehensiveReadonlyV02, "messages.ndjson") => {
            "data/raw/enriched/store/messages.ndjson"
        }
        (NormalizationMode::ComprehensiveReadonlyV02, "entities.ndjson") => {
            "data/raw/enriched/store/entities.ndjson"
        }
        (NormalizationMode::ComprehensiveReadonlyV02, "events.ndjson") => {
            "data/raw/enriched/store/events.ndjson"
        }
        (NormalizationMode::ComprehensiveReadonlyV02, _) => {
            "data/raw/enriched/store/metadata.ndjson"
        }
    };
    DatasetMetadata {
        dataset_name,
        record_type,
        raw_stream,
        raw_path,
    }
}

#[allow(clippy::too_many_lines)]
fn allowed_fields(dataset: DatasetKind) -> &'static [&'static str] {
    match dataset {
        DatasetKind::Accounts => &[
            "id",
            "displayName",
            "isBusiness",
            "isEnterprise",
            "verifiedName",
            "profileImageAvailable",
        ],
        DatasetKind::Contacts => &[
            "id",
            "name",
            "pushName",
            "shortName",
            "formattedName",
            "isUser",
            "isGroup",
            "isWhatsAppContact",
            "isBusiness",
            "isMyContact",
            "isBlocked",
            "about",
            "verifiedName",
            "isVerified",
            "isDeactivated",
            "profileImageAvailable",
        ],
        DatasetKind::Chats => &[
            "id",
            "name",
            "isGroup",
            "isReadOnly",
            "archived",
            "pinned",
            "unreadCount",
            "timestamp",
            "muteExpiration",
            "lastMessageId",
            "participantCount",
            "ephemeralDurationSeconds",
            "isCommunity",
            "parentGroupId",
            "defaultSubgroupId",
            "joinedSubgroupIds",
            "initialMessageCount",
            "finalMessageCount",
            "historyScope",
            "historyRounds",
            "historyReturnedCount",
            "historyNewCount",
            "historyEmptyRounds",
            "historyStagnantRounds",
            "historyReasonCode",
        ],
        DatasetKind::ChatLists => &["id", "listKind", "name", "order", "chatIds"],
        DatasetKind::Participants => &[
            "id",
            "containerId",
            "subjectId",
            "role",
            "membershipState",
            "joinedTimestamp",
            "leftTimestamp",
        ],
        DatasetKind::Messages | DatasetKind::Statuses | DatasetKind::ChannelEvents => &[
            "id",
            "chatId",
            "senderId",
            "authorId",
            "recipientId",
            "timestamp",
            "type",
            "subtype",
            "body",
            "caption",
            "fromMe",
            "isStarred",
            "isForwarded",
            "isViewOnce",
            "isEdited",
            "isRevoked",
            "hasMedia",
            "acknowledgement",
            "quotedMessageId",
            "mediaMimeType",
            "mediaSize",
            "mediaFileName",
            "mediaWidth",
            "mediaHeight",
            "mediaDurationSeconds",
            "mentionIds",
            "isEphemeral",
            "latitude",
            "longitude",
            "locationName",
            "locationAddress",
            "pollName",
            "pollOptions",
            "pollSelectableCount",
            "pollClosed",
            "eventName",
            "eventDescription",
            "eventStartTimestamp",
            "eventCanceled",
            "unsupportedReasonCodes",
        ],
        DatasetKind::MessageEvents
        | DatasetKind::Reactions
        | DatasetKind::Receipts
        | DatasetKind::PollVotes
        | DatasetKind::GroupEvents
        | DatasetKind::Calls
        | DatasetKind::PresenceSnapshots => &[
            "id",
            "eventKind",
            "nativeType",
            "subjectIds",
            "actorIds",
            "timestamp",
            "state",
            "marker",
            "option",
            "numericValue",
            "isVideo",
            "isGroup",
            "outgoing",
        ],
        DatasetKind::Channels | DatasetKind::Communities => &[
            "id",
            "entityKind",
            "displayName",
            "description",
            "membershipState",
            "verified",
            "readOnly",
            "unreadCount",
            "creationTimestamp",
        ],
        DatasetKind::CommunityRelations => &["id", "relationKind", "fromId", "toId"],
    }
}

fn ensure_allowed_fields(
    dataset: DatasetKind,
    object: &Map<String, Value>,
) -> Result<(), NormalizationError> {
    let allowed = allowed_fields(dataset);
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(invalid(dataset, format!("unexpected field {field}")));
    }
    Ok(())
}

fn required_string<'a>(
    dataset: DatasetKind,
    object: &'a Map<String, Value>,
    field: &str,
    max: usize,
) -> Result<&'a str, NormalizationError> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(dataset, format!("{field} is missing or not a string")))?;
    if value.is_empty() || value.len() > max {
        return Err(invalid(
            dataset,
            format!("{field} length is outside 1..={max}"),
        ));
    }
    Ok(value)
}

fn optional_string(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
    max: usize,
) -> Result<Option<String>, NormalizationError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= max => Ok(Some(value.clone())),
        Some(Value::String(_)) => Err(invalid(dataset, format!("{field} exceeds {max} bytes"))),
        Some(_) => Err(invalid(dataset, format!("{field} is not a string or null"))),
    }
}

fn optional_bool(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<bool>, NormalizationError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid(dataset, format!("{field} is not boolean or null"))),
    }
}

fn optional_number(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<f64>, NormalizationError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_f64()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or_else(|| invalid(dataset, format!("{field} is not finite"))),
        Some(_) => Err(invalid(dataset, format!("{field} is not numeric or null"))),
    }
}

fn optional_integer(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<i64>, NormalizationError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| invalid(dataset, format!("{field} is not a safe integer"))),
        Some(_) => Err(invalid(dataset, format!("{field} is not integer or null"))),
    }
}

fn optional_nonnegative(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<u64>, NormalizationError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| invalid(dataset, format!("{field} is not a nonnegative integer"))),
        Some(_) => Err(invalid(dataset, format!("{field} is not integer or null"))),
    }
}

fn required_nonnegative(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<u64, NormalizationError> {
    optional_nonnegative(dataset, object, field)?
        .ok_or_else(|| invalid(dataset, format!("{field} is required")))
}

fn optional_u32(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<u32>, NormalizationError> {
    optional_nonnegative(dataset, object, field)?
        .map(|value| {
            u32::try_from(value).map_err(|_| invalid(dataset, format!("{field} exceeds u32")))
        })
        .transpose()
}

fn string_array(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
    max_item: usize,
    max_items: usize,
) -> Result<Vec<String>, NormalizationError> {
    let Some(value) = object.get(field) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid(dataset, format!("{field} is not an array")))?;
    if values.len() > max_items {
        return Err(invalid(dataset, format!("{field} has too many items")));
    }
    let mut output = Vec::with_capacity(values.len());
    let mut seen = BTreeSet::new();
    for value in values {
        let item = value
            .as_str()
            .filter(|item| !item.is_empty() && item.len() <= max_item)
            .ok_or_else(|| invalid(dataset, format!("{field} contains an invalid string")))?;
        if seen.insert(item.to_owned()) {
            output.push(item.to_owned());
        }
    }
    Ok(output)
}

fn optional_history_scope(
    value: Option<&Value>,
) -> Result<HistoryCompleteness, NormalizationError> {
    match value.and_then(Value::as_str) {
        None | Some("not_run") => Ok(HistoryCompleteness::NotRun),
        Some("terminal_observed") => Ok(HistoryCompleteness::TerminalObserved),
        Some("stable_no_growth") => Ok(HistoryCompleteness::StableNoGrowth),
        Some("limit_reached") => Ok(HistoryCompleteness::LimitReached),
        Some("loader_error") => Ok(HistoryCompleteness::LoaderError),
        Some(_) => Err(invalid(DatasetKind::Chats, "invalid historyScope")),
    }
}

const fn history_scope_label(value: HistoryCompleteness) -> &'static str {
    match value {
        HistoryCompleteness::TerminalObserved => "terminal_observed",
        HistoryCompleteness::StableNoGrowth => "stable_no_growth",
        HistoryCompleteness::LimitReached => "limit_reached",
        HistoryCompleteness::LoaderError => "loader_error",
        HistoryCompleteness::NotRun => "not_run",
    }
}

fn optional_timestamp(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, NormalizationError> {
    let Some(value) = optional_integer(dataset, object, field)? else {
        return Ok(None);
    };
    Ok(Some(if value.abs() >= 10_000_000_000 {
        timestamp_to_utc_millis(value)
            .map_err(|()| invalid(dataset, format!("{field} is out of range")))?
    } else {
        timestamp_to_utc(value)
            .map_err(|()| invalid(dataset, format!("{field} is out of range")))?
    }))
}

fn optional_duration_ms(
    dataset: DatasetKind,
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<u64>, NormalizationError> {
    let Some(seconds) = optional_number(dataset, object, field)? else {
        return Ok(None);
    };
    let duration = std::time::Duration::try_from_secs_f64(seconds)
        .map_err(|_| invalid(dataset, format!("{field} is out of range")))?;
    let milliseconds = u64::try_from(duration.as_millis())
        .map_err(|_| invalid(dataset, format!("{field} is out of range")))?;
    Ok(Some(milliseconds))
}

fn optional_location(
    dataset: DatasetKind,
    object: &Map<String, Value>,
) -> Result<Option<Value>, NormalizationError> {
    let latitude = optional_number(dataset, object, "latitude")?;
    let longitude = optional_number(dataset, object, "longitude")?;
    match (latitude, longitude) {
        (None, None) => Ok(None),
        (Some(lat), Some(lng))
            if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng) =>
        {
            Ok(Some(json!({
                "latitude": lat,
                "longitude": lng,
                "name": optional_string(dataset, object, "locationName", 512)?,
                "address": optional_string(dataset, object, "locationAddress", 2048)?,
            })))
        }
        _ => Err(invalid(
            dataset,
            "location coordinates are incomplete or out of range",
        )),
    }
}

fn optional_poll(
    dataset: DatasetKind,
    object: &Map<String, Value>,
) -> Result<Option<Value>, NormalizationError> {
    let Some(name) = optional_string(dataset, object, "pollName", 4096)? else {
        return Ok(None);
    };
    let options = string_array(dataset, object, "pollOptions", 1024, 256)?;
    let selectable = optional_nonnegative(dataset, object, "pollSelectableCount")?.unwrap_or(1);
    if selectable == 0 {
        return Err(invalid(dataset, "pollSelectableCount must be positive"));
    }
    Ok(Some(json!({
        "name": name,
        "options": options,
        "selectableCount": selectable,
        "closed": optional_bool(dataset, object, "pollClosed")?,
    })))
}

fn optional_event(
    dataset: DatasetKind,
    object: &Map<String, Value>,
) -> Result<Option<Value>, NormalizationError> {
    let Some(name) = optional_string(dataset, object, "eventName", 4096)? else {
        return Ok(None);
    };
    Ok(Some(json!({
        "name": name,
        "description": optional_string(dataset, object, "eventDescription", 65_536)?,
        "startsAtUtc": optional_timestamp(dataset, object, "eventStartTimestamp")?,
        "canceled": optional_bool(dataset, object, "eventCanceled")?,
    })))
}

fn invalid(dataset: DatasetKind, reason: impl Into<String>) -> NormalizationError {
    NormalizationError::InvalidRecord {
        dataset: dataset.as_str(),
        reason: reason.into(),
    }
}

fn deterministic_record_id(source_id: Uuid, record_type: &str, native_key: &str) -> String {
    let prefix = match record_type {
        "account" => "acc",
        "contact" => "con",
        "chat" => "cht",
        "chat_list" => "lst",
        "participant" => "par",
        "message" => "msg",
        "message_event" => "mev",
        "reaction" => "rct",
        "receipt" => "rcp",
        "poll_vote" => "pvt",
        "group_event" => "gev",
        "status" => "sts",
        "call" => "cal",
        "channel" => "chn",
        "channel_event" => "cev",
        "community" => "com",
        "community_relation" => "rel",
        "presence_snapshot" => "pre",
        "asset" => "ast",
        _ => "raw",
    };
    let mut hasher = Sha256::new();
    hasher.update(b"WAEB-RECORD-ID-v1\0");
    hasher.update(source_id.as_bytes());
    hasher.update([0]);
    hasher.update(record_type.as_bytes());
    hasher.update([0]);
    hasher.update(native_key.as_bytes());
    format!("{prefix}_{}", hex::encode(hasher.finalize()))
}

fn native_identity(value: &str) -> Value {
    let kind = if value.ends_with("@lid") {
        "lid"
    } else if value.ends_with("@newsletter") {
        "newsletter"
    } else if value.ends_with("@broadcast") {
        "broadcast"
    } else if value.bytes().all(|byte| byte.is_ascii_digit()) {
        "phone"
    } else {
        "jid"
    };
    json!({"kind": kind, "opaqueValue": value})
}

fn native_identity_unknown(value: &str) -> Value {
    json!({"kind": "native_unknown", "opaqueValue": value})
}

fn message_kind(native_type: &str, subtype: Option<&str>, has_body: bool) -> &'static str {
    let lowered = native_type.to_ascii_lowercase();
    match lowered.as_str() {
        "chat" | "text" => "text",
        "image" => "image",
        "video" | "gif" => "video",
        "ptt" => "voice",
        "audio" => "audio",
        "document" => "document",
        "sticker" => "sticker",
        "vcard" | "multi_vcard" | "contact" => "contact_card",
        "location" | "live_location" => "location",
        "poll_creation" | "poll" => "poll",
        "event" => "event",
        "revoked" => "revoked",
        "call_log" => "call_event",
        value if value.contains("notification") || subtype == Some("system") => "system",
        _ if has_body => "text",
        _ => "unknown",
    }
}

fn observed_time(
    dataset: DatasetKind,
    value: Option<&Value>,
    captured_at_utc: &str,
) -> Result<Value, NormalizationError> {
    match value {
        None | Some(Value::Null) => Ok(json!({
            "utc": captured_at_utc,
            "originalValue": null,
            "originalUnit": "not_available",
            "source": "message_store",
            "precision": "unknown",
        })),
        Some(Value::Number(number)) => {
            let integer = number
                .as_i64()
                .ok_or_else(|| invalid(dataset, "timestamp is not a safe integer"))?;
            let (utc, unit, precision) = if integer.abs() >= 10_000_000_000 {
                (
                    timestamp_to_utc_millis(integer)
                        .map_err(|()| invalid(dataset, "timestamp is out of range"))?,
                    "milliseconds",
                    "millisecond",
                )
            } else {
                (
                    timestamp_to_utc(integer)
                        .map_err(|()| invalid(dataset, "timestamp is out of range"))?,
                    "seconds",
                    "second",
                )
            };
            Ok(json!({
                "utc": utc,
                "originalValue": integer.to_string(),
                "originalUnit": unit,
                "source": "message_store",
                "precision": precision,
            }))
        }
        Some(_) => Err(invalid(dataset, "timestamp has invalid type")),
    }
}

fn timestamp_to_utc(value: i64) -> Result<String, ()> {
    chrono::DateTime::<Utc>::from_timestamp(value, 0)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or(())
}

fn timestamp_to_utc_millis(value: i64) -> Result<String, ()> {
    chrono::DateTime::<Utc>::from_timestamp_millis(value)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or(())
}

fn acknowledgement_state(value: &Value) -> &'static str {
    match value.as_i64() {
        Some(value) if value < 0 => "failed",
        Some(0) => "pending",
        Some(1) => "sent",
        Some(2) => "delivered",
        Some(3) => "read",
        Some(4) => "played",
        Some(_) | None => "unknown",
    }
}

fn valid_code(value: &str) -> bool {
    (3..=100).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn compact_json_object<const N: usize>(entries: [(&str, Option<Value>); N]) -> Value {
    let mut object = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            object.insert(key.to_owned(), value);
        }
    }
    Value::Object(object)
}

fn json_number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn json_u64(value: u64) -> Value {
    Value::Number(value.into())
}

/// Detects common media formats from a bounded byte prefix.
#[must_use]
pub(crate) fn detect_media(prefix: &[u8], declared_mime: Option<&str>) -> DetectedMedia {
    let detected = if prefix.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", ".jpg"))
    } else if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", ".png"))
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        Some(("image/gif", ".gif"))
    } else if prefix.len() >= 12 && &prefix[..4] == b"RIFF" && &prefix[8..12] == b"WEBP" {
        Some(("image/webp", ".webp"))
    } else if prefix.starts_with(b"%PDF-") {
        Some(("application/pdf", ".pdf"))
    } else if prefix.starts_with(b"PK\x03\x04") {
        Some(("application/zip", ".zip"))
    } else if prefix.len() >= 12 && &prefix[4..8] == b"ftyp" {
        Some(("video/mp4", ".mp4"))
    } else if prefix.starts_with(b"OggS") {
        Some(("audio/ogg", ".ogg"))
    } else if prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Some(("video/webm", ".webm"))
    } else if prefix.len() >= 12 && &prefix[..4] == b"RIFF" && &prefix[8..12] == b"WAVE" {
        Some(("audio/wav", ".wav"))
    } else if prefix.starts_with(b"ID3") || prefix.starts_with(&[0xff, 0xfb]) {
        Some(("audio/mpeg", ".mp3"))
    } else {
        None
    };
    let (mime, extension) = detected.map_or_else(
        || {
            (
                declared_mime
                    .unwrap_or("application/octet-stream")
                    .to_owned(),
                None,
            )
        },
        |(mime, extension)| (mime.to_owned(), Some(extension.to_owned())),
    );
    DetectedMedia {
        mime,
        suggested_extension: extension,
    }
}

fn media_terminal_total(counts: &NormalizedMediaCounts) -> Option<u64> {
    [
        counts.available,
        counts.missing,
        counts.expired,
        counts.decrypt_error,
        counts.download_timeout,
        counts.no_progress_timeout,
        counts.too_large,
        counts.disk_space_insufficient,
        counts.hash_mismatch,
        counts.transport_interrupted,
        counts.canceled,
        counts.unavailable,
        counts.not_attempted,
    ]
    .into_iter()
    .try_fold(0_u64, u64::checked_add)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_magic_is_host_determined() {
        assert_eq!(
            detect_media(b"\x89PNG\r\n\x1a\nrest", Some("text/plain")),
            DetectedMedia {
                mime: "image/png".to_owned(),
                suggested_extension: Some(".png".to_owned())
            }
        );
        assert_eq!(
            detect_media(b"unknown", Some("application/custom")),
            DetectedMedia {
                mime: "application/custom".to_owned(),
                suggested_extension: None
            }
        );
    }

    #[test]
    fn message_omission_reasons_are_explicitly_allowlisted() {
        assert!(is_supported_message_reason_code(
            "message_model_fields_unavailable"
        ));
        assert!(is_supported_message_reason_code(
            "media_inline_preview_omitted"
        ));
        assert!(!is_supported_message_reason_code(
            "arbitrary_page_supplied_reason"
        ));
    }

    #[test]
    fn unknown_fields_are_rejected_for_every_dataset_family() {
        let value = json!({"id":"one@s.whatsapp.net", "mediaKey":"secret"});
        let object = value.as_object().unwrap_or_else(|| panic!("object"));
        for dataset in DatasetKind::ALL {
            assert!(ensure_allowed_fields(dataset, object).is_err());
        }
    }

    #[test]
    fn deterministic_ids_are_source_scoped() {
        let source = Uuid::nil();
        let left = deterministic_record_id(source, "message", "native");
        let right = deterministic_record_id(source, "message", "native");
        let other = deterministic_record_id(Uuid::from_u128(1), "message", "native");
        assert_eq!(left, right);
        assert_ne!(left, other);
    }

    #[test]
    fn status_broadcast_container_is_not_emitted_as_a_contact_recipient() {
        let source_id = Uuid::new_v4();
        let mut normalizer =
            Normalizer::new(source_id, NormalizationMode::ComprehensiveReadonlyV02);
        normalizer.self_native_id = Some("self@c.us".to_owned());
        let status = json!({
            "id": "status-native-id",
            "chatId": "status@broadcast",
            "senderId": "self@c.us",
            "recipientId": "status@broadcast",
            "fromMe": true,
        });
        let parties = normalizer
            .message_parties(
                DatasetKind::Statuses,
                status
                    .as_object()
                    .unwrap_or_else(|| panic!("status object")),
                "status@broadcast",
            )
            .unwrap_or_else(|error| panic!("status parties: {error}"));

        assert_eq!(
            parties.sender_id,
            Some(deterministic_record_id(source_id, "account", "self@c.us"))
        );
        assert!(parties.recipient_ids.is_empty());
        assert!(
            !normalizer.referenced_ids.contains(&deterministic_record_id(
                source_id,
                "contact",
                "status@broadcast"
            ))
        );
    }

    #[test]
    fn unresolved_reference_closure_fails_before_media_and_sealing() {
        let mut normalizer =
            Normalizer::new(Uuid::new_v4(), NormalizationMode::ComprehensiveReadonlyV02);
        normalizer
            .referenced_ids
            .insert("missing-reference".to_owned());
        assert!(matches!(
            normalizer.validate_reference_closure(),
            Err(NormalizationError::UnresolvedReferences(1))
        ));
    }

    #[test]
    fn materialized_account_and_contact_identity_fields_are_preserved() {
        let account = json!({
            "id": "self@c.us",
            "displayName": "Field Account",
            "isBusiness": true,
            "isEnterprise": false,
            "verifiedName": "Verified Field Account",
        });
        let account_object = account
            .as_object()
            .unwrap_or_else(|| panic!("account object"));
        ensure_allowed_fields(DatasetKind::Accounts, account_object)
            .unwrap_or_else(|error| panic!("account fields: {error}"));
        let account_data = Normalizer::account_data(account_object, "self@c.us", &[])
            .unwrap_or_else(|error| panic!("account data: {error}"));
        assert_eq!(account_data["verifiedName"], "Verified Field Account");
        assert_eq!(account_data["accountKind"], "business");

        let contact = json!({
            "id": "contact@c.us",
            "formattedName": "Contact",
            "isWhatsAppContact": true,
            "isMyContact": true,
            "about": "Materialized About",
            "verifiedName": "Verified Contact",
            "isVerified": true,
            "isDeactivated": false,
        });
        let contact_object = contact
            .as_object()
            .unwrap_or_else(|| panic!("contact object"));
        ensure_allowed_fields(DatasetKind::Contacts, contact_object)
            .unwrap_or_else(|error| panic!("contact fields: {error}"));
        let normalizer = Normalizer::new(Uuid::nil(), NormalizationMode::ComprehensiveReadonlyV02);
        let contact_data = normalizer
            .contact_data(contact_object, "contact@c.us", &[])
            .unwrap_or_else(|error| panic!("contact data: {error}"));
        assert_eq!(contact_data["about"], "Materialized About");
        assert_eq!(contact_data["displayNames"]["verified"], "Verified Contact");
        assert_eq!(contact_data["isVerified"], true);
        assert_eq!(contact_data["isDeactivated"], false);
    }

    #[test]
    fn profile_avatar_is_linked_to_the_normalized_account_before_streaming() {
        let source_id = Uuid::new_v4();
        let evidence_id = Uuid::new_v4();
        let base = std::env::temp_dir().join(format!("wafc-avatar-normalize-{evidence_id}"));
        std::fs::create_dir(&base).unwrap_or_else(|error| panic!("test base: {error}"));

        {
            let mut writer = WaebWriter::create(&base, evidence_id)
                .unwrap_or_else(|error| panic!("writer: {error}"));
            let mut normalizer =
                Normalizer::new(source_id, NormalizationMode::ComprehensiveReadonlyV02);
            normalizer
                .ingest_batch(
                    DatasetKind::Accounts,
                    &[json!({
                        "id": "self@c.us",
                        "displayName": "Field Account",
                        "profileImageAvailable": true,
                    })],
                    "2026-08-09T00:00:00.000Z",
                    &mut writer,
                )
                .unwrap_or_else(|error| panic!("ingest account: {error}"));

            let asset_key = "account:self@c.us:avatar";
            let expected_asset_id = deterministic_record_id(source_id, "asset", asset_key);
            let accounts_path = writer
                .staging_path()
                .join("data/normalized/accounts.ndjson");
            let account_line = std::fs::read_to_string(accounts_path)
                .unwrap_or_else(|error| panic!("read account: {error}"));
            let envelope: Value = serde_json::from_str(account_line.trim())
                .unwrap_or_else(|error| panic!("parse account: {error}"));
            assert_eq!(
                envelope["data"]["profileAssetIds"],
                json!([expected_asset_id.clone()])
            );
            assert_eq!(normalizer.summary().media.requested, 1);

            let binding = normalizer
                .begin_media(&MediaStartPayload {
                    asset_key: asset_key.to_owned(),
                    role: "avatar".to_owned(),
                    kind: "image".to_owned(),
                    declared_mime: Some("image/png".to_owned()),
                    original_file_name: None,
                    expected_size: Some(8),
                    width: None,
                    height: None,
                    duration_ms: None,
                    method: "cache_lookup".to_owned(),
                    attempts: 0,
                    network_action_attempted: false,
                })
                .unwrap_or_else(|error| panic!("begin avatar: {error}"));
            assert_eq!(binding.asset_id, expected_asset_id);
            assert_eq!(binding.role, "avatar");

            let asset = MediaAsset {
                relative_path: format!("data/media/sha256/00/{}", "0".repeat(64)),
                sha256: "0".repeat(64),
                sha512: "0".repeat(128),
                byte_length: 8,
                deduplicated: false,
            };
            let detected = DetectedMedia {
                mime: "image/png".to_owned(),
                suggested_extension: Some(".png".to_owned()),
            };
            normalizer
                .finish_media(
                    &binding,
                    &MediaEndPayload {
                        asset_key: asset_key.to_owned(),
                        status: "available".to_owned(),
                        total_bytes: 8,
                        error_code: None,
                        captured_at_utc: Some("2026-08-09T00:00:01.000Z".to_owned()),
                        method: "media_download".to_owned(),
                        attempts: 1,
                        network_action_attempted: true,
                    },
                    Some(&asset),
                    Some(&detected),
                    &mut writer,
                )
                .unwrap_or_else(|error| panic!("finish avatar: {error}"));
            let media = normalizer.summary().media;
            assert_eq!(media.available, 1);
            assert_eq!(media.full, 0, "an avatar is not a full attachment");
            assert_eq!(media.thumbnail, 0);
        }

        std::fs::remove_dir_all(&base).unwrap_or_else(|error| panic!("remove test base: {error}"));
    }

    #[test]
    fn materialized_membership_entity_call_and_presence_details_are_preserved() {
        let mut normalizer =
            Normalizer::new(Uuid::nil(), NormalizationMode::ComprehensiveReadonlyV02);
        normalizer.self_native_id = Some("self@c.us".to_owned());

        let participant = json!({
            "id": "group@g.us:participant:former@c.us",
            "containerId": "group@g.us",
            "subjectId": "former@c.us",
            "role": "member",
            "membershipState": "removed",
            "joinedTimestamp": null,
            "leftTimestamp": 1_660_000_000,
        });
        let participant_data = normalizer
            .participant_data(
                participant
                    .as_object()
                    .unwrap_or_else(|| panic!("participant object")),
            )
            .unwrap_or_else(|error| panic!("participant data: {error}"));
        assert_eq!(participant_data["membershipState"], "removed");
        assert_eq!(participant_data["leftAtUtc"], "2022-08-08T23:06:40.000Z");

        let channel = json!({
            "id": "120363000000001@newsletter",
            "entityKind": "channel",
            "displayName": "Observed Channel",
            "description": "Observed Description",
            "membershipState": "active",
            "verified": true,
            "readOnly": true,
            "unreadCount": 3,
            "creationTimestamp": 1_630_000_000,
        });
        let channel_data = normalizer
            .entity_data(
                DatasetKind::Channels,
                channel
                    .as_object()
                    .unwrap_or_else(|| panic!("channel object")),
                "120363000000001@newsletter",
            )
            .unwrap_or_else(|error| panic!("channel data: {error}"));
        assert_eq!(channel_data["displayName"], "Observed Channel");
        assert_eq!(
            channel_data["state"]["org.whatsapp-forensics.wafc"]["unreadCount"],
            3
        );

        let call = json!({
            "id": "call-1",
            "eventKind": "call",
            "nativeType": "ended",
            "subjectIds": ["peer@c.us"],
            "actorIds": ["participant@c.us"],
            "timestamp": 1_700_000_000,
            "state": "ended",
            "numericValue": 42,
            "isVideo": true,
            "isGroup": true,
            "outgoing": false,
        });
        let call_data = normalizer
            .event_data(
                DatasetKind::Calls,
                call.as_object().unwrap_or_else(|| panic!("call object")),
                "2026-08-09T00:00:00.000Z",
            )
            .unwrap_or_else(|error| panic!("call data: {error}"));
        assert_eq!(
            call_data["details"]["org.whatsapp-forensics.wafc"]["numericValue"].as_f64(),
            Some(42.0)
        );
        assert_eq!(
            call_data["details"]["org.whatsapp-forensics.wafc"]["isGroup"],
            true
        );

        let presence = json!({
            "id": "contact@c.us:chatstate:composing:1700000010",
            "eventKind": "presence_snapshot",
            "nativeType": "chatstate",
            "subjectIds": ["contact@c.us"],
            "actorIds": [],
            "timestamp": 1_700_000_010,
            "state": "composing",
        });
        let presence_data = normalizer
            .event_data(
                DatasetKind::PresenceSnapshots,
                presence
                    .as_object()
                    .unwrap_or_else(|| panic!("presence object")),
                "2026-08-09T00:00:00.000Z",
            )
            .unwrap_or_else(|error| panic!("presence data: {error}"));
        assert_eq!(
            presence_data["details"]["org.whatsapp-forensics.wafc"]["state"],
            "composing"
        );
    }

    #[test]
    fn encrypted_checkpoint_state_round_trips_and_rejects_count_tamper() {
        let source_id = Uuid::new_v4();
        let mut normalizer =
            Normalizer::new(source_id, NormalizationMode::ComprehensiveReadonlyV02);
        let record_id = "a".repeat(64);
        normalizer.seen_record_ids.insert(record_id.clone());
        normalizer.observed_reference_ids.insert(record_id);
        normalizer.counts.insert("accounts".to_owned(), 1);

        let checkpoint = normalizer.checkpoint();
        let restored = Normalizer::restore(
            checkpoint.clone(),
            source_id,
            NormalizationMode::ComprehensiveReadonlyV02,
        )
        .unwrap_or_else(|error| panic!("restore: {error}"));
        assert_eq!(restored.summary(), normalizer.summary());

        let mut tampered = checkpoint;
        tampered.counts.insert("accounts".to_owned(), 2);
        assert!(matches!(
            Normalizer::restore(
                tampered,
                source_id,
                NormalizationMode::ComprehensiveReadonlyV02
            ),
            Err(NormalizationError::InvalidCheckpoint)
        ));
    }
}
