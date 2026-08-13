//! Stable rules for mapping page-observed native identities to WAEB references.
//!
//! Keeping these rules separate from record serialization makes collective
//! containers (groups, Status broadcast threads and channels) harder to
//! accidentally materialize as people.

use page_bridge::DatasetKind;

pub(super) fn actor_record_type(
    dataset: DatasetKind,
    native_id: &str,
    self_native_id: Option<&str>,
) -> &'static str {
    if self_native_id == Some(native_id) {
        "account"
    } else if dataset == DatasetKind::ChannelEvents && native_id.ends_with("@newsletter") {
        "channel"
    } else {
        "contact"
    }
}

pub(super) fn recipient_record_type(
    dataset: DatasetKind,
    native_id: &str,
    container_native_id: &str,
    self_native_id: Option<&str>,
) -> Option<&'static str> {
    if self_native_id == Some(native_id) {
        return Some("account");
    }
    if dataset == DatasetKind::ChannelEvents && native_id.ends_with("@newsletter") {
        return Some("channel");
    }
    if native_id == container_native_id && is_collective_container(native_id) {
        return None;
    }
    Some("contact")
}

fn is_collective_container(native_id: &str) -> bool {
    native_id == "status@broadcast"
        || native_id.ends_with("@broadcast")
        || native_id.ends_with("@g.us")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collective_container_is_not_fabricated_as_a_contact() {
        assert_eq!(
            recipient_record_type(
                DatasetKind::Statuses,
                "status@broadcast",
                "status@broadcast",
                Some("self@c.us")
            ),
            None
        );
        assert_eq!(
            recipient_record_type(
                DatasetKind::Messages,
                "group@g.us",
                "group@g.us",
                Some("self@c.us")
            ),
            None
        );
    }

    #[test]
    fn individual_and_channel_identities_keep_valid_actor_types() {
        assert_eq!(
            recipient_record_type(
                DatasetKind::Messages,
                "peer@c.us",
                "peer@c.us",
                Some("self@c.us")
            ),
            Some("contact")
        );
        assert_eq!(
            actor_record_type(DatasetKind::Messages, "self@c.us", Some("self@c.us")),
            "account"
        );
        assert_eq!(
            actor_record_type(
                DatasetKind::ChannelEvents,
                "observed@newsletter",
                Some("self@c.us")
            ),
            "channel"
        );
    }
}
