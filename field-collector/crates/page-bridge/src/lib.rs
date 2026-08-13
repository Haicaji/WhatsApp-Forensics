//! Strict, bounded DTOs for the pull-based Main World collector bridge.
//!
//! The page owns at most one unacknowledged frame. The native host validates
//! every frame before acknowledging it; a repeated `next()` or `ack()` is
//! therefore safe and deterministic.

use std::fmt;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Wire protocol identifier used by both the host and injected controller.
pub const PROTOCOL: &str = "wafc-bridge/2";
/// Controller version paired with this host implementation.
pub const CONTROLLER_VERSION: &str = "0.2.5";
/// Maximum decoded payload size of a control frame.
pub const MAX_CONTROL_BYTES: usize = 64 * 1024;
/// Maximum decoded payload size of a record or media frame.
pub const MAX_DATA_FRAME_BYTES: usize = 256 * 1024;
/// Maximum records carried by one record frame.
pub const MAX_RECORDS_PER_FRAME: usize = 256;
/// Maximum decoded bytes retained in the page-side ready queue.
pub const MAX_QUEUE_BYTES: usize = 2 * 1024 * 1024;

/// Canonical, unsigned decimal sequence number.
///
/// The JSON representation is a string so JavaScript never loses integer
/// precision. Only `"0"` or a non-zero digit followed by digits is accepted.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DecimalSequence(u64);

impl DecimalSequence {
    /// Creates a sequence number.
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// Returns the numeric value after canonical decimal parsing.
    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }
}

impl fmt::Display for DecimalSequence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

impl Serialize for DecimalSequence {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for DecimalSequence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        if raw.is_empty()
            || (raw.len() > 1 && raw.starts_with('0'))
            || !raw.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(de::Error::custom(
                "sequence must be canonical unsigned decimal",
            ));
        }
        raw.parse::<u64>()
            .map(Self)
            .map_err(|_| de::Error::custom("sequence exceeds u64"))
    }
}

/// Logical stream carrying the frame.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    /// Protocol status and stream boundary messages.
    Control,
    /// Normalized JSON record batches.
    Record,
    /// Binary media chunks.
    Media,
}

/// Semantic kind of a bridge frame.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameKind {
    /// Capability/build probe result.
    ProbeResult,
    /// Start of a T0 snapshot stream.
    StreamStart,
    /// A normalized record batch.
    Records,
    /// A binary media chunk.
    MediaChunk,
    /// Bounded acquisition progress without evidence content.
    Progress,
    /// Start one media asset byte stream.
    MediaStart,
    /// Finish one media asset byte stream or record its fixed failure state.
    MediaEnd,
    /// Successful end of a stream.
    StreamEnd,
    /// Fail-closed diagnostic.
    Error,
    /// Explicit cancellation notice.
    Cancelled,
}

/// Payload transport encoding.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadEncoding {
    /// UTF-8 JSON text.
    Utf8Json,
    /// Canonical padded RFC 4648 Base64.
    Base64,
}

/// Fixed WAEB v1 dataset names supported by the read-only adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetKind {
    /// The currently logged-in account.
    Accounts,
    /// Locally observable contacts.
    Contacts,
    /// Locally observable chats.
    Chats,
    /// Observable favorite/custom chat lists.
    ChatLists,
    /// Group, channel, or community participant relations.
    Participants,
    /// Locally observable messages.
    Messages,
    /// Edit/revoke/protocol events derived from messages.
    MessageEvents,
    /// Reactions to messages.
    Reactions,
    /// Delivery/read/play receipts.
    Receipts,
    /// Poll vote observations.
    PollVotes,
    /// Group membership/subject events.
    GroupEvents,
    /// Status message observations.
    Statuses,
    /// Call observations.
    Calls,
    /// Newsletter/channel entities.
    Channels,
    /// Newsletter/channel message observations.
    ChannelEvents,
    /// Community entities.
    Communities,
    /// Community parent/child relations.
    CommunityRelations,
    /// Presence state observed at acquisition time.
    PresenceSnapshots,
}

impl DatasetKind {
    /// Stable WAEB dataset name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accounts => "accounts",
            Self::Contacts => "contacts",
            Self::Chats => "chats",
            Self::ChatLists => "chat_lists",
            Self::Participants => "participants",
            Self::Messages => "messages",
            Self::MessageEvents => "message_events",
            Self::Reactions => "reactions",
            Self::Receipts => "receipts",
            Self::PollVotes => "poll_votes",
            Self::GroupEvents => "group_events",
            Self::Statuses => "statuses",
            Self::Calls => "calls",
            Self::Channels => "channels",
            Self::ChannelEvents => "channel_events",
            Self::Communities => "communities",
            Self::CommunityRelations => "community_relations",
            Self::PresenceSnapshots => "presence_snapshots",
        }
    }

    /// Dataset order frozen by WAEB v1.
    pub const ALL: [Self; 18] = [
        Self::Accounts,
        Self::Contacts,
        Self::Chats,
        Self::ChatLists,
        Self::Participants,
        Self::Messages,
        Self::MessageEvents,
        Self::Reactions,
        Self::Receipts,
        Self::PollVotes,
        Self::GroupEvents,
        Self::Statuses,
        Self::Calls,
        Self::Channels,
        Self::ChannelEvents,
        Self::Communities,
        Self::CommunityRelations,
        Self::PresenceSnapshots,
    ];
}

/// A strict frame transferred from the injected controller to the host.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    /// Exact protocol identifier.
    pub protocol: String,
    /// Opaque per-controller session identifier.
    pub session_id: String,
    /// Global monotonically increasing session sequence.
    pub sequence: DecimalSequence,
    /// Logical stream.
    pub stream: StreamKind,
    /// Frame semantic kind.
    pub kind: FrameKind,
    /// Payload encoding.
    pub encoding: PayloadEncoding,
    /// Decoded payload byte count.
    pub payload_bytes: u32,
    /// Lowercase SHA-256 of the decoded payload.
    pub payload_sha256: String,
    /// Record count, present only for `records` frames.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_count: Option<u16>,
    /// UTF-8 JSON text or canonical padded Base64.
    pub payload: String,
}

/// Strict payload inside a `records` frame.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordBatchPayload<T = serde_json::Value> {
    /// Dataset to which every record belongs.
    pub dataset: DatasetKind,
    /// Per-controller ephemeral account binding, present only on the account
    /// dataset's first (and only) batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_binding_sha256: Option<String>,
    /// Whitelisted normalized records.
    pub records: Vec<T>,
}

/// Whitelisted account record emitted by the injector.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountRecord {
    /// Stable `WhatsApp` model identifier.
    pub id: String,
    /// Locally observable display name.
    pub display_name: Option<String>,
    /// Business-account flag when exposed.
    pub is_business: Option<bool>,
    /// Enterprise-account flag when exposed.
    pub is_enterprise: Option<bool>,
    /// Locally materialized verified business name.
    pub verified_name: Option<String>,
    /// Whether a profile-picture model was already materialized for this
    /// account. Bytes remain subject to the signed media policy.
    pub profile_image_available: Option<bool>,
}

/// Whitelisted contact record emitted by the injector.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContactRecord {
    /// Stable `WhatsApp` model identifier.
    pub id: String,
    /// Address-book name.
    pub name: Option<String>,
    /// `WhatsApp` push name.
    pub push_name: Option<String>,
    /// Short display name.
    pub short_name: Option<String>,
    /// Formatted display name.
    pub formatted_name: Option<String>,
    /// User-contact flag.
    pub is_user: Option<bool>,
    /// Group-contact flag.
    pub is_group: Option<bool>,
    /// `WhatsApp` registration flag.
    pub is_whats_app_contact: Option<bool>,
    /// Business-contact flag.
    pub is_business: Option<bool>,
    /// Local address-book membership flag.
    pub is_my_contact: Option<bool>,
    /// Local block flag.
    pub is_blocked: Option<bool>,
    /// Locally materialized About/status text; never actively queried.
    pub about: Option<String>,
    /// Locally materialized verified business name.
    pub verified_name: Option<String>,
    /// Explicit local verification flag when exposed.
    pub is_verified: Option<bool>,
    /// Explicit local deactivation flag when exposed.
    pub is_deactivated: Option<bool>,
    /// Whether a profile-picture model was already materialized for this
    /// contact. No URL is transferred to the host.
    pub profile_image_available: Option<bool>,
}

