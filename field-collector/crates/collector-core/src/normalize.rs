//! Deterministic conversion from the page whitelist to WAEB v1 envelopes.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{SecondsFormat, Utc};
use page_bridge::DatasetKind;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use waeb_writer::{
    RawPhase, RawProvider, RawStream, SCHEMA_VERSION, WaebError, WaebWriter, canonicalize,
    sha256_hex,
};

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
    /// The WAEB streaming writer rejected the record.
    #[error(transparent)]
    Writer(#[from] WaebError),
}

/// Counts and reference checks produced by host-side normalization.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NormalizationSummary {
    /// Accepted normalized records per dataset.
    pub record_counts: BTreeMap<String, u64>,
    /// References whose targets were not part of the passive snapshot.
    pub unresolved_reference_count: usize,
    /// Message records that advertised media while T0 intentionally skipped bytes.
    pub media_not_requested_count: u64,
}

/// Stateful normalizer for exactly one source/acquisition.
pub(crate) struct Normalizer {
    source_id: Uuid,
    self_native_id: Option<String>,
    seen_record_ids: BTreeSet<String>,
    observed_reference_ids: BTreeSet<String>,
    referenced_ids: BTreeSet<String>,
    counts: BTreeMap<String, u64>,
    media_not_requested_count: u64,
    chat_stats: BTreeMap<String, ChatObservation>,
}

#[derive(Clone, Debug, Default)]
struct ChatObservation {
    message_count: u64,
    earliest_utc: Option<String>,
    latest_utc: Option<String>,
}

struct MessageParties {
    from_me: bool,
    sender_id: Option<String>,
    author_id: Option<String>,
    recipient_ids: Vec<String>,
}

