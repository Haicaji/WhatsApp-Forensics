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
pub const PROTOCOL: &str = "wafc-bridge/1";
/// Controller version paired with this host implementation.
pub const CONTROLLER_VERSION: &str = "0.1.0";
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

/// Dataset names supported by the read-only T0 adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetKind {
    /// The currently logged-in account.
    Accounts,
    /// Locally observable contacts.
    Contacts,
    /// Locally observable chats.
    Chats,
    /// Locally observable messages.
    Messages,
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
}

/// Commands accepted by `dispatch`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchCommand {
    /// Probe the fixed private-module capability signature.
    Probe,
    /// Start a passive, locally observable T0 snapshot.
    StartT0,
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
    /// Active history loading is available (always false in v0.1).
    pub history_loading: bool,
    /// Network-affecting operations are available (always false in v0.1).
    pub network_actions: bool,
    /// DOM mutation is available (always false in v0.1).
    pub dom_writes: bool,
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
    /// Per-dataset observed counts.
    pub datasets: Vec<DatasetObservationPayload>,
}

/// Supported acquisition operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    /// Passive T0 snapshot.
    T0,
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
    /// Message record count.
    pub messages: u64,
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
    /// T0 never loads history.
    NotRun,
}

/// Media acquisition completeness enum.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaCompleteness {
    /// T0 never requests media bytes.
    NotRequested,
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
    /// Per-dataset totals.
    pub totals: DatasetTotalsPayload,
    /// Explicit scope limitations.
    pub completeness: CompletenessPayload,
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
/// The v0.1 injector normally holds just one frame, but this guard is also used
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
                DatasetKind::Contacts | DatasetKind::Chats | DatasetKind::Messages => {
                    probe.account_binding_sha256.is_none()
                }
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
            | "unknown_build"
    )
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
        DatasetKind::Messages => {
            serde_json::from_slice::<RecordBatchPayload<MessageRecord>>(decoded)
                .map(|batch| batch.dataset)
        }
    }
    .map_err(|_| BridgeError::InvalidRecordBatch)?;
    if parsed_dataset != dataset {
        return Err(BridgeError::InvalidRecordBatch);
    }
    Ok(())
}

fn validate_control_payload(kind: FrameKind, decoded: &[u8]) -> Result<(), BridgeError> {
    match kind {
        FrameKind::ProbeResult => {
            let payload: ProbeResultPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            let active_capability = payload.capabilities.history_loading
                || payload.capabilities.network_actions
                || payload.capabilities.dom_writes
                || payload.capabilities.media;
            let read_capabilities = payload.capabilities.passive_t0
                && payload.capabilities.accounts
                && payload.capabilities.contacts
                && payload.capabilities.chats
                && payload.capabilities.messages;
            if payload.protocol != PROTOCOL
                || payload.controller_version != CONTROLLER_VERSION
                || active_capability
                || (payload.supported
                    && (payload.adapter_id.as_deref() != Some("wa-private-collections-v1")
                        || !payload
                            .account_binding_sha256
                            .as_deref()
                            .is_some_and(valid_account_binding)
                        || !read_capabilities
                        || !payload.reasons.is_empty()))
                || (!payload.supported
                    && (payload.adapter_id.is_some()
                        || payload.account_binding_sha256.is_some()
                        || payload.capabilities.passive_t0
                        || payload.reasons.is_empty()
                        || !payload
                            .reasons
                            .iter()
                            .all(|reason| valid_probe_reason(reason))))
            {
                return Err(BridgeError::InvalidFrameShape);
            }
            Ok(())
        }
        FrameKind::StreamStart => {
            let payload: StreamStartPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            let expected = [
                DatasetKind::Accounts,
                DatasetKind::Contacts,
                DatasetKind::Chats,
                DatasetKind::Messages,
            ];
            if payload.datasets.len() != expected.len()
                || !valid_account_binding(&payload.account_binding_sha256)
                || !expected
                    .iter()
                    .all(|kind| payload.datasets.iter().any(|item| item.dataset == *kind))
            {
                return Err(BridgeError::InvalidFrameShape);
            }
            Ok(())
        }
        FrameKind::StreamEnd => {
            let payload: StreamEndPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            if payload.completeness.reasons.is_empty()
                || !valid_account_binding(&payload.account_binding_sha256)
            {
                return Err(BridgeError::InvalidFrameShape);
            }
            Ok(())
        }
        FrameKind::Error => {
            let payload: ErrorPayload =
                serde_json::from_slice(decoded).map_err(|_| BridgeError::InvalidFrameShape)?;
            if payload.code != "snapshot_failed" || payload.message != "snapshot_failed" {
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
        let payload = serde_json::json!({
            "protocol": PROTOCOL,
            "controllerVersion": CONTROLLER_VERSION,
            "supported": true,
            "adapterId": "wa-private-collections-v1",
            "build": "test-build",
            "accountBindingSha256": "a".repeat(64),
            "reasons": [],
            "capabilities": {
                "passiveT0": true,
                "accounts": true,
                "contacts": true,
                "chats": true,
                "messages": true,
                "media": false,
                "historyLoading": false,
                "networkActions": false,
                "domWrites": false
            }
        })
        .to_string();
        let mut result = frame(sequence, &payload);
        result.kind = FrameKind::ProbeResult;
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
    fn control_payloads_are_strict_and_active_capabilities_fail_closed() {
        let valid = probe_frame(0);
        assert_eq!(validate_frame(&valid), Ok(()));

        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&valid.payload);
        assert!(parsed.is_ok());
        let mut active = parsed.unwrap_or_default();
        if let Some(capabilities) = active
            .get_mut("capabilities")
            .and_then(serde_json::Value::as_object_mut)
        {
            capabilities.insert("networkActions".to_owned(), serde_json::Value::Bool(true));
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
                for name in ["passiveT0", "accounts", "contacts", "chats", "messages"] {
                    capabilities.insert(name.to_owned(), serde_json::Value::Bool(false));
                }
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