/// Whitelisted chat record emitted by the injector.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRecord {
    /// Stable `WhatsApp` model identifier.
    pub id: String,
    /// Locally observable chat name.
    pub name: Option<String>,
    /// Group-chat flag.
    pub is_group: Option<bool>,
    /// Read-only channel/chat flag.
    pub is_read_only: Option<bool>,
    /// Archive flag.
    pub archived: Option<bool>,
    /// Pin flag.
    pub pinned: Option<bool>,
    /// Local unread counter.
    pub unread_count: Option<f64>,
    /// Model timestamp.
    pub timestamp: Option<f64>,
    /// Mute expiration timestamp.
    pub mute_expiration: Option<f64>,
    /// Last locally received message identifier.
    pub last_message_id: Option<String>,
    /// Locally observable participant count.
    pub participant_count: Option<u64>,
    /// Disappearing-message duration when exposed.
    pub ephemeral_duration_seconds: Option<u64>,
    /// Community parent flag.
    pub is_community: Option<bool>,
    /// Parent community identifier when this is a child group.
    pub parent_group_id: Option<String>,
    /// Community announcement/default subgroup identifier.
    pub default_subgroup_id: Option<String>,
    /// Child subgroup identifiers materialized in the current client.
    #[serde(default)]
    pub joined_subgroup_ids: Vec<String>,
    /// Message count before Adapter history enrichment.
    pub initial_message_count: Option<u64>,
    /// Message count after Adapter history enrichment.
    pub final_message_count: Option<u64>,
    /// Per-chat history termination classification.
    pub history_scope: Option<HistoryCompleteness>,
    /// Adapter history-provider invocation count.
    pub history_rounds: Option<u32>,
    /// Sum of models returned by fixed Adapter history providers.
    pub history_returned_count: Option<u64>,
    /// Newly materialized unique messages.
    pub history_new_count: Option<u64>,
    /// Loader rounds that returned no models.
    pub history_empty_rounds: Option<u32>,
    /// Loader rounds that did not grow the chat collection.
    pub history_stagnant_rounds: Option<u32>,
    /// Fixed machine-readable termination reason.
    pub history_reason_code: Option<String>,
}

/// Whitelisted favorite/custom chat-list record.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatListRecord {
    /// Stable list identifier or a fixed derived label.
    pub id: String,
    /// `favorites` or `custom`.
    pub list_kind: String,
    /// Locally observable list name.
    pub name: String,
    /// Stable local display order.
    pub order: u64,
    /// Native chat identifiers contained in the list.
    pub chat_ids: Vec<String>,
}

/// Whitelisted participant relation record.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParticipantRecord {
    /// Stable composite native relation identifier.
    pub id: String,
    /// Native group/channel/community identifier.
    pub container_id: String,
    /// Native contact/account identifier.
    pub subject_id: String,
    /// `owner`, `admin`, `member`, `subscriber`, or `unknown`.
    pub role: String,
    /// `active`, `left`, `removed`, or `unknown`.
    pub membership_state: String,
    /// Native join time when observable.
    pub joined_timestamp: Option<f64>,
    /// Native leave time when observable.
    pub left_timestamp: Option<f64>,
}

/// Whitelisted message record emitted by the injector.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageRecord {
    /// Stable `WhatsApp` model identifier.
    pub id: String,
    /// Owning chat identifier.
    pub chat_id: Option<String>,
    /// Sender identifier when resolved.
    pub sender_id: Option<String>,
    /// Group author identifier when resolved.
    pub author_id: Option<String>,
    /// Recipient identifier when resolved.
    pub recipient_id: Option<String>,
    /// Model timestamp.
    pub timestamp: Option<f64>,
    /// `WhatsApp` message type.
    pub r#type: Option<String>,
    /// `WhatsApp` message subtype.
    pub subtype: Option<String>,
    /// Plain message body.
    pub body: Option<String>,
    /// Media caption.
    pub caption: Option<String>,
    /// Whether the local account authored the message.
    pub from_me: Option<bool>,
    /// Star flag.
    pub is_starred: Option<bool>,
    /// Forward flag.
    pub is_forwarded: Option<bool>,
    /// View-once flag.
    pub is_view_once: Option<bool>,
    /// Edited flag.
    pub is_edited: Option<bool>,
    /// Revoked flag.
    pub is_revoked: Option<bool>,
    /// Media-presence metadata flag; no media bytes are read in T0.
    pub has_media: Option<bool>,
    /// Local delivery acknowledgement state.
    pub acknowledgement: Option<f64>,
    /// Quoted message identifier.
    pub quoted_message_id: Option<String>,
    /// Media MIME metadata.
    pub media_mime_type: Option<String>,
    /// Media size metadata.
    pub media_size: Option<f64>,
    /// Original media filename metadata.
    pub media_file_name: Option<String>,
    /// Media width metadata.
    pub media_width: Option<f64>,
    /// Media height metadata.
    pub media_height: Option<f64>,
    /// Media duration metadata, in seconds.
    pub media_duration_seconds: Option<f64>,
    /// Mentioned native contact identifiers.
    #[serde(default)]
    pub mention_ids: Vec<String>,
    /// Ephemeral-message flag.
    pub is_ephemeral: Option<bool>,
    /// Location latitude.
    pub latitude: Option<f64>,
    /// Location longitude.
    pub longitude: Option<f64>,
    /// Location label.
    pub location_name: Option<String>,
    /// Location address.
    pub location_address: Option<String>,
    /// Poll question.
    pub poll_name: Option<String>,
    /// Poll option labels.
    #[serde(default)]
    pub poll_options: Vec<String>,
    /// Maximum selectable poll options.
    pub poll_selectable_count: Option<u64>,
    /// Poll closed flag.
    pub poll_closed: Option<bool>,
    /// Event name.
    pub event_name: Option<String>,
    /// Event description.
    pub event_description: Option<String>,
    /// Event start timestamp.
    pub event_start_timestamp: Option<f64>,
    /// Event cancellation flag.
    pub event_canceled: Option<bool>,
    /// Fixed reasons explaining why only a partial message model was observable.
    #[serde(default)]
    pub unsupported_reason_codes: Vec<String>,
}

/// Whitelisted generic event emitted for event-like WAEB datasets.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventRecord {
    /// Stable native or composite event identifier.
    pub id: String,
    /// Stable normalized event kind.
    pub event_kind: String,
    /// Bounded native event type.
    pub native_type: String,
    /// Native subject identifiers.
    #[serde(default)]
    pub subject_ids: Vec<String>,
    /// Native actor identifiers.
    #[serde(default)]
    pub actor_ids: Vec<String>,
    /// Native occurrence timestamp.
    pub timestamp: Option<f64>,
    /// Bounded state/value field when relevant.
    pub state: Option<String>,
    /// Reaction emoji or other short marker.
    pub marker: Option<String>,
    /// Poll option label when relevant.
    pub option: Option<String>,
    /// Numeric duration/count when relevant.
    pub numeric_value: Option<f64>,
    /// Call video flag when relevant.
    pub is_video: Option<bool>,
    /// Call/group event group flag when relevant.
    pub is_group: Option<bool>,
    /// Outgoing call/event flag when relevant.
    pub outgoing: Option<bool>,
}

/// Whitelisted channel/community entity record.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityRecord {
    /// Stable native entity identifier.
    pub id: String,
    /// Entity kind (`channel` or `community`).
    pub entity_kind: String,
    /// Display name.
    pub display_name: Option<String>,
    /// Description/about text.
    pub description: Option<String>,
    /// Subscription/member state.
    pub membership_state: Option<String>,
    /// Verified flag.
    pub verified: Option<bool>,
    /// Read-only flag.
    pub read_only: Option<bool>,
    /// Local unread count.
    pub unread_count: Option<f64>,
    /// Native creation timestamp.
    pub creation_timestamp: Option<f64>,
}

/// Whitelisted community relationship record.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationRecord {
    /// Stable composite native relation identifier.
    pub id: String,
    /// Fixed WAEB relation kind.
    pub relation_kind: String,
    /// Native source entity identifier.
    pub from_id: String,
    /// Native target entity identifier when resolved.
    pub to_id: Option<String>,
}

/// Commands accepted by `dispatch`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchCommand {
    /// Probe the fixed private-module capability signature.
    Probe,
    /// Start a passive, locally observable T0 snapshot.
    StartT0,
    /// Start Store-only history/media enrichment followed by a snapshot.
    StartComprehensive,
}

/// Strict dispatch request DTO for host-side bookkeeping.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchRequest {
    /// Exact protocol identifier.
    pub protocol: String,
    /// Controller session identifier.
    pub session_id: String,
    /// Fixed command enum; arbitrary script text is impossible.
    pub command: DispatchCommand,
}

/// Strict acknowledgement request DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AckRequest {
    /// Exact protocol identifier.
    pub protocol: String,
    /// Controller session identifier.
    pub session_id: String,
    /// Sequence being acknowledged.
    pub sequence: DecimalSequence,
}

/// Strict result of the structural build/capability probe.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeResultPayload {
    /// Protocol echoed by the controller.
    pub protocol: String,
    /// Controller semantic version.
    pub controller_version: String,
    /// Whether the fixed adapter signature matched.
    pub supported: bool,
    /// Fixed adapter ID, absent for an unknown build.
    pub adapter_id: Option<String>,
    /// Bounded diagnostic build label.
    pub build: String,
    /// Per-controller randomized account binding. This is present only for a
    /// supported probe and is neither public nor an identity authenticator.
    pub account_binding_sha256: Option<String>,
    /// Fail-closed capability mismatch reasons.
    pub reasons: Vec<String>,
    /// Explicit read/write capability matrix.
    pub capabilities: CapabilityPayload,
}

/// Strict read/write capability matrix returned by `probe`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)]
pub struct CapabilityPayload {
    /// Passive T0 collection is available.
    pub passive_t0: bool,
    /// Comprehensive Store-only read-only mode is available.
    pub comprehensive_readonly_v02: bool,
    /// Account records are readable.
    pub accounts: bool,
    /// Contact records are readable.
    pub contacts: bool,
    /// Chat records are readable.
    pub chats: bool,
    /// Message records are readable.
    pub messages: bool,
    /// Media bytes are readable in this adapter.
    pub media: bool,
    /// Fixed Store-only history loading is available.
    pub history_loading: bool,
    /// Network-affecting read operations are available in comprehensive mode.
    pub network_actions: bool,
    /// DOM mutation is available (always false for released adapters).
    pub dom_writes: bool,
    /// Per-WAEB-dataset structural capability results in fixed order.
    pub datasets: Vec<DatasetCapabilityPayload>,
}

