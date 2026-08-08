/// A trusted schema embedded into the Collector executable.
#[derive(Clone, Copy, Debug)]
pub struct EmbeddedSchema {
    /// Package-relative path.
    pub path: &'static str,
    /// Exact checked-in bytes. They are copied without normalization.
    pub bytes: &'static [u8],
}

macro_rules! schema {
    ($path:literal) => {
        EmbeddedSchema {
            path: concat!("schemas/", $path),
            bytes: include_bytes!(concat!(
                "../../../../spec/wa-evidence-bag/v1/schemas/",
                $path
            )),
        }
    };
}

/// Exact and ordered WAEB v1 trusted schema set.
pub const EMBEDDED_SCHEMAS: [EmbeddedSchema; 22] = [
    schema!("acquisition-1.0.schema.json"),
    schema!("acquisition-event-1.0.schema.json"),
    schema!("capabilities-1.0.schema.json"),
    schema!("chat-completeness-1.0.schema.json"),
    schema!("common-1.0.schema.json"),
    schema!("completeness-1.0.schema.json"),
    schema!("dataset-inventory-1.0.schema.json"),
    schema!("evidence-record-1.0.schema.json"),
    schema!("index.json"),
    schema!("media-record-1.0.schema.json"),
    schema!("raw-record-1.0.schema.json"),
    schema!("records/account-1.0.schema.json"),
    schema!("records/chat-1.0.schema.json"),
    schema!("records/chat-list-1.0.schema.json"),
    schema!("records/contact-1.0.schema.json"),
    schema!("records/event-1.0.schema.json"),
    schema!("records/generic-entity-1.0.schema.json"),
    schema!("records/message-1.0.schema.json"),
    schema!("records/participant-1.0.schema.json"),
    schema!("records/relation-1.0.schema.json"),
    schema!("seal-1.0.schema.json"),
    schema!("signer-1.0.schema.json"),
];
