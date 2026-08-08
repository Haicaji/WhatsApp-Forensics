//! Streaming, fail-closed writer for WA Evidence Bag v1.
//!
//! The writer owns a fixed `waeb-<evidence-id>.partial` staging directory and
//! exposes no API that accepts arbitrary package paths. A sealed bag remains
//! below its `.partial` wrapper until the caller records successful independent
//! verification and invokes the fixed-path promotion API.

mod dto;
mod jcs;
mod schemas;
mod writer;

pub use dto::*;
pub use jcs::{canonicalize, canonicalize_line, sha256_hex, sha512_hex};
pub use schemas::{EMBEDDED_SCHEMAS, EmbeddedSchema};
pub use writer::{
    LogChainState, MediaAsset, MediaStream, PromotedBag, SealOptions, SealedBag, WaebError,
    WaebWriter,
};

/// WA Evidence Bag format implemented by this crate.
pub const WAEB_VERSION: &str = "1.0.0-draft.1";

/// Version used by all v1 JSON payloads.
pub const SCHEMA_VERSION: &str = "1.0.0";

/// Fixed, ordered normalized dataset contract.
pub const DATASETS: [DatasetSpec; 18] = [
    DatasetSpec::new("accounts", "data/normalized/accounts.ndjson", "account"),
    DatasetSpec::new("contacts", "data/normalized/contacts.ndjson", "contact"),
    DatasetSpec::new("chats", "data/normalized/chats.ndjson", "chat"),
    DatasetSpec::new(
        "chat_lists",
        "data/normalized/chat-lists.ndjson",
        "chat_list",
    ),
    DatasetSpec::new(
        "participants",
        "data/normalized/participants.ndjson",
        "participant",
    ),
    DatasetSpec::new("messages", "data/normalized/messages.ndjson", "message"),
    DatasetSpec::new(
        "message_events",
        "data/normalized/message-events.ndjson",
        "message_event",
    ),
    DatasetSpec::new("reactions", "data/normalized/reactions.ndjson", "reaction"),
    DatasetSpec::new("receipts", "data/normalized/receipts.ndjson", "receipt"),
    DatasetSpec::new(
        "poll_votes",
        "data/normalized/poll-votes.ndjson",
        "poll_vote",
    ),
    DatasetSpec::new(
        "group_events",
        "data/normalized/group-events.ndjson",
        "group_event",
    ),
    DatasetSpec::new("statuses", "data/normalized/statuses.ndjson", "status"),
    DatasetSpec::new("calls", "data/normalized/calls.ndjson", "call"),
    DatasetSpec::new("channels", "data/normalized/channels.ndjson", "channel"),
    DatasetSpec::new(
        "channel_events",
        "data/normalized/channel-events.ndjson",
        "channel_event",
    ),
    DatasetSpec::new(
        "communities",
        "data/normalized/communities.ndjson",
        "community",
    ),
    DatasetSpec::new(
        "community_relations",
        "data/normalized/community-relations.ndjson",
        "community_relation",
    ),
    DatasetSpec::new(
        "presence_snapshots",
        "data/normalized/presence-snapshots.ndjson",
        "presence_snapshot",
    ),
];

/// Fixed capability order: the 18 datasets followed by media.
pub const CAPABILITY_NAMES: [&str; 19] = [
    "accounts",
    "contacts",
    "chats",
    "chat_lists",
    "participants",
    "messages",
    "message_events",
    "reactions",
    "receipts",
    "poll_votes",
    "group_events",
    "statuses",
    "calls",
    "channels",
    "channel_events",
    "communities",
    "community_relations",
    "presence_snapshots",
    "media",
];