/// One adapter capability result for a fixed WAEB dataset.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetCapabilityPayload {
    /// Fixed dataset name.
    pub dataset: DatasetKind,
    /// Supported, degraded, unsupported, or error.
    pub result: DatasetCapabilityResult,
    /// Fixed reason codes; empty only for supported results.
    pub reason_codes: Vec<String>,
}

/// Structural capability outcome from the page Adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetCapabilityResult {
    /// Adapter has a recognized reader for this build.
    Supported,
    /// Reader is usable but known to expose only a subset.
    Degraded,
    /// No recognized reader exists for this build.
    Unsupported,
    /// A recognized reader failed its bounded structural probe.
    Error,
}

/// One fixed dataset count at stream start.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetObservationPayload {
    /// Dataset name.
    pub dataset: DatasetKind,
    /// Number of locally observable records.
    pub observed_records: u64,
}

/// Strict `stream_start` control payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamStartPayload {
    /// Fixed operation name.
    pub operation: OperationKind,
    /// UTC observation start time.
    pub observed_at: String,
    /// Ephemeral account binding established by the successful probe.
    pub account_binding_sha256: String,
    /// Challenge-bound continuity value used only inside authenticated resume state.
    pub resume_binding_sha256: String,
    /// SHA-256 of the fixed, ordered media task plan for this snapshot.
    pub media_plan_sha256: String,
    /// Number of terminal media tasks already committed before this stream.
    pub media_start_index: u64,
    /// Per-dataset observed counts.
    pub datasets: Vec<DatasetObservationPayload>,
}

/// Supported acquisition operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    /// Passive T0 snapshot.
    T0,
    /// Store-only comprehensive read-only acquisition.
    ComprehensiveReadonlyV02,
}

/// Fixed per-dataset totals emitted at stream end.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetTotalsPayload {
    /// Account record count.
    pub accounts: u64,
    /// Contact record count.
    pub contacts: u64,
    /// Chat record count.
    pub chats: u64,
    /// Chat-list record count.
    pub chat_lists: u64,
    /// Participant-relation count.
    pub participants: u64,
    /// Message record count.
    pub messages: u64,
    /// Message-event count.
    pub message_events: u64,
    /// Reaction count.
    pub reactions: u64,
    /// Receipt count.
    pub receipts: u64,
    /// Poll-vote count.
    pub poll_votes: u64,
    /// Group-event count.
    pub group_events: u64,
    /// Status message count.
    pub statuses: u64,
    /// Call count.
    pub calls: u64,
    /// Channel count.
    pub channels: u64,
    /// Channel-event count.
    pub channel_events: u64,
    /// Community count.
    pub communities: u64,
    /// Community-relation count.
    pub community_relations: u64,
    /// Presence-snapshot count.
    pub presence_snapshots: u64,
}

/// Strict completeness statement for passive T0.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletenessPayload {
    /// Local snapshot result.
    pub local_snapshot: LocalSnapshotCompleteness,
    /// History-loading scope.
    pub history_scope: HistoryCompleteness,
    /// Media acquisition scope.
    pub media_scope: MediaCompleteness,
    /// Account-wide completeness, which Web cannot establish.
    pub account_scope: AccountCompleteness,
    /// Machine-readable limitations.
    pub reasons: Vec<String>,
}

/// Local snapshot completeness enum.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalSnapshotCompleteness {
    /// All adapter reads completed.
    Verified,
    /// Some adapter reads failed.
    Partial,
    /// Snapshot failed.
    Failed,
}

/// History acquisition completeness enum.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryCompleteness {
    /// Loader reached a structurally observed terminal state.
    TerminalObserved,
    /// Repeated rounds produced stable no-growth observations.
    StableNoGrowth,
    /// A configured per-chat limit was reached.
    LimitReached,
    /// The fixed Store loader failed for at least one chat.
    LoaderError,
    /// Passive T0 never loads history.
    NotRun,
}

/// Media acquisition completeness enum.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaCompleteness {
    /// Every requested asset reached an available terminal result.
    Complete,
    /// At least one requested asset was missing/expired/decrypt-error.
    Partial,
    /// Passive T0 never requests media bytes.
    NotRequested,
}

/// Bounded progress payload shown by the native GUI and recorded as audit data.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressPayload {
    /// `history`, `snapshot`, or `media`.
    pub phase: String,
    /// Completed unit count.
    pub completed: u64,
    /// Total unit count known at this point.
    pub total: u64,
    /// Fixed status code without page content.
    pub status_code: String,
    /// One-based media position; present only for `media` progress.
    pub media_index: Option<u64>,
    /// Stable media task count; present only for `media` progress.
    pub media_total: Option<u64>,
    /// Bounded delay suggested before the next non-blocking poll.
    pub retry_after_ms: Option<u64>,
    /// One-based network attempt, or zero during cache lookup.
    pub attempt: Option<u32>,
    /// Bytes already emitted for the active asset.
    pub bytes_observed: Option<u64>,
    /// Milliseconds elapsed since this media task started.
    pub elapsed_ms: Option<u64>,
}

/// Start metadata for one page-observed media Blob.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaStartPayload {
    /// Deterministic page/host media-task key. It is matched against a media
    /// observation created from an already accepted normalized record.
    pub asset_key: String,
    /// WAEB v1 media role (`full` or `avatar`).
    pub role: String,
    /// Normalized media kind.
    pub kind: String,
    /// Page-declared MIME type.
    pub declared_mime: Option<String>,
    /// Page-observed original filename.
    pub original_file_name: Option<String>,
    /// Page-declared byte length.
    pub expected_size: Option<u64>,
    /// Width metadata.
    pub width: Option<u64>,
    /// Height metadata.
    pub height: Option<u64>,
    /// Duration metadata in milliseconds.
    pub duration_ms: Option<u64>,
    /// Initial method (`cache_lookup`, `media_download`, or `not_attempted`).
    pub method: String,
    /// One-based download attempt count, or zero before a network request.
    pub attempts: u32,
    /// Whether a `WhatsApp` network-backed loader has already been called.
    pub network_action_attempted: bool,
}

/// Terminal metadata for the active media byte stream.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaEndPayload {
    /// Media-task key matching the active media start.
    pub asset_key: String,
    /// `available`, `missing`, `expired`, or `decrypt_error`.
    pub status: String,
    /// Total decoded bytes emitted in media chunks.
    pub total_bytes: u64,
    /// Fixed reason code for non-available results.
    pub error_code: Option<String>,
    /// UTC capture completion time for available media.
    pub captured_at_utc: Option<String>,
    /// Final acquisition method recorded in the Evidence Bag.
    pub method: String,
    /// Final number of `WhatsApp` loader attempts.
    pub attempts: u32,
    /// Whether any network-backed loader was called for this asset.
    pub network_action_attempted: bool,
}

/// Account-wide scope enum.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountCompleteness {
    /// A Web client cannot prove account-wide completeness.
    Unverifiable,
}

/// Strict successful stream end payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamEndPayload {
    /// Fixed operation name.
    pub operation: OperationKind,
    /// UTC observation start time.
    pub observed_at: String,
    /// UTC completion time.
    pub completed_at: String,
    /// Ephemeral account binding recomputed at stream completion.
    pub account_binding_sha256: String,
    /// Challenge-bound continuity value recomputed at stream completion.
    pub resume_binding_sha256: String,
    /// SHA-256 of the unchanged ordered media task plan.
    pub media_plan_sha256: String,
    /// Number of terminal media tasks present when this stream began.
    pub media_start_index: u64,
    /// Per-dataset totals.
    pub totals: DatasetTotalsPayload,
    /// Media-request/result totals observed by the page Adapter.
    pub media: MediaTotalsPayload,
    /// Explicit scope limitations.
    pub completeness: CompletenessPayload,
}

/// Media terminal counts emitted by the page Adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaTotalsPayload {
    /// Media assets selected for acquisition.
    pub requested: u64,
    /// Assets whose byte stream completed.
    pub available: u64,
    /// Assets not available in the current client/cache.
    pub missing: u64,
    /// Assets whose download reference had expired.
    pub expired: u64,
    /// Assets that could not be decrypted/read.
    pub decrypt_error: u64,
    /// Network attempts exhausted or exceeded their signed time budget.
    pub download_timeout: u64,
    /// Observable media state stopped changing for the signed interval.
    pub no_progress_timeout: u64,
    /// Asset exceeded its signed byte limit.
    pub too_large: u64,
    /// Host could not reserve enough safe output space.
    pub disk_space_insufficient: u64,
    /// Host-computed byte digest or length did not match.
    pub hash_mismatch: u64,
    /// Media transfer ended because the local relay was interrupted.
    pub transport_interrupted: u64,
    /// Operator or host canceled the asset.
    pub canceled: u64,
    /// `WhatsApp` exposed neither cached bytes nor a usable loader result.
    pub unavailable: u64,
    /// Signed policy intentionally skipped byte acquisition.
    pub not_attempted: u64,
}