type MediaObservation = (Vec<String>, Vec<&'static str>, Option<Value>);

impl Normalizer {
    pub(crate) fn new(source_id: Uuid) -> Self {
        Self {
            source_id,
            self_native_id: None,
            seen_record_ids: BTreeSet::new(),
            observed_reference_ids: BTreeSet::new(),
            referenced_ids: BTreeSet::new(),
            counts: BTreeMap::new(),
            media_not_requested_count: 0,
            chat_stats: BTreeMap::new(),
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
        let unresolved_reference_count = self
            .referenced_ids
            .difference(&self.observed_reference_ids)
            .count();
        NormalizationSummary {
            record_counts: self.counts.clone(),
            unresolved_reference_count,
            media_not_requested_count: self.media_not_requested_count,
        }
    }

    pub(crate) fn write_chat_completeness(
        &self,
        writer: &mut WaebWriter,
    ) -> Result<(), NormalizationError> {
        for (chat_record_id, observation) in &self.chat_stats {
            writer.append_chat_completeness(&json!({
                "schemaVersion": SCHEMA_VERSION,
                "sourceId": self.source_id,
                "chatRecordId": chat_record_id,
                "discoverySources": ["store"],
                "initialMessageCount": observation.message_count,
                "finalMessageCount": observation.message_count,
                "historyScope": "not_run",
                "loadMethod": "none",
                "rounds": 0,
                "returnedCount": 0,
                "newCount": 0,
                "emptyRounds": 0,
                "stagnantRounds": 0,
                "earliestObservedAtUtc": observation.earliest_utc,
                "latestObservedAtUtc": observation.latest_utc,
                "terminationEvidence": null,
                "reasonCodes": ["history_not_requested"],
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
        let (dataset_name, record_type, raw_stream, raw_path) = dataset_metadata(dataset);
        let raw_id = deterministic_record_id(
            self.source_id,
            "raw",
            &format!("{dataset_name}\0{native_id}"),
        );
        let raw_hash = sha256_hex(&canonicalize(value)?);
        let native_type = if dataset == DatasetKind::Messages {
            optional_string(dataset, object, "type", 160)?.unwrap_or_else(|| "unknown".to_owned())
        } else {
            dataset_name.to_owned()
        };
        let raw = json!({
            "schemaVersion": SCHEMA_VERSION,
            "recordId": raw_id,
            "provider": "store",
            "phase": "baseline",
            "capturedAtUtc": captured_at_utc,
            "nativeType": native_type,
            "value": value,
            "omittedFields": OMITTED_FIELDS,
            "contentSha256": raw_hash,
        });
        writer.append_raw(RawPhase::Baseline, RawProvider::Store, raw_stream, &raw)?;

        let record_id = deterministic_record_id(self.source_id, record_type, native_id);
        if !self.seen_record_ids.insert(record_id.clone()) {
            return Err(NormalizationError::DuplicateRecord(record_id));
        }
        let (data, media_index) = match dataset {
            DatasetKind::Accounts => (Self::account_data(object, native_id)?, None),
            DatasetKind::Contacts => (self.contact_data(object, native_id)?, None),
            DatasetKind::Chats => (Self::chat_data(object, native_id, captured_at_utc)?, None),
            DatasetKind::Messages => {
                self.message_data(object, native_id, &record_id, captured_at_utc)?
            }
        };
        let content_hash = sha256_hex(&canonicalize(&data)?);
        let envelope = json!({
            "schemaVersion": SCHEMA_VERSION,
            "recordType": record_type,
            "recordId": record_id,
            "sourceId": self.source_id,
            "capturedAtUtc": captured_at_utc,
            "provenance": [{
                "provider": "store",
                "phase": "baseline",
                "rawRef": {
                    "path": raw_path,
                    "recordId": raw_id,
                    "contentSha256": raw_hash,
                }
            }],
            "contentSha256": content_hash,
            "data": data,
        });
        writer.append_normalized(dataset_name, &envelope)?;
        if let Some(media_record) = media_index {
            writer.append_media_index(&media_record)?;
        }
        *self.counts.entry(dataset_name.to_owned()).or_default() += 1;

        if dataset == DatasetKind::Chats {
            self.chat_stats.entry(record_id.clone()).or_default();
        }
        if dataset != DatasetKind::Messages {
            self.observed_reference_ids.insert(record_id);
        }
        if dataset == DatasetKind::Accounts && self.self_native_id.is_none() {
            self.self_native_id = Some(native_id.to_owned());
        }
        Ok(())
    }

    fn account_data(
        object: &Map<String, Value>,
        native_id: &str,
    ) -> Result<Value, NormalizationError> {
        let business = optional_bool(DatasetKind::Accounts, object, "isBusiness")?.unwrap_or(false);
        Ok(json!({
            "nativeIdentities": [native_identity(native_id)],
            "displayName": optional_string(DatasetKind::Accounts, object, "displayName", 512)?,
            "accountKind": if business { "business" } else { "consumer" },
            "isBusiness": business,
            "verifiedName": null,
            "profileAssetIds": [],
            "observedDevice": {"deviceId": null, "isCompanion": true},
        }))
    }

    fn contact_data(
        &self,
        object: &Map<String, Value>,
        native_id: &str,
    ) -> Result<Value, NormalizationError> {
        let formatted = optional_string(DatasetKind::Contacts, object, "formattedName", 512)?
            .or(optional_string(DatasetKind::Contacts, object, "name", 512)?);
        Ok(json!({
            "nativeIdentities": [native_identity(native_id)],
            "displayNames": {
                "formatted": formatted,
                "push": optional_string(DatasetKind::Contacts, object, "pushName", 512)?,
                "short": optional_string(DatasetKind::Contacts, object, "shortName", 512)?,
                "verified": null,
            },
            "about": null,
            "isSelf": self.self_native_id.as_deref() == Some(native_id),
            "isAddressBookContact": optional_bool(DatasetKind::Contacts, object, "isMyContact")?.unwrap_or(false),
            "isWhatsAppUser": optional_bool(DatasetKind::Contacts, object, "isWhatsAppContact")?.unwrap_or(false),
            "isVerified": false,
            "isDeactivated": null,
            "profileAssetIds": [],
        }))
    }

    fn chat_data(
        object: &Map<String, Value>,
        native_id: &str,
        captured_at_utc: &str,
    ) -> Result<Value, NormalizationError> {
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
            .and_then(|value| timestamp_to_utc(value, captured_at_utc).ok())
            .filter(|_| {
                optional_integer(DatasetKind::Chats, object, "muteExpiration")
                    .ok()
                    .flatten()
                    .unwrap_or(0)
                    > 0
            });
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
            "ephemeral": {"enabled": false, "durationSeconds": null},
            "firstObservedAtUtc": captured_at_utc,
            "lastObservedAtUtc": captured_at_utc,
        }))
    }

    fn message_data(
        &mut self,
        object: &Map<String, Value>,
        native_id: &str,
        message_record_id: &str,
        captured_at_utc: &str,
    ) -> Result<(Value, Option<Value>), NormalizationError> {
        let dataset = DatasetKind::Messages;
        let chat_native = required_string(dataset, object, "chatId", 512)?;
        let chat_id = deterministic_record_id(self.source_id, "chat", chat_native);
        self.referenced_ids.insert(chat_id.clone());

        let parties = self.message_parties(object)?;
        let from_me = parties.from_me;
        let sender_id = parties.sender_id;
        let author_id = parties.author_id;
        let recipient_ids = parties.recipient_ids;

        let native_type =
            optional_string(dataset, object, "type", 160)?.unwrap_or_else(|| "unknown".to_owned());
        let subtype = optional_string(dataset, object, "subtype", 160)?;
        let body = optional_string(dataset, object, "body", 1_048_576)?;
        let kind = message_kind(&native_type, subtype.as_deref(), body.is_some());
        let sent_at = observed_time(object.get("timestamp"), captured_at_utc)?;
        self.record_chat_observation(&chat_id, &sent_at);
        let quoted =
            optional_string(dataset, object, "quotedMessageId", 512)?.map(|quoted_native| {
                let quoted_id = deterministic_record_id(self.source_id, "message", &quoted_native);
                json!({
                    "resolution": "unresolved",
                    "messageRecordId": quoted_id,
                    "nativeIdentity": native_identity_unknown(&quoted_native),
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
        let (attachment_asset_ids, unsupported, media_index) =
            self.message_media_observation(object, native_id, message_record_id, kind)?;
        let data = json!({
            "nativeIdentity": native_identity_unknown(native_id),
            "container": {"kind": "chat", "recordId": chat_id},
            "senderRecordId": sender_id,
            "recipientRecordIds": recipient_ids,
            "authorRecordId": author_id,
            "sentAt": sent_at,
            "kind": kind,
            "nativeType": native_type,
            "text": body,
            "caption": optional_string(dataset, object, "caption", 1_048_576)?,
            "quoted": quoted,
            "mentionRecordIds": [],
            "flags": {
                "fromMe": from_me,
                "forwarded": optional_bool(dataset, object, "isForwarded")?.unwrap_or(false),
                "starred": optional_bool(dataset, object, "isStarred")?.unwrap_or(false),
                "edited": optional_bool(dataset, object, "isEdited")?.unwrap_or(false),
                "revoked": optional_bool(dataset, object, "isRevoked")?.unwrap_or(false),
                "viewOnce": optional_bool(dataset, object, "isViewOnce")?.unwrap_or(false),
                "ephemeral": false,
            },
            "acknowledgement": {
                "state": acknowledgement_state(&acknowledgement),
                "nativeValue": acknowledgement,
            },
            "attachmentAssetIds": attachment_asset_ids,
            "location": null,
            "poll": null,
            "event": null,
            "unsupportedReasonCodes": unsupported,
        });
        Ok((data, media_index))
    }

    fn message_parties(
        &mut self,
        object: &Map<String, Value>,
    ) -> Result<MessageParties, NormalizationError> {
        let dataset = DatasetKind::Messages;
        let from_me = optional_bool(dataset, object, "fromMe")?.unwrap_or(false);
        let sender_native = optional_string(dataset, object, "senderId", 512)?
            .or(optional_string(dataset, object, "authorId", 512)?);
        let sender_id = if from_me {
            self.self_native_id
                .as_deref()
                .map(|native| deterministic_record_id(self.source_id, "account", native))
        } else {
            sender_native
                .as_deref()
                .map(|native| deterministic_record_id(self.source_id, "contact", native))
        };
        if let Some(reference) = &sender_id {
            self.referenced_ids.insert(reference.clone());
        }
        let author_id = optional_string(dataset, object, "authorId", 512)?
            .map(|native| deterministic_record_id(self.source_id, "contact", &native));
        if let Some(reference) = &author_id {
            self.referenced_ids.insert(reference.clone());
        }
        let recipient_ids = optional_string(dataset, object, "recipientId", 512)?
            .map(|native| {
                let record_type = if self.self_native_id.as_deref() == Some(native.as_str()) {
                    "account"
                } else {
                    "contact"
                };
                deterministic_record_id(self.source_id, record_type, &native)
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

    fn message_media_observation(
        &mut self,
        object: &Map<String, Value>,
        native_id: &str,
        message_record_id: &str,
        message_kind: &str,
    ) -> Result<MediaObservation, NormalizationError> {
        let dataset = DatasetKind::Messages;
        let reports_media = optional_bool(dataset, object, "hasMedia")?.unwrap_or(false);
        let kind = match message_kind {
            "image" | "video" | "audio" | "voice" | "document" | "sticker" | "contact_card" => {
                message_kind
            }
            _ if reports_media => "other",
            _ => return Ok((Vec::new(), Vec::new(), None)),
        };
        let asset_id =
            deterministic_record_id(self.source_id, "asset", &format!("{native_id}\0full"));
        let media_record = json!({
            "schemaVersion": SCHEMA_VERSION,
            "assetId": asset_id,
            "sourceId": self.source_id,
            "sourceRecordIds": [message_record_id],
            "role": "full",
            "kind": kind,
            "acquisitionStatus": "not_requested",
            "cas": null,
            "declaredMime": optional_string(dataset, object, "mediaMimeType", 160)?,
            "detectedMime": null,
            "detector": null,
            "suggestedExtension": null,
            "originalFileName": null,
            "relatedAssetIds": [],
            "acquisition": {
                "method": "not_attempted",
                "attempts": 0,
                "capturedAtUtc": null,
                "errorCode": null,
            },
        });
        self.media_not_requested_count += 1;
        let mut reasons = vec!["media_not_requested_t0"];
        if !reports_media {
            reasons.push("media_metadata_not_observable_t0");
        }
        Ok((vec![asset_id], reasons, Some(media_record)))
    }
}

fn dataset_metadata(dataset: DatasetKind) -> (&'static str, &'static str, RawStream, &'static str) {
    match dataset {
        DatasetKind::Accounts => (
            "accounts",
            "account",
            RawStream::Accounts,
            "data/raw/baseline/store/accounts.ndjson",
        ),
        DatasetKind::Contacts => (
            "contacts",
            "contact",
            RawStream::Contacts,
            "data/raw/baseline/store/contacts.ndjson",
        ),
        DatasetKind::Chats => (
            "chats",
            "chat",
            RawStream::Chats,
            "data/raw/baseline/store/chats.ndjson",
        ),
        DatasetKind::Messages => (
            "messages",
            "message",
            RawStream::Messages,
            "data/raw/baseline/store/messages.ndjson",
        ),
    }
}

fn allowed_fields(dataset: DatasetKind) -> &'static [&'static str] {
    match dataset {
        DatasetKind::Accounts => &["id", "displayName", "isBusiness", "isEnterprise"],
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
        ],
        DatasetKind::Messages => &[
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
        ],
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

fn invalid(dataset: DatasetKind, reason: impl Into<String>) -> NormalizationError {
    NormalizationError::InvalidRecord {
        dataset: match dataset {
            DatasetKind::Accounts => "accounts",
            DatasetKind::Contacts => "contacts",
            DatasetKind::Chats => "chats",
            DatasetKind::Messages => "messages",
        },
        reason: reason.into(),
    }
}

fn deterministic_record_id(source_id: Uuid, record_type: &str, native_key: &str) -> String {
    let prefix = match record_type {
        "account" => "acc",
        "contact" => "con",
        "chat" => "cht",
        "message" => "msg",
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
                .ok_or_else(|| invalid(DatasetKind::Messages, "timestamp is not a safe integer"))?;
            let (utc, unit, precision) = if integer.abs() >= 10_000_000_000 {
                (
                    timestamp_to_utc_millis(integer, captured_at_utc)?,
                    "milliseconds",
                    "millisecond",
                )
            } else {
                (
                    timestamp_to_utc(integer, captured_at_utc)?,
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
        Some(_) => Err(invalid(DatasetKind::Messages, "timestamp has invalid type")),
    }
}

fn timestamp_to_utc(value: i64, _fallback: &str) -> Result<String, NormalizationError> {
    chrono::DateTime::<Utc>::from_timestamp(value, 0)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| invalid(DatasetKind::Messages, "timestamp is out of range"))
}

fn timestamp_to_utc_millis(value: i64, _fallback: &str) -> Result<String, NormalizationError> {
    chrono::DateTime::<Utc>::from_timestamp_millis(value)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| invalid(DatasetKind::Messages, "timestamp is out of range"))
}

fn acknowledgement_state(value: &Value) -> &'static str {
    match value.as_i64() {
        Some(value) if value < 0 => "failed",
        Some(0) => "pending",
        Some(1) => "sent",
        Some(2) => "delivered",
        Some(3) => "read",
        Some(4) => "played",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_ids_are_stable_and_do_not_disclose_native_key() {
        let source = Uuid::parse_str("22222222-2222-4222-8222-222222222222");
        assert!(source.is_ok());
        let source = match source {
            Ok(value) => value,
            Err(error) => panic!("UUID parse failed: {error}"),
        };
        let first = deterministic_record_id(source, "message", "123456789@s.whatsapp.net");
        let second = deterministic_record_id(source, "message", "123456789@s.whatsapp.net");
        assert_eq!(first, second);
        assert!(first.starts_with("msg_"));
        assert!(!first.contains("123456789"));
    }

    #[test]
    fn page_whitelist_rejects_secret_fields() {
        let value = json!({"id":"one@s.whatsapp.net", "mediaKey":"secret"});
        let object = value.as_object();
        assert!(object.is_some());
        if let Some(object) = object {
            assert!(ensure_allowed_fields(DatasetKind::Contacts, object).is_err());
        }
    }

    #[test]
    fn timestamps_preserve_original_unit() {
        let seconds = observed_time(Some(&json!(1_768_464_002_i64)), "2026-01-15T08:00:03.000Z");
        assert!(seconds.is_ok());
        if let Ok(value) = seconds {
            assert_eq!(value["originalUnit"], "seconds");
        }
        let millis = observed_time(
            Some(&json!(1_768_464_002_123_i64)),
            "2026-01-15T08:00:03.000Z",
        );
        assert!(millis.is_ok());
        if let Ok(value) = millis {
            assert_eq!(value["originalUnit"], "milliseconds");
        }
    }

    #[test]
    fn native_media_type_is_indexed_even_when_metadata_flag_is_missing() {
        let source = Uuid::parse_str("22222222-2222-4222-8222-222222222222");
        assert!(source.is_ok());
        let source = match source {
            Ok(value) => value,
            Err(error) => panic!("UUID parse failed: {error}"),
        };
        let mut normalizer = Normalizer::new(source);
        let record = json!({"hasMedia": false, "mediaMimeType": null});
        let object = record.as_object();
        assert!(object.is_some());
        if let Some(object) = object {
            let observed = normalizer.message_media_observation(
                object,
                "native-message-id",
                "msg_00000000",
                "image",
            );
            assert!(observed.is_ok());
            if let Ok((asset_ids, reasons, media)) = observed {
                assert_eq!(asset_ids.len(), 1);
                assert!(asset_ids[0].starts_with("ast_"));
                assert!(reasons.contains(&"media_not_requested_t0"));
                assert!(reasons.contains(&"media_metadata_not_observable_t0"));
                assert_eq!(
                    media.as_ref().map(|value| &value["kind"]),
                    Some(&json!("image"))
                );
            }
        }
    }
}
