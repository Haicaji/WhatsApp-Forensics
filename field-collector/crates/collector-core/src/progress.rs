//! Operator-facing acquisition progress.
//!
//! Progress is deliberately separated from acquisition orchestration. Fixed
//! Evidence Bag paths may be serialized, while an original media filename is
//! retained only for the local GUI and never enters audit logs or handoff JSON.

use serde::Serialize;

/// A bounded snapshot of the currently active collection operation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionProgress {
    /// Stable acquisition phase.
    pub phase: String,
    /// Fixed status code localized by the GUI.
    pub status_code: String,
    /// Completed units in this phase.
    pub completed: u64,
    /// Known total units, or zero when indeterminate.
    pub total: u64,
    /// One-based active media position.
    pub media_index: Option<u64>,
    /// Total media tasks in the signed plan.
    pub media_total: Option<u64>,
    /// Current network attempt when applicable.
    pub attempt: Option<u32>,
    /// Bytes committed for the active asset.
    pub current_asset_bytes: u64,
    /// Bytes committed for all completed media assets.
    pub total_media_bytes: u64,
    /// Seconds elapsed in the bound collection session.
    pub elapsed_seconds: u64,
    /// Stable WAEB dataset name currently being written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_dataset: Option<String>,
    /// Safe Evidence Bag-relative output path without evidence identifiers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_output_path: Option<String>,
    /// Fixed media kind (`image`, `video`, `document`, and so on).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_media_kind: Option<String>,
    /// Bounded original filename shown only in the local field UI.
    #[serde(skip)]
    pub current_file_name: Option<String>,
}

impl AcquisitionProgress {
    pub(crate) fn without_item(
        phase: impl Into<String>,
        status_code: impl Into<String>,
        elapsed_seconds: u64,
    ) -> Self {
        Self {
            phase: phase.into(),
            status_code: status_code.into(),
            completed: 0,
            total: 0,
            media_index: None,
            media_total: None,
            attempt: None,
            current_asset_bytes: 0,
            total_media_bytes: 0,
            elapsed_seconds,
            current_dataset: None,
            current_output_path: None,
            current_media_kind: None,
            current_file_name: None,
        }
    }
}

pub(crate) fn normalized_output_path(dataset: &str) -> String {
    format!("data/normalized/{dataset}.ndjson")
}

pub(crate) fn bounded_original_file_name(value: Option<&str>) -> Option<String> {
    let leaf = value?.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if leaf.is_empty() || matches!(leaf, "." | "..") {
        return None;
    }
    let sanitized = leaf
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect::<String>();
    (!sanitized.is_empty()).then_some(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_filename_is_leaf_only_bounded_and_not_serialized() {
        let name = bounded_original_file_name(Some("../../folder\\evidence-file.pdf\n"));
        assert_eq!(name.as_deref(), Some("evidence-file.pdf"));
        let mut progress = AcquisitionProgress::without_item("media", "media_start", 0);
        progress.current_file_name = name;
        let serialized = serde_json::to_string(&progress)
            .unwrap_or_else(|error| panic!("serialize progress: {error}"));
        assert!(!serialized.contains("evidence-file.pdf"));
    }
}