/// Strict fail-closed error payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorPayload {
    /// Stable machine-readable error code.
    pub code: String,
    /// Fixed non-evidence marker; page exception text is never forwarded.
    pub message: String,
}

/// Strict cancellation payload for future host-visible cancellation frames.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelledPayload {
    /// Stable cancellation reason.
    pub reason: String,
}

/// Result of accepting a pulled frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiveOutcome {
    /// First valid delivery of the expected frame.
    Accepted,
    /// Byte-identical repeat while the frame is awaiting acknowledgement.
    Redelivery,
}

/// Result of acknowledging a frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AckOutcome {
    /// The pending frame was acknowledged and the sequence advanced.
    Applied,
    /// The immediately preceding acknowledgement was repeated.
    Duplicate,
}

/// Failures detected at the host trust boundary.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum BridgeError {
    /// Protocol differs from the compiled-in protocol.
    #[error("unsupported protocol: {0}")]
    UnsupportedProtocol(String),
    /// Session identifiers are malformed or do not match.
    #[error("invalid or mismatched session")]
    InvalidSession,
    /// Sequence is not the next expected value.
    #[error("unexpected sequence: expected {expected}, received {received}")]
    UnexpectedSequence {
        /// Expected sequence.
        expected: DecimalSequence,
        /// Received sequence.
        received: DecimalSequence,
    },
    /// A different frame was returned for an unacknowledged sequence.
    #[error("conflicting redelivery for sequence {0}")]
    ConflictingRedelivery(DecimalSequence),
    /// The page advanced before the current frame was acknowledged.
    #[error("frame {0} is still awaiting acknowledgement")]
    PendingAcknowledgement(DecimalSequence),
    /// Acknowledgement is neither pending nor an idempotent duplicate.
    #[error("acknowledgement is out of order: {0}")]
    AckOutOfOrder(DecimalSequence),
    /// Payload encoding is invalid or non-canonical.
    #[error("invalid payload encoding")]
    InvalidEncoding,
    /// Declared payload byte count is incorrect.
    #[error("payload byte count mismatch: declared {declared}, actual {actual}")]
    PayloadBytesMismatch {
        /// Wire declaration.
        declared: u32,
        /// Decoded byte count.
        actual: usize,
    },
    /// Payload exceeds the limit for its stream.
    #[error("payload exceeds stream limit: {actual} > {limit}")]
    FrameTooLarge {
        /// Decoded byte count.
        actual: usize,
        /// Applicable limit.
        limit: usize,
    },
    /// Payload digest is malformed or does not match.
    #[error("payload SHA-256 mismatch")]
    PayloadHashMismatch,
    /// Stream, frame kind and encoding do not form an allowed combination.
    #[error("invalid stream/kind/encoding combination")]
    InvalidFrameShape,
    /// Record payload is invalid or count metadata does not match it.
    #[error("invalid record batch")]
    InvalidRecordBatch,
    /// The page-side queue would exceed its hard cap.
    #[error("queue exceeds limit: {actual} > {limit}")]
    QueueTooLarge {
        /// Total decoded queued bytes.
        actual: usize,
        /// Queue limit.
        limit: usize,
    },
    /// Sequence cannot advance past `u64::MAX`.
    #[error("sequence exhausted")]
    SequenceExhausted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FrameIdentity {
    stream: StreamKind,
    kind: FrameKind,
    encoding: PayloadEncoding,
    payload_bytes: u32,
    payload_sha256: String,
    record_count: Option<u16>,
}

impl From<&Frame> for FrameIdentity {
    fn from(frame: &Frame) -> Self {
        Self {
            stream: frame.stream,
            kind: frame.kind,
            encoding: frame.encoding,
            payload_bytes: frame.payload_bytes,
            payload_sha256: frame.payload_sha256.clone(),
            record_count: frame.record_count,
        }
    }
}

/// Stateful host validator for ordering and idempotent pull/ACK behavior.
#[derive(Debug)]
pub struct FrameValidator {
    session_id: String,
    next_sequence: DecimalSequence,
    pending: Option<(DecimalSequence, FrameIdentity)>,
    last_acked: Option<DecimalSequence>,
}

impl FrameValidator {
    /// Creates a session-bound validator starting at sequence zero.
    ///
    /// # Errors
    ///
    /// Returns [`BridgeError::InvalidSession`] for an identifier outside the
    /// bounded ASCII session grammar.
    pub fn new(session_id: impl Into<String>) -> Result<Self, BridgeError> {
        let session_id = session_id.into();
        if !valid_session_id(&session_id) {
            return Err(BridgeError::InvalidSession);
        }
        Ok(Self {
            session_id,
            next_sequence: DecimalSequence::new(0),
            pending: None,
            last_acked: None,
        })
    }

    /// Validates and accepts a frame, or recognizes an exact redelivery.
    ///
    /// # Errors
    ///
    /// Returns a [`BridgeError`] when integrity, session, shape, size or
    /// sequence validation fails.
    pub fn receive(&mut self, frame: &Frame) -> Result<ReceiveOutcome, BridgeError> {
        if frame.session_id != self.session_id {
            return Err(BridgeError::InvalidSession);
        }
        validate_frame(frame)?;

        if let Some((pending_sequence, identity)) = &self.pending {
            if frame.sequence != *pending_sequence {
                return Err(BridgeError::PendingAcknowledgement(*pending_sequence));
            }
            if FrameIdentity::from(frame) == *identity {
                return Ok(ReceiveOutcome::Redelivery);
            }
            return Err(BridgeError::ConflictingRedelivery(frame.sequence));
        }

        if frame.sequence != self.next_sequence {
            return Err(BridgeError::UnexpectedSequence {
                expected: self.next_sequence,
                received: frame.sequence,
            });
        }
        self.pending = Some((frame.sequence, FrameIdentity::from(frame)));
        Ok(ReceiveOutcome::Accepted)
    }

    /// Applies an acknowledgement; repeating the latest ACK is idempotent.
    ///
    /// # Errors
    ///
    /// Returns [`BridgeError::AckOutOfOrder`] for a non-pending sequence or
    /// [`BridgeError::SequenceExhausted`] after the largest sequence.
    pub fn acknowledge(&mut self, sequence: DecimalSequence) -> Result<AckOutcome, BridgeError> {
        if let Some((pending_sequence, _)) = &self.pending
            && sequence == *pending_sequence
        {
            self.pending = None;
            self.last_acked = Some(sequence);
            let next = sequence
                .value()
                .checked_add(1)
                .ok_or(BridgeError::SequenceExhausted)?;
            self.next_sequence = DecimalSequence::new(next);
            return Ok(AckOutcome::Applied);
        }
        if self.last_acked == Some(sequence) {
            return Ok(AckOutcome::Duplicate);
        }
        Err(BridgeError::AckOutOfOrder(sequence))
    }

    /// Validates protocol and session before applying a strict ACK DTO.
    ///
    /// # Errors
    ///
    /// Returns a [`BridgeError`] for a mismatched request header or invalid
    /// acknowledgement sequence.
    pub fn acknowledge_request(&mut self, request: &AckRequest) -> Result<AckOutcome, BridgeError> {
        validate_request_header(&request.protocol, &request.session_id, &self.session_id)?;
        self.acknowledge(request.sequence)
    }

    /// Returns the next expected sequence.
    #[must_use]
    pub const fn next_sequence(&self) -> DecimalSequence {
        self.next_sequence
    }
}

/// Validates a strict dispatch DTO against a controller session.
///
/// # Errors
///
/// Returns a [`BridgeError`] when protocol or session does not match.
pub fn validate_dispatch_request(
    request: &DispatchRequest,
    expected_session_id: &str,
) -> Result<(), BridgeError> {
    validate_request_header(&request.protocol, &request.session_id, expected_session_id)
}

/// Validates one frame without changing ordering state.
///
/// # Errors
///
/// Returns a [`BridgeError`] for any protocol, session, integrity, size,
/// encoding or DTO-shape violation.
pub fn validate_frame(frame: &Frame) -> Result<(), BridgeError> {
    if frame.protocol != PROTOCOL {
        return Err(BridgeError::UnsupportedProtocol(frame.protocol.clone()));
    }
    if !valid_session_id(&frame.session_id) {
        return Err(BridgeError::InvalidSession);
    }

    let decoded = decoded_payload(frame)?;
    let actual = decoded.len();
    if usize::try_from(frame.payload_bytes).ok() != Some(actual) {
        return Err(BridgeError::PayloadBytesMismatch {
            declared: frame.payload_bytes,
            actual,
        });
    }
    let limit = if frame.stream == StreamKind::Control {
        MAX_CONTROL_BYTES
    } else {
        MAX_DATA_FRAME_BYTES
    };
    if actual > limit {
        return Err(BridgeError::FrameTooLarge { actual, limit });
    }

    let actual_hash = hex::encode(Sha256::digest(&decoded));
    if frame.payload_sha256.len() != 64
        || !frame
            .payload_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || actual_hash != frame.payload_sha256
    {
        return Err(BridgeError::PayloadHashMismatch);
    }

    validate_shape_and_records(frame, &decoded)
}

