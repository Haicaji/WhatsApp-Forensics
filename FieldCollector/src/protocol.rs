//! Stable messages exchanged with the browser extension and page extractor.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Extension-to-host protocol identifier.
pub const EXTENSION_PROTOCOL: &str = "field-collector-extension/1";
/// Extractor frame protocol identifier.
pub const EXTRACTOR_PROTOCOL: &str = "field-collector-extractor/1";
/// Fixed loopback port used by the prototype extension.
pub const PAIRING_PORT: u16 = 17_654;
/// Maximum JSON WebSocket message accepted from the extension.
pub const MAX_WIRE_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// User-selected, bounded extraction policy passed to the fixed page controller.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct AcquisitionPolicy {
    pub include_statuses: bool,
    pub include_calls: bool,
    pub include_channels: bool,
    pub include_chat_media: bool,
    pub include_channel_media: bool,
    pub include_avatars: bool,
    /// Inclusive rolling channel window in days.
    pub channel_days: u32,
    /// Zero means unlimited; otherwise the complete original/preview must fit.
    pub max_media_bytes: u64,
}

impl Default for AcquisitionPolicy {
    fn default() -> Self {
        Self {
            include_statuses: true,
            include_calls: true,
            include_channels: true,
            include_chat_media: true,
            include_channel_media: true,
            include_avatars: true,
            channel_days: 15,
            max_media_bytes: 0,
        }
    }
}

/// One pull-based frame returned by the MAIN-world controller.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractorFrame {
    pub protocol: String,
    pub sequence: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

impl ExtractorFrame {
    /// Validate the small invariant surface before any data is written.
    pub fn validate(&self, expected_sequence: u64) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.protocol == EXTRACTOR_PROTOCOL,
            "extractor protocol mismatch"
        );
        anyhow::ensure!(
            self.sequence == expected_sequence.to_string(),
            "extractor frame sequence mismatch"
        );
        anyhow::ensure!(
            matches!(
                self.kind.as_str(),
                "capabilities"
                    | "dataset_batch"
                    | "chat_begin"
                    | "chat_end"
                    | "media_start"
                    | "media_chunk"
                    | "media_end"
                    | "media_failure"
                    | "progress"
                    | "complete"
                    | "error"
            ),
            "unknown extractor frame kind"
        );
        Ok(())
    }
}

/// High-level acquisition events consumed by the native UI.
#[derive(Clone, Debug)]
pub enum AcquisitionEvent {
    Status(String),
    Progress(Value),
    Complete(std::path::PathBuf),
    Failed(String),
}

/// Extract the by-value payload nested in a `Chrome DevTools Protocol` response.
pub fn cdp_value(response: &Value) -> anyhow::Result<Value> {
    if let Some(description) = response
        .pointer("/exceptionDetails/exception/description")
        .and_then(Value::as_str)
    {
        anyhow::bail!("page exception: {description}");
    }
    let value = response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("CDP response did not contain a by-value result"))?;
    if let Some(encoded) = value.as_str() {
        return serde_json::from_str(encoded)
            .map_err(|error| anyhow::anyhow!("page returned invalid JSON text: {error}"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AcquisitionPolicy, EXTRACTOR_PROTOCOL, ExtractorFrame, cdp_value};

    #[test]
    fn default_policy_serializes_with_bounded_camel_case_fields() {
        let value = serde_json::to_value(AcquisitionPolicy::default()).unwrap_or_default();
        assert_eq!(value["includeStatuses"], true);
        assert_eq!(value["includeCalls"], true);
        assert_eq!(value["includeChannels"], true);
        assert_eq!(value["includeChatMedia"], true);
        assert_eq!(value["includeChannelMedia"], true);
        assert_eq!(value["includeAvatars"], true);
        assert_eq!(value["channelDays"], 15);
        assert_eq!(value["maxMediaBytes"], 0);
    }

    #[test]
    fn validates_exact_frame_sequence() {
        let frame = ExtractorFrame {
            protocol: EXTRACTOR_PROTOCOL.to_owned(),
            sequence: "3".to_owned(),
            kind: "progress".to_owned(),
            payload: json!({}),
        };
        assert!(frame.validate(3).is_ok());
        assert!(frame.validate(2).is_err());
    }

    #[test]
    fn extracts_runtime_value() {
        let value = cdp_value(&json!({"result": {"value": {"ok": true}}}));
        assert_eq!(value.ok(), Some(json!({"ok": true})));
    }

    #[test]
    fn decodes_page_serialized_frames_without_cdp_object_traversal() {
        let response = json!({"result": {"value": "{\"kind\":\"dataset_batch\",\"payload\":{\"raw\":{\"nested\":true}}}"}});
        let value = cdp_value(&response).unwrap_or_default();
        assert_eq!(value["kind"], "dataset_batch");
        assert_eq!(value["payload"]["raw"]["nested"], true);
    }
}