/// Checks that a materialized page queue remains within its decoded-byte cap.
///
/// The v0.2 injector normally holds just one frame, but this guard is also used
/// by hosts and test doubles that prefetch frames.
///
/// # Errors
///
/// Returns a frame validation error or [`BridgeError::QueueTooLarge`].
pub fn validate_queue(frames: &[Frame]) -> Result<(), BridgeError> {
    let mut total = 0usize;
    for frame in frames {
        validate_frame(frame)?;
        total =
            total
                .checked_add(frame.payload_bytes as usize)
                .ok_or(BridgeError::QueueTooLarge {
                    actual: usize::MAX,
                    limit: MAX_QUEUE_BYTES,
                })?;
        if total > MAX_QUEUE_BYTES {
            return Err(BridgeError::QueueTooLarge {
                actual: total,
                limit: MAX_QUEUE_BYTES,
            });
        }
    }
    Ok(())
}

fn valid_session_id(session_id: &str) -> bool {
    (16..=128).contains(&session_id.len())
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_request_header(
    protocol: &str,
    session_id: &str,
    expected_session_id: &str,
) -> Result<(), BridgeError> {
    if protocol != PROTOCOL {
        return Err(BridgeError::UnsupportedProtocol(protocol.to_owned()));
    }
    if !valid_session_id(session_id) || session_id != expected_session_id {
        return Err(BridgeError::InvalidSession);
    }
    Ok(())
}

fn decoded_payload(frame: &Frame) -> Result<Vec<u8>, BridgeError> {
    match frame.encoding {
        PayloadEncoding::Utf8Json => Ok(frame.payload.as_bytes().to_vec()),
        PayloadEncoding::Base64 => {
            let decoded = BASE64_STANDARD
                .decode(frame.payload.as_bytes())
                .map_err(|_| BridgeError::InvalidEncoding)?;
            if BASE64_STANDARD.encode(&decoded) != frame.payload {
                return Err(BridgeError::InvalidEncoding);
            }
            Ok(decoded)
        }
    }
}

/// Decodes one already validated media frame without exposing a generic
/// payload decoder to callers.
///
/// # Errors
///
/// Returns an error unless the frame is the canonical media-chunk shape and
/// its decoded length/hash match the envelope.
pub fn media_chunk_bytes(frame: &Frame) -> Result<Vec<u8>, BridgeError> {
    if frame.stream != StreamKind::Media
        || frame.kind != FrameKind::MediaChunk
        || frame.encoding != PayloadEncoding::Base64
        || frame.record_count.is_some()
    {
        return Err(BridgeError::InvalidFrameShape);
    }
    validate_frame(frame)?;
    decoded_payload(frame)
}

fn validate_shape_and_records(frame: &Frame, decoded: &[u8]) -> Result<(), BridgeError> {
    match (frame.stream, frame.kind, frame.encoding) {
        (StreamKind::Control, kind, PayloadEncoding::Utf8Json) if frame.record_count.is_none() => {
            validate_control_payload(kind, decoded)
        }
        (StreamKind::Record, FrameKind::Records, PayloadEncoding::Utf8Json) => {
            let count = frame.record_count.ok_or(BridgeError::InvalidRecordBatch)? as usize;
            if count == 0 || count > MAX_RECORDS_PER_FRAME {
                return Err(BridgeError::InvalidRecordBatch);
            }
            let probe: RecordBatchProbe =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidRecordBatch)?;
            let fingerprint_is_valid = match probe.dataset {
                DatasetKind::Accounts => probe
                    .account_binding_sha256
                    .as_deref()
                    .is_some_and(valid_account_binding),
                _ => probe.account_binding_sha256.is_none(),
            };
            if probe.records.len() != count || !fingerprint_is_valid {
                return Err(BridgeError::InvalidRecordBatch);
            }
            validate_typed_record_batch(probe.dataset, decoded)
        }
        (StreamKind::Media, FrameKind::MediaChunk, PayloadEncoding::Base64)
            if frame.record_count.is_none() =>
        {
            Ok(())
        }
        _ => Err(BridgeError::InvalidFrameShape),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordBatchProbe {
    dataset: DatasetKind,
    #[serde(default)]
    account_binding_sha256: Option<String>,
    records: Vec<serde::de::IgnoredAny>,
}

fn valid_account_binding(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_probe_reason(value: &str) -> bool {
    matches!(
        value,
        "contact_collection_signature_mismatch"
            | "chat_collection_signature_mismatch"
            | "account_reader_signature_mismatch"
            | "account_module_signature_mismatch"
            | "adapter_probe_failed"
            | "history_loader_signature_mismatch"
            | "media_reader_signature_mismatch"
            | "collections_module_signature_mismatch"
            | "unknown_build"
    )
}

fn valid_capability_reason(value: &str) -> bool {
    matches!(
        value,
        "derived_from_messages"
            | "derived_from_chat_metadata"
            | "optional_collection_unavailable"
            | "collection_signature_mismatch"
            | "partial_model_materialization"
            | "history_loader_unavailable"
            | "media_reader_unavailable"
            | "reader_error"
    )
}

fn valid_completeness_reason(value: &str) -> bool {
    if matches!(
        value,
        "account_scope_unverifiable"
            | "store_only_no_ui_fallback"
            | "passive_t0_only"
            | "history_stable_no_growth"
            | "history_limit_reached"
            | "history_loader_error"
            | "history_not_run"
            | "media_not_requested"
            | "media_partial"
            | "message_native_id_unavailable_omitted"
            | "status_message_native_id_unavailable_omitted"
            | "chat_message_collection_unavailable_omitted"
            | "chat_expected_messages_unobservable_omitted"
            | "global_message_container_unobservable_omitted"
            | "message_quote_reference_unavailable_omitted"
            | "message_pin_parent_unobservable_omitted"
            | "media_inline_preview_omitted"
    ) {
        return true;
    }
    value
        .strip_suffix("_record_without_id_omitted")
        .is_some_and(|dataset| {
            DatasetKind::ALL
                .iter()
                .any(|candidate| candidate.as_str() == dataset)
        })
}

fn validate_typed_record_batch(dataset: DatasetKind, decoded: &[u8]) -> Result<(), BridgeError> {
    let parsed_dataset = match dataset {
        DatasetKind::Accounts => {
            serde_json::from_slice::<RecordBatchPayload<AccountRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::Contacts => {
            serde_json::from_slice::<RecordBatchPayload<ContactRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::Chats => serde_json::from_slice::<RecordBatchPayload<ChatRecord>>(decoded)
            .map(|batch| batch.dataset),
        DatasetKind::ChatLists => {
            serde_json::from_slice::<RecordBatchPayload<ChatListRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::Participants => {
            serde_json::from_slice::<RecordBatchPayload<ParticipantRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::Messages => {
            serde_json::from_slice::<RecordBatchPayload<MessageRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::Statuses | DatasetKind::ChannelEvents => {
            serde_json::from_slice::<RecordBatchPayload<MessageRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::MessageEvents
        | DatasetKind::Reactions
        | DatasetKind::Receipts
        | DatasetKind::PollVotes
        | DatasetKind::GroupEvents
        | DatasetKind::Calls
        | DatasetKind::PresenceSnapshots => {
            serde_json::from_slice::<RecordBatchPayload<EventRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::Channels | DatasetKind::Communities => {
            serde_json::from_slice::<RecordBatchPayload<EntityRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
        DatasetKind::CommunityRelations => {
            serde_json::from_slice::<RecordBatchPayload<RelationRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
    }
    .map_err(|_| BridgeError::InvalidRecordBatch)?;
    if parsed_dataset != dataset {
        return Err(BridgeError::InvalidRecordBatch);
    }
    Ok(())
}

fn validate_probe_payload(decoded: &[u8]) -> Result<(), BridgeError> {
    let payload: ProbeResultPayload =
        serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
    let read_capabilities = payload.capabilities.passive_t0
        && payload.capabilities.accounts
        && payload.capabilities.contacts
        && payload.capabilities.chats
        && payload.capabilities.messages;
    let invalid_supported = payload.supported
        && (payload.adapter_id.as_deref() != Some("wa-private-collections-v2")
            || !payload
                .account_binding_sha256
                .as_deref()
                .is_some_and(valid_account_binding)
            || !read_capabilities
            || !payload.reasons.is_empty());
    let invalid_unsupported = !payload.supported
        && (payload.adapter_id.is_some()
            || payload.account_binding_sha256.is_some()
            || payload.capabilities.passive_t0
            || payload.capabilities.comprehensive_readonly_v02
            || payload.capabilities.accounts
            || payload.capabilities.contacts
            || payload.capabilities.chats
            || payload.capabilities.messages
            || payload.capabilities.media
            || payload.capabilities.history_loading
            || payload.capabilities.network_actions
            || payload.capabilities.dom_writes
            || payload.reasons.is_empty()
            || !payload
                .reasons
                .iter()
                .all(|reason| valid_probe_reason(reason)));
    if payload.protocol != PROTOCOL
        || payload.controller_version != CONTROLLER_VERSION
        || payload.capabilities.dom_writes
        || !valid_dataset_capabilities(&payload.capabilities.datasets)
        || invalid_supported
        || invalid_unsupported
    {
        return Err(BridgeError::InvalidFrameShape);
    }
    Ok(())
}

fn validate_media_start_payload(decoded: &[u8]) -> Result<(), BridgeError> {
    let payload: MediaStartPayload =
        serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
    if payload.asset_key.is_empty()
        || payload.asset_key.len() > 640
        || !matches!(payload.role.as_str(), "full" | "avatar")
        || (payload.role == "avatar" && payload.kind != "image")
        || (payload.role == "avatar"
            && (payload.original_file_name.is_some()
                || payload.duration_ms.is_some()
                || payload
                    .declared_mime
                    .as_deref()
                    .is_some_and(|value| !value.starts_with("image/"))))
        || !matches!(
            payload.kind.as_str(),
            "image"
                | "video"
                | "audio"
                | "voice"
                | "document"
                | "sticker"
                | "contact_card"
                | "other"
        )
        || !matches!(
            payload.method.as_str(),
            "cache_lookup" | "media_download" | "not_attempted"
        )
        || payload.attempts > 5
        || (payload.network_action_attempted && payload.attempts == 0)
        || payload
            .declared_mime
            .as_deref()
            .is_some_and(|value| value.len() > 160)
        || payload
            .original_file_name
            .as_deref()
            .is_some_and(|value| value.len() > 512)
    {
        return Err(BridgeError::InvalidFrameShape);
    }
    Ok(())
}

fn validate_media_end_payload(decoded: &[u8]) -> Result<(), BridgeError> {
    let payload: MediaEndPayload =
        serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
    let available = payload.status == "available";
    let error_valid = matches!(
        (payload.status.as_str(), payload.error_code.as_deref()),
        ("available", None)
            | ("missing", Some("media_missing"))
            | ("expired", Some("media_expired"))
            | ("decrypt_error", Some("media_decrypt_failed"))
            | ("download_timeout", Some("media_download_timeout"))
            | ("no_progress_timeout", Some("media_no_progress_timeout"))
            | ("too_large", Some("media_too_large"))
            | (
                "disk_space_insufficient",
                Some("media_disk_space_insufficient")
            )
            | ("hash_mismatch", Some("media_hash_mismatch"))
            | ("transport_interrupted", Some("media_transport_interrupted"))
            | ("canceled", Some("media_canceled"))
            | ("unavailable", Some("media_unavailable"))
            | (
                "not_attempted",
                Some(
                    "media_not_attempted"
                        | "media_policy_metadata_only"
                        | "media_cache_miss_network_disallowed"
                        | "media_total_limit_reached"
                        | "media_policy_stop_after_failure",
                ),
            )
    );
    let invalid_available = available
        && (payload.error_code.is_some()
            || payload.captured_at_utc.as_deref().is_none_or(|value| {
                chrono::DateTime::parse_from_rfc3339(value).is_err() || !value.ends_with('Z')
            }));
    let invalid_unavailable = !available
        && (payload.total_bytes != 0 || payload.captured_at_utc.is_some() || !error_valid);
    if payload.asset_key.is_empty()
        || payload.asset_key.len() > 640
        || !matches!(
            payload.method.as_str(),
            "blob_observed" | "media_download" | "not_attempted"
        )
        || payload.attempts > 5
        || payload.network_action_attempted != (payload.attempts > 0)
        || (payload.method == "media_download" && !payload.network_action_attempted)
        || (payload.method == "not_attempted" && payload.network_action_attempted)
        || invalid_available
        || invalid_unavailable
    {
        return Err(BridgeError::InvalidFrameShape);
    }
    Ok(())
}

fn validate_progress_payload(decoded: &[u8]) -> Result<(), BridgeError> {
    let payload: ProgressPayload =
        serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
    let phase_valid = matches!(payload.phase.as_str(), "history" | "snapshot" | "media");
    let status_valid = matches!(
        payload.status_code.as_str(),
        "history_round_complete"
            | "history_chat_complete"
            | "snapshot_ready"
            | "media_checking_cache"
            | "media_cache_miss"
            | "media_requesting_download"
            | "media_waiting_download"
            | "media_retrying"
            | "media_blob_ready"
            | "media_streaming"
            | "media_asset_complete"
            | "media_asset_unavailable"
    );
    let media_fields = payload.media_index.is_some()
        && payload.media_total.is_some()
        && payload
            .retry_after_ms
            .is_some_and(|value| (100..=5_000).contains(&value))
        && payload.attempt.is_some_and(|value| value <= 5)
        && payload.bytes_observed.is_some()
        && payload.elapsed_ms.is_some()
        && payload.media_index.is_some_and(|value| value > 0)
        && payload.media_index <= payload.media_total;
    let non_media_fields_absent = payload.media_index.is_none()
        && payload.media_total.is_none()
        && payload.retry_after_ms.is_none()
        && payload.attempt.is_none()
        && payload.bytes_observed.is_none()
        && payload.elapsed_ms.is_none();
    if !phase_valid
        || !status_valid
        || payload.completed > payload.total
        || (payload.phase == "media" && !media_fields)
        || (payload.phase != "media" && !non_media_fields_absent)
        || (payload.phase == "media" && !payload.status_code.starts_with("media_"))
        || (payload.phase != "media" && payload.status_code.starts_with("media_"))
    {
        return Err(BridgeError::InvalidFrameShape);
    }
    Ok(())
}

fn validate_control_payload(kind: FrameKind, decoded: &[u8]) -> Result<(), BridgeError> {
    match kind {
        FrameKind::ProbeResult => validate_probe_payload(decoded),
        FrameKind::StreamStart => {
            let payload: StreamStartPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            if payload.datasets.len() != DatasetKind::ALL.len()
                || !valid_account_binding(&payload.account_binding_sha256)
                || !valid_account_binding(&payload.resume_binding_sha256)
                || !valid_account_binding(&payload.media_plan_sha256)
                || payload
                    .datasets
                    .iter()
                    .map(|item| item.dataset)
                    .ne(DatasetKind::ALL)
            {
                return Err(BridgeError::InvalidFrameShape);
            }
            Ok(())
        }
        FrameKind::Progress => validate_progress_payload(decoded),
        FrameKind::MediaStart => validate_media_start_payload(decoded),
        FrameKind::MediaEnd => validate_media_end_payload(decoded),
        FrameKind::StreamEnd => {
            let payload: StreamEndPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            if payload.completeness.reasons.is_empty()
                || payload.completeness.reasons.len() > 64
                || !payload
                    .completeness
                    .reasons
                    .iter()
                    .all(|reason| valid_completeness_reason(reason))
                || !valid_account_binding(&payload.account_binding_sha256)
                || !valid_account_binding(&payload.resume_binding_sha256)
                || !valid_account_binding(&payload.media_plan_sha256)
                || payload.media_start_index > payload.media.requested
                || payload.media.requested
                    != payload.media.available
                        + payload.media.missing
                        + payload.media.expired
                        + payload.media.decrypt_error
                        + payload.media.download_timeout
                        + payload.media.no_progress_timeout
                        + payload.media.too_large
                        + payload.media.disk_space_insufficient
                        + payload.media.hash_mismatch
                        + payload.media.transport_interrupted
                        + payload.media.canceled
                        + payload.media.unavailable
                        + payload.media.not_attempted
            {
                return Err(BridgeError::InvalidFrameShape);
            }
            Ok(())
        }
        FrameKind::Error => {
            let payload: ErrorPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            if !matches!(
                payload.code.as_str(),
                "snapshot_failed" | "history_failed" | "media_protocol_failed"
            ) || payload.message != payload.code
            {
                return Err(BridgeError::InvalidFrameShape);
            }
            Ok(())
        }
        FrameKind::Cancelled => {
            let payload: CancelledPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            if payload.reason.is_empty() {
                return Err(BridgeError::InvalidFrameShape);
            }
            Ok(())
        }
        FrameKind::Records | FrameKind::MediaChunk => Err(BridgeError::InvalidFrameShape),
    }
}

fn valid_dataset_capabilities(values: &[DatasetCapabilityPayload]) -> bool {
    values.len() == DatasetKind::ALL.len()
        && values
            .iter()
            .map(|value| value.dataset)
            .eq(DatasetKind::ALL)
        && values.iter().all(|value| match value.result {
            DatasetCapabilityResult::Supported => value.reason_codes.is_empty(),
            DatasetCapabilityResult::Degraded
            | DatasetCapabilityResult::Unsupported
            | DatasetCapabilityResult::Error => {
                !value.reason_codes.is_empty()
                    && value
                        .reason_codes
                        .iter()
                        .all(|reason| valid_capability_reason(reason))
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    const ERROR_PAYLOAD: &str = r#"{"code":"snapshot_failed","message":"snapshot_failed"}"#;

    fn frame(sequence: u64, payload: &str) -> Frame {
        let payload_bytes = u32::try_from(payload.len()).unwrap_or(u32::MAX);
        Frame {
            protocol: PROTOCOL.to_owned(),
            session_id: SESSION.to_owned(),
            sequence: DecimalSequence::new(sequence),
            stream: StreamKind::Control,
            kind: FrameKind::Error,
            encoding: PayloadEncoding::Utf8Json,
            payload_bytes,
            payload_sha256: hex::encode(Sha256::digest(payload.as_bytes())),
            record_count: None,
            payload: payload.to_owned(),
        }
    }

    fn record_frame(sequence: u64, count: u16) -> Frame {
        let records: Vec<serde_json::Value> = (0..count)
            .map(|index| serde_json::json!({"id": index.to_string()}))
            .collect();
        let payload = serde_json::to_string(&serde_json::json!({
            "dataset": "messages",
            "records": records
        }))
        .unwrap_or_default();
        let mut result = frame(sequence, &payload);
        result.stream = StreamKind::Record;
        result.kind = FrameKind::Records;
        result.record_count = Some(count);
        result
    }

    fn probe_frame(sequence: u64) -> Frame {
        let datasets = DatasetKind::ALL.map(|dataset| {
            serde_json::json!({
                "dataset": dataset,
                "result": "supported",
                "reasonCodes": [],
            })
        });
        let payload = serde_json::json!({
            "protocol": PROTOCOL,
            "controllerVersion": CONTROLLER_VERSION,
            "supported": true,
            "adapterId": "wa-private-collections-v2",
            "build": "test-build",
            "accountBindingSha256": "a".repeat(64),
            "reasons": [],
            "capabilities": {
                "passiveT0": true,
                "comprehensiveReadonlyV02": true,
                "accounts": true,
                "contacts": true,
                "chats": true,
                "messages": true,
                "media": true,
                "historyLoading": true,
                "networkActions": true,
                "domWrites": false,
                "datasets": datasets
            }
        })
        .to_string();
        let mut result = frame(sequence, &payload);
        result.kind = FrameKind::ProbeResult;
        result
    }

    fn partial_stream_end_frame(sequence: u64) -> Frame {
        let payload = serde_json::json!({
            "operation": "comprehensive_readonly_v02",
            "observedAt": "2026-08-09T00:00:00.000Z",
            "completedAt": "2026-08-09T00:00:01.000Z",
            "accountBindingSha256": "a".repeat(64),
            "resumeBindingSha256": "b".repeat(64),
            "mediaPlanSha256": "c".repeat(64),
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
                "localSnapshot": "partial",
                "historyScope": "stable_no_growth",
                "mediaScope": "complete",
                "accountScope": "unverifiable",
                "reasons": [
                    "account_scope_unverifiable",
                    "store_only_no_ui_fallback",
                    "message_native_id_unavailable_omitted",
                    "chat_expected_messages_unobservable_omitted",
                    "message_quote_reference_unavailable_omitted"
                ]
            }
        })
        .to_string();
        let mut result = frame(sequence, &payload);
        result.kind = FrameKind::StreamEnd;
        result
    }

    #[test]
    fn strict_dto_rejects_unknown_fields_and_numeric_sequence() {
        let valid = serde_json::to_value(frame(0, ERROR_PAYLOAD));
        assert!(valid.is_ok());
        let mut with_extra = valid.unwrap_or_default();
        if let Some(object) = with_extra.as_object_mut() {
            object.insert("extra".to_owned(), serde_json::Value::Bool(true));
        }
        assert!(serde_json::from_value::<Frame>(with_extra).is_err());

        let mut numeric = serde_json::to_value(frame(0, ERROR_PAYLOAD)).unwrap_or_default();
        if let Some(object) = numeric.as_object_mut() {
            object.insert("sequence".to_owned(), serde_json::json!(0));
        }
        assert!(serde_json::from_value::<Frame>(numeric).is_err());
    }

    #[test]
    fn decimal_sequence_is_canonical() {
        assert!(serde_json::from_str::<DecimalSequence>("\"0\"").is_ok());
        assert!(serde_json::from_str::<DecimalSequence>("\"42\"").is_ok());
        for invalid in [
            "\"\"",
            "\"00\"",
            "\"01\"",
            "\"-1\"",
            "1",
            "\"18446744073709551616\"",
        ] {
            assert!(serde_json::from_str::<DecimalSequence>(invalid).is_err());
        }
    }

    #[test]
    fn validates_hash_size_and_record_count() {
        let valid = record_frame(0, 2);
        assert_eq!(validate_frame(&valid), Ok(()));

        let mut bad_hash = valid.clone();
        bad_hash.payload_sha256 = "0".repeat(64);
        assert_eq!(
            validate_frame(&bad_hash),
            Err(BridgeError::PayloadHashMismatch)
        );

        let mut bad_count = valid;
        bad_count.record_count = Some(1);
        assert_eq!(
            validate_frame(&bad_count),
            Err(BridgeError::InvalidRecordBatch)
        );

        let payload = r#"{"dataset":"messages","records":[{"id":"m1","unknown":true}]}"#;
        let mut unknown_record_field = frame(0, payload);
        unknown_record_field.stream = StreamKind::Record;
        unknown_record_field.kind = FrameKind::Records;
        unknown_record_field.record_count = Some(1);
        assert_eq!(
            validate_frame(&unknown_record_field),
            Err(BridgeError::InvalidRecordBatch)
        );
    }

    #[test]
    fn account_binding_is_required_only_on_account_batch() {
        let fingerprint = "a".repeat(64);
        let payload = serde_json::json!({
            "dataset": "accounts",
            "accountBindingSha256": fingerprint,
            "records": [{"id": "synthetic-self@c.us"}]
        })
        .to_string();
        let mut account = frame(0, &payload);
        account.stream = StreamKind::Record;
        account.kind = FrameKind::Records;
        account.record_count = Some(1);
        assert_eq!(validate_frame(&account), Ok(()));

        let payload = serde_json::json!({
            "dataset": "accounts",
            "records": [{"id": "synthetic-self@c.us"}]
        })
        .to_string();
        let mut missing = frame(0, &payload);
        missing.stream = StreamKind::Record;
        missing.kind = FrameKind::Records;
        missing.record_count = Some(1);
        assert_eq!(
            validate_frame(&missing),
            Err(BridgeError::InvalidRecordBatch)
        );

        let mut misplaced = record_frame(0, 1);
        let payload: serde_json::Value =
            serde_json::from_str(&misplaced.payload).unwrap_or_default();
        let mut payload = payload.as_object().cloned().unwrap_or_default();
        payload.insert(
            "accountBindingSha256".to_owned(),
            serde_json::Value::String("a".repeat(64)),
        );
        misplaced.payload = serde_json::Value::Object(payload).to_string();
        misplaced.payload_bytes = u32::try_from(misplaced.payload.len()).unwrap_or(u32::MAX);
        misplaced.payload_sha256 = hex::encode(Sha256::digest(misplaced.payload.as_bytes()));
        assert_eq!(
            validate_frame(&misplaced),
            Err(BridgeError::InvalidRecordBatch)
        );
    }

    #[test]
    fn media_requires_canonical_base64_and_decoded_hash() {
        let bytes = [0_u8, 1, 2, 3];
        let mut media = frame(0, "");
        media.stream = StreamKind::Media;
        media.kind = FrameKind::MediaChunk;
        media.encoding = PayloadEncoding::Base64;
        media.payload = BASE64_STANDARD.encode(bytes);
        media.payload_bytes = 4;
        media.payload_sha256 = hex::encode(Sha256::digest(bytes));
        assert_eq!(validate_frame(&media), Ok(()));

        media.payload = media.payload.trim_end_matches('=').to_owned();
        assert_eq!(validate_frame(&media), Err(BridgeError::InvalidEncoding));
    }

    #[test]
    fn avatar_media_contract_is_image_only_and_rejects_page_urls() {
        let payload = serde_json::json!({
            "assetKey": "contact:synthetic-contact:avatar",
            "role": "avatar",
            "kind": "image",
            "declaredMime": "image/png",
            "originalFileName": null,
            "expectedSize": 8,
            "width": null,
            "height": null,
            "durationMs": null,
            "method": "cache_lookup",
            "attempts": 0,
            "networkActionAttempted": false
        })
        .to_string();
        let mut avatar = frame(0, &payload);
        avatar.kind = FrameKind::MediaStart;
        assert_eq!(validate_frame(&avatar), Ok(()));

        let mut wrong_kind: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
        wrong_kind["kind"] = serde_json::Value::String("video".to_owned());
        let wrong_kind_payload = wrong_kind.to_string();
        let mut wrong_kind_frame = frame(0, &wrong_kind_payload);
        wrong_kind_frame.kind = FrameKind::MediaStart;
        assert_eq!(
            validate_frame(&wrong_kind_frame),
            Err(BridgeError::InvalidFrameShape)
        );

        let mut leaked_url: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
        leaked_url["sourceUrl"] =
            serde_json::Value::String("https://pps.whatsapp.net/private".to_owned());
        let leaked_url_payload = leaked_url.to_string();
        let mut leaked_url_frame = frame(0, &leaked_url_payload);
        leaked_url_frame.kind = FrameKind::MediaStart;
        assert_eq!(
            validate_frame(&leaked_url_frame),
            Err(BridgeError::InvalidFrameShape)
        );
    }

    #[test]
    fn control_payloads_are_strict_and_write_capabilities_fail_closed() {
        let valid = probe_frame(0);
        assert_eq!(validate_frame(&valid), Ok(()));

        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&valid.payload);
        assert!(parsed.is_ok());
        let mut active = parsed.unwrap_or_default();
        if let Some(capabilities) = active
            .get_mut("capabilities")
            .and_then(serde_json::Value::as_object_mut)
        {
            capabilities.insert("domWrites".to_owned(), serde_json::Value::Bool(true));
        }
        let payload = active.to_string();
        let mut invalid = frame(0, &payload);
        invalid.kind = FrameKind::ProbeResult;
        assert_eq!(
            validate_frame(&invalid),
            Err(BridgeError::InvalidFrameShape)
        );

        let mut hostile_reason: serde_json::Value =
            serde_json::from_str(&valid.payload).unwrap_or_default();
        if let Some(object) = hostile_reason.as_object_mut() {
            object.insert("supported".to_owned(), serde_json::Value::Bool(false));
            object.insert("adapterId".to_owned(), serde_json::Value::Null);
            object.insert("accountBindingSha256".to_owned(), serde_json::Value::Null);
            object.insert(
                "reasons".to_owned(),
                serde_json::json!(["SECRET-JID-100000000000001@c.us"]),
            );
            if let Some(capabilities) = object
                .get_mut("capabilities")
                .and_then(serde_json::Value::as_object_mut)
            {
                for name in [
                    "passiveT0",
                    "comprehensiveReadonlyV02",
                    "accounts",
                    "contacts",
                    "chats",
                    "messages",
                    "media",
                    "historyLoading",
                    "networkActions",
                    "domWrites",
                ] {
                    capabilities.insert(name.to_owned(), serde_json::Value::Bool(false));
                }
                capabilities.insert(
                    "datasets".to_owned(),
                    serde_json::Value::Array(
                        DatasetKind::ALL
                            .iter()
                            .map(|dataset| {
                                serde_json::json!({
                                    "dataset": dataset,
                                    "result": "unsupported",
                                    "reasonCodes": ["collection_signature_mismatch"],
                                })
                            })
                            .collect(),
                    ),
                );
            }
        }
        let hostile_reason_payload = hostile_reason.to_string();
        let mut hostile_reason_frame = frame(0, &hostile_reason_payload);
        hostile_reason_frame.kind = FrameKind::ProbeResult;
        assert_eq!(
            validate_frame(&hostile_reason_frame),
            Err(BridgeError::InvalidFrameShape)
        );

        let extra = r#"{"code":"snapshot_failed","message":"snapshot_failed","extra":true}"#;
        assert_eq!(
            validate_frame(&frame(0, extra)),
            Err(BridgeError::InvalidFrameShape)
        );

        let untrusted_diagnostic = r#"{"code":"snapshot_failed","message":"100000000000001@c.us"}"#;
        assert_eq!(
            validate_frame(&frame(0, untrusted_diagnostic)),
            Err(BridgeError::InvalidFrameShape)
        );
    }

    #[test]
    fn partial_stream_end_accepts_only_fixed_omission_reasons() {
        let valid = partial_stream_end_frame(0);
        assert_eq!(validate_frame(&valid), Ok(()));

        for reason in [
            "global_message_container_unobservable_omitted",
            "media_inline_preview_omitted",
        ] {
            let mut real_world_partial: serde_json::Value =
                serde_json::from_str(&valid.payload).unwrap_or_default();
            real_world_partial["completeness"]["reasons"] = serde_json::json!([
                "account_scope_unverifiable",
                "store_only_no_ui_fallback",
                reason
            ]);
            let payload = real_world_partial.to_string();
            let mut partial_frame = frame(0, &payload);
            partial_frame.kind = FrameKind::StreamEnd;
            assert_eq!(
                validate_frame(&partial_frame),
                Ok(()),
                "Adapter-emitted omission reason must be accepted: {reason}"
            );
        }

        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&valid.payload);
        assert!(parsed.is_ok());
        let mut hostile = parsed.unwrap_or_default();
        hostile["completeness"]["reasons"] =
            serde_json::json!(["15551234567@c.us SYNTHETIC-CHAT-CONTENT"]);
        let payload = hostile.to_string();
        let mut hostile_frame = frame(0, &payload);
        hostile_frame.kind = FrameKind::StreamEnd;
        assert_eq!(
            validate_frame(&hostile_frame),
            Err(BridgeError::InvalidFrameShape)
        );
    }

    #[test]
    fn every_literal_adapter_omission_reason_is_in_the_host_allowlist() {
        let source = include_str!("../../../injector/src/collector.ts");
        let marker = "noteOmission(\"";
        let mut remaining = source;
        let mut found = 0_u32;
        while let Some(offset) = remaining.find(marker) {
            let value = &remaining[offset + marker.len()..];
            let end = value
                .find('"')
                .unwrap_or_else(|| panic!("unterminated literal noteOmission call"));
            let reason = &value[..end];
            assert!(
                valid_completeness_reason(reason),
                "Adapter omission reason is not accepted by the host: {reason}"
            );
            found += 1;
            remaining = &value[end + 1..];
        }
        assert!(found >= 10, "expected the Adapter omission contract corpus");
    }

    #[test]
    fn pull_and_ack_are_ordered_and_idempotent() {
        let validator = FrameValidator::new(SESSION);
        assert!(validator.is_ok());
        let mut validator = match validator {
            Ok(value) => value,
            Err(error) => panic!("unexpected validator error: {error}"),
        };
        let first = frame(0, ERROR_PAYLOAD);
        assert_eq!(validator.receive(&first), Ok(ReceiveOutcome::Accepted));
        assert_eq!(validator.receive(&first), Ok(ReceiveOutcome::Redelivery));

        let conflict = frame(0, r#"{"code":"other","message":"other"}"#);
        assert_eq!(
            validator.receive(&conflict),
            Err(BridgeError::InvalidFrameShape)
        );
        assert_eq!(
            validator.receive(&frame(1, ERROR_PAYLOAD)),
            Err(BridgeError::PendingAcknowledgement(DecimalSequence::new(0)))
        );
        assert_eq!(
            validator.acknowledge(DecimalSequence::new(0)),
            Ok(AckOutcome::Applied)
        );
        assert_eq!(
            validator.acknowledge(DecimalSequence::new(0)),
            Ok(AckOutcome::Duplicate)
        );
        assert_eq!(validator.next_sequence(), DecimalSequence::new(1));
        assert_eq!(
            validator.receive(&frame(1, ERROR_PAYLOAD)),
            Ok(ReceiveOutcome::Accepted)
        );
        assert_eq!(
            validator.acknowledge(DecimalSequence::new(2)),
            Err(BridgeError::AckOutOfOrder(DecimalSequence::new(2)))
        );
    }

    #[test]
    fn request_headers_bind_ack_and_dispatch_to_the_session() {
        let request = DispatchRequest {
            protocol: PROTOCOL.to_owned(),
            session_id: SESSION.to_owned(),
            command: DispatchCommand::Probe,
        };
        assert_eq!(validate_dispatch_request(&request, SESSION), Ok(()));
        assert_eq!(
            validate_dispatch_request(&request, "22222222-2222-4222-8222-222222222222"),
            Err(BridgeError::InvalidSession)
        );

        let validator = FrameValidator::new(SESSION);
        assert!(validator.is_ok());
        let mut validator = match validator {
            Ok(value) => value,
            Err(error) => panic!("unexpected validator error: {error}"),
        };
        assert_eq!(
            validator.receive(&frame(0, ERROR_PAYLOAD)),
            Ok(ReceiveOutcome::Accepted)
        );
        let wrong_session = AckRequest {
            protocol: PROTOCOL.to_owned(),
            session_id: "22222222-2222-4222-8222-222222222222".to_owned(),
            sequence: DecimalSequence::new(0),
        };
        assert_eq!(
            validator.acknowledge_request(&wrong_session),
            Err(BridgeError::InvalidSession)
        );
        let valid = AckRequest {
            protocol: PROTOCOL.to_owned(),
            session_id: SESSION.to_owned(),
            sequence: DecimalSequence::new(0),
        };
        assert_eq!(
            validator.acknowledge_request(&valid),
            Ok(AckOutcome::Applied)
        );
        assert_eq!(
            validator.acknowledge_request(&valid),
            Ok(AckOutcome::Duplicate)
        );
    }

    #[test]
    fn enforces_frame_and_queue_limits() {
        let oversized = "\"".to_owned() + &"x".repeat(MAX_CONTROL_BYTES) + "\"";
        let too_large = frame(0, &oversized);
        assert!(matches!(
            validate_frame(&too_large),
            Err(BridgeError::FrameTooLarge { .. })
        ));

        let data = record_frame(0, 1);
        let count = (MAX_QUEUE_BYTES / data.payload_bytes as usize) + 1;
        let queue = vec![data; count];
        assert!(matches!(
            validate_queue(&queue),
            Err(BridgeError::QueueTooLarge { .. })
        ));

        let invalid = record_frame(0, 257);
        assert_eq!(
            validate_frame(&invalid),
            Err(BridgeError::InvalidRecordBatch)
        );
    }

    #[test]
    fn injector_source_and_dist_are_identical_and_forbid_mutators() {
        let source = include_str!("../../../injector/src/collector.ts");
        let dist = include_str!("../../../injector/dist/collector.iife.js");
        assert_eq!(
            source, dist,
            "the checked-in IIFE must be the exact TypeScript source"
        );
        for forbidden in [
            "globalThis.",
            "sendMessage",
            "createGroup",
            ".click(",
            "appendChild",
            "innerHTML",
            "eval(",
            "new Function",
        ] {
            assert!(
                !source.contains(forbidden),
                "forbidden injector primitive: {forbidden}"
            );
        }
    }
}
