use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead as _, BufReader};

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use crate::schema::SchemaValidator;
use crate::{BagTree, HashAlgorithm, Result, invalid, strict_json, trusted_schema};

const MAX_JSON_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct SemanticSummary {
    pub(crate) normalized_records: usize,
    pub(crate) datasets: usize,
    pub(crate) media_assets: usize,
    pub(crate) log_events: usize,
    pub(crate) chat_completeness_records: usize,
}

struct DatasetDefinition {
    name: String,
    path: String,
    record_type: String,
    data_schema: String,
}

struct NormalizedRecords {
    by_dataset: HashMap<String, Vec<Value>>,
    types: HashMap<String, String>,
    all: Vec<Value>,
    asset_refs: Vec<AssetReference>,
}

struct MediaSummary {
    records: Vec<Value>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AssetReferenceKind {
    Attachment,
    Profile,
    EntityMedia,
}

struct AssetReference {
    source_id: String,
    asset_id: String,
    kind: AssetReferenceKind,
}

struct MediaDescriptor {
    role: String,
    sources: HashSet<String>,
    related: HashSet<String>,
}

pub(crate) fn verify(tree: &BagTree, sealed_evidence_id: &str) -> Result<SemanticSummary> {
    let validator = SchemaValidator::new()?;
    let definitions = dataset_definitions()?;

    let acquisition = read_json(tree, "data/acquisition.json")?;
    validator.validate(
        "acquisition-1.0.schema.json",
        &acquisition,
        "data/acquisition.json",
    )?;
    let source_id = required_string(&acquisition, "sourceId", "acquisition")?;
    let evidence_id = required_string(&acquisition, "evidenceId", "acquisition")?;
    if evidence_id != sealed_evidence_id {
        return Err(invalid(
            "evidence_id_mismatch",
            "acquisition evidenceId differs from the signed seal",
        ));
    }

    let (log_events, terminal_hash) = verify_log(tree, &validator, &acquisition)?;
    let acquisition_terminal = acquisition
        .pointer("/log/terminalEventHash")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("semantic_contract", "acquisition log metadata is absent"))?;
    if acquisition_terminal != terminal_hash {
        return Err(invalid(
            "log_terminal_hash",
            "acquisition terminalEventHash differs from the verified log chain",
        ));
    }

    let capabilities = verify_capabilities(tree, &validator, source_id, &definitions)?;
    let normalized = verify_normalized_and_raw(tree, &validator, source_id, &definitions)?;
    let inventory = verify_inventory(
        tree,
        &validator,
        source_id,
        &definitions,
        &normalized.by_dataset,
        &capabilities,
    )?;
    let media = verify_media(tree, &validator, source_id, &normalized)?;
    let chat_completeness_records = verify_completeness(
        tree,
        &validator,
        source_id,
        &normalized,
        &media,
        &inventory,
        &capabilities,
    )?;

    Ok(SemanticSummary {
        normalized_records: normalized.all.len(),
        datasets: definitions.len(),
        media_assets: media.records.len(),
        log_events,
        chat_completeness_records,
    })
}

fn dataset_definitions() -> Result<Vec<DatasetDefinition>> {
    let index = strict_json::from_slice(trusted_schema("index.json")?, "trusted schema index")?;
    let record_schemas = index
        .get("recordDataSchemas")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("trusted_contract", "schema index lacks recordDataSchemas"))?;
    let datasets = index
        .get("datasets")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("trusted_contract", "schema index lacks datasets"))?;
    let mut definitions = Vec::with_capacity(datasets.len());
    for dataset in datasets {
        let name = required_string(dataset, "name", "trusted dataset")?.to_owned();
        let path = required_string(dataset, "path", "trusted dataset")?.to_owned();
        let record_type = required_string(dataset, "recordType", "trusted dataset")?.to_owned();
        let data_schema = record_schemas
            .get(&record_type)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                invalid(
                    "trusted_contract",
                    format!("recordDataSchemas lacks {record_type}"),
                )
            })?
            .to_owned();
        definitions.push(DatasetDefinition {
            name,
            path,
            record_type,
            data_schema,
        });
    }
    if definitions.len() != 18 {
        return Err(invalid(
            "trusted_contract",
            "v1 must contain exactly 18 normalized datasets",
        ));
    }
    Ok(definitions)
}

#[allow(clippy::too_many_lines)]
fn verify_log(
    tree: &BagTree,
    validator: &SchemaValidator,
    acquisition: &Value,
) -> Result<(usize, String)> {
    let events = read_ndjson(tree, "data/logs/acquisition.ndjson")?;
    if events.is_empty() {
        return Err(invalid("empty_log", "acquisition log is empty"));
    }
    let mut previous: Option<String> = None;
    let mut session_id: Option<&str> = None;
    let mut previous_offset = 0_u128;
    for (index, event) in events.iter().enumerate() {
        let label = format!("data/logs/acquisition.ndjson:{}", index + 1);
        validator.validate("acquisition-event-1.0.schema.json", event, &label)?;
        let sequence = required_string(event, "sequence", &label)?;
        if sequence != (index + 1).to_string() {
            return Err(invalid(
                "log_sequence",
                format!("non-contiguous acquisition log sequence at {label}"),
            ));
        }
        let current_session = required_string(event, "sessionId", &label)?;
        if let Some(expected) = session_id {
            if current_session != expected {
                return Err(invalid("log_session", "acquisition log sessionId changed"));
            }
        } else {
            session_id = Some(current_session);
        }
        let offset = required_string(event, "monotonicOffsetNs", &label)?
            .parse::<u128>()
            .map_err(|_| invalid("log_monotonic", format!("bad monotonic offset at {label}")))?;
        if index > 0 && offset < previous_offset {
            return Err(invalid(
                "log_monotonic",
                format!("monotonic offset regressed at {label}"),
            ));
        }
        previous_offset = offset;
        let declared_previous = event.get("previousEventHash").and_then(Value::as_str);
        if declared_previous != previous.as_deref() {
            return Err(invalid(
                "log_previous_hash",
                format!("broken previousEventHash at sequence {sequence}"),
            ));
        }
        let mut without_hash = event.clone();
        without_hash
            .as_object_mut()
            .ok_or_else(|| {
                invalid(
                    "semantic_contract",
                    format!("event is not object at {label}"),
                )
            })?
            .remove("eventHash");
        let canonical = serde_jcs::to_vec(&without_hash).map_err(|error| {
            invalid(
                "jcs_error",
                format!("cannot canonicalize acquisition event {sequence}: {error}"),
            )
        })?;
        let mut hasher = Sha256::new();
        hasher.update(b"WAEB-LOG-v1\0");
        if let Some(previous_hex) = &previous {
            let previous_bytes = hex::decode(previous_hex).map_err(|_| {
                invalid(
                    "log_previous_hash",
                    format!("invalid previous hash at sequence {sequence}"),
                )
            })?;
            hasher.update(previous_bytes);
        } else {
            hasher.update([0_u8; 32]);
        }
        hasher.update(canonical);
        let expected = hex::encode(hasher.finalize());
        let declared = required_string(event, "eventHash", &label)?;
        if declared != expected {
            return Err(invalid(
                "log_event_hash",
                format!("invalid eventHash at sequence {sequence}"),
            ));
        }
        previous = Some(expected);
    }
    let declared_count = acquisition
        .pointer("/log/eventCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("semantic_contract", "acquisition log.eventCount is absent"))?;
    if usize::try_from(declared_count).ok() != Some(events.len()) {
        return Err(invalid(
            "log_event_count",
            "acquisition eventCount differs from the log",
        ));
    }
    let first_type = events[0].pointer("/event/type").and_then(Value::as_str);
    let last_type = events
        .last()
        .and_then(|event| event.pointer("/event/type"))
        .and_then(Value::as_str);
    if !matches!(
        first_type,
        Some("acquisition_started" | "acquisition_resumed")
    ) || last_type != Some("acquisition_completed")
    {
        return Err(invalid(
            "log_terminal_event",
            "acquisition log must begin with a start/resume event and end with acquisition_completed",
        ));
    }
    let terminal = previous.ok_or_else(|| invalid("empty_log", "acquisition log is empty"))?;
    Ok((events.len(), terminal))
}

fn verify_capabilities(
    tree: &BagTree,
    validator: &SchemaValidator,
    source_id: &str,
    definitions: &[DatasetDefinition],
) -> Result<HashMap<String, String>> {
    let path = "data/diagnostics/capabilities.json";
    let document = read_json(tree, path)?;
    validator.validate("capabilities-1.0.schema.json", &document, path)?;
    require_source_id(&document, source_id, path)?;
    let rows = document
        .get("capabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("semantic_contract", "capabilities array is absent"))?;
    let names: Vec<_> = rows
        .iter()
        .filter_map(|entry| entry.get("name").and_then(Value::as_str))
        .collect();
    let mut expected: Vec<_> = definitions.iter().map(|item| item.name.as_str()).collect();
    expected.push("media");
    if names != expected || names.iter().collect::<HashSet<_>>().len() != names.len() {
        return Err(invalid(
            "capability_registry",
            "capability names/order differ from the trusted v1 registry",
        ));
    }
    rows.iter()
        .map(|row| {
            Ok((
                required_string(row, "name", path)?.to_owned(),
                required_string(row, "result", path)?.to_owned(),
            ))
        })
        .collect()
}

fn verify_normalized_and_raw(
    tree: &BagTree,
    validator: &SchemaValidator,
    source_id: &str,
    definitions: &[DatasetDefinition],
) -> Result<NormalizedRecords> {
    let expected_normalized: HashSet<_> =
        definitions.iter().map(|item| item.path.as_str()).collect();
    for path in tree.sorted_paths_with_prefix("data/normalized/") {
        if !expected_normalized.contains(path.as_str()) {
            return Err(invalid(
                "normalized_file_set",
                format!("unexpected normalized dataset file: {path}"),
            ));
        }
    }

    let mut all = Vec::new();
    let mut by_dataset = HashMap::new();
    let mut ids = HashSet::new();
    let mut types = HashMap::new();
    let mut asset_refs = Vec::new();
    for definition in definitions {
        let records = read_ndjson(tree, &definition.path)?;
        for (index, record) in records.iter().enumerate() {
            let label = format!("{}:{}", definition.path, index + 1);
            validator.validate("evidence-record-1.0.schema.json", record, &label)?;
            validator.validate(
                &definition.data_schema,
                record.get("data").ok_or_else(|| {
                    invalid("semantic_contract", format!("missing data at {label}"))
                })?,
                &format!("{label}.data"),
            )?;
            if required_string(record, "recordType", &label)? != definition.record_type {
                return Err(invalid(
                    "record_type",
                    format!("recordType differs from dataset registry at {label}"),
                ));
            }
            require_source_id(record, source_id, &label)?;
            let record_id = required_string(record, "recordId", &label)?.to_owned();
            if !ids.insert(record_id.clone()) {
                return Err(invalid(
                    "duplicate_record_id",
                    format!("duplicate normalized recordId: {record_id}"),
                ));
            }
            types.insert(record_id.clone(), definition.record_type.clone());
            let expected_hash = canonical_sha256(
                record.get("data").ok_or_else(|| {
                    invalid("semantic_contract", format!("missing data at {label}"))
                })?,
                &label,
            )?;
            if required_string(record, "contentSha256", &label)? != expected_hash {
                return Err(invalid(
                    "normalized_content_hash",
                    format!("contentSha256 mismatch for {record_id}"),
                ));
            }
            collect_asset_refs(record, &record_id, &mut asset_refs);
            all.push(record.clone());
        }
        by_dataset.insert(definition.name.clone(), records);
    }

    let raw_records = verify_raw(tree, validator)?;
    verify_provenance(&all, &raw_records)?;
    verify_normalized_references(&all, &types)?;
    Ok(NormalizedRecords {
        by_dataset,
        types,
        all,
        asset_refs,
    })
}

fn verify_raw(tree: &BagTree, validator: &SchemaValidator) -> Result<HashMap<String, String>> {
    let mut records = HashMap::new();
    for path in tree.sorted_paths_with_prefix("data/raw/") {
        let components: Vec<_> = path.split('/').collect();
        if components.len() != 5
            || components[0] != "data"
            || components[1] != "raw"
            || !matches!(components[2], "baseline" | "enriched")
            || !matches!(components[3], "store" | "indexeddb" | "dom_validation")
            || !components[4].ends_with(".ndjson")
        {
            return Err(invalid(
                "raw_file_set",
                format!("invalid raw dataset path: {path}"),
            ));
        }
        let phase = components[2];
        let provider = components[3];
        for (index, record) in read_ndjson(tree, &path)?.iter().enumerate() {
            let label = format!("{path}:{}", index + 1);
            validator.validate("raw-record-1.0.schema.json", record, &label)?;
            if required_string(record, "phase", &label)? != phase
                || required_string(record, "provider", &label)? != provider
            {
                return Err(invalid(
                    "raw_path_metadata",
                    format!("raw record phase/provider differs from its path at {label}"),
                ));
            }
            let record_id = required_string(record, "recordId", &label)?;
            let expected_hash = canonical_sha256(
                record.get("value").ok_or_else(|| {
                    invalid("semantic_contract", format!("missing raw value at {label}"))
                })?,
                &label,
            )?;
            if required_string(record, "contentSha256", &label)? != expected_hash {
                return Err(invalid(
                    "raw_content_hash",
                    format!("raw contentSha256 mismatch at {label}"),
                ));
            }
            let key = format!("{path}#{record_id}");
            if records.insert(key.clone(), expected_hash).is_some() {
                return Err(invalid(
                    "duplicate_raw_record",
                    format!("duplicate raw record reference: {key}"),
                ));
            }
        }
    }
    Ok(records)
}

fn verify_provenance(records: &[Value], raw: &HashMap<String, String>) -> Result<()> {
    for record in records {
        let record_id = required_string(record, "recordId", "normalized record")?;
        let provenance = record
            .get("provenance")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("semantic_contract", "normalized provenance is absent"))?;
        for item in provenance {
            let Some(reference) = item.get("rawRef") else {
                continue;
            };
            let path = required_string(reference, "path", "rawRef")?;
            let raw_id = required_string(reference, "recordId", "rawRef")?;
            let digest = required_string(reference, "contentSha256", "rawRef")?;
            let key = format!("{path}#{raw_id}");
            let actual = raw.get(&key).ok_or_else(|| {
                invalid(
                    "dangling_raw_ref",
                    format!("dangling rawRef in {record_id}: {key}"),
                )
            })?;
            if actual != digest {
                return Err(invalid(
                    "raw_ref_hash",
                    format!("rawRef hash mismatch in {record_id}: {key}"),
                ));
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn verify_normalized_references(records: &[Value], types: &HashMap<String, String>) -> Result<()> {
    for record in records {
        let record_id = required_string(record, "recordId", "normalized record")?;
        let record_type = required_string(record, "recordType", record_id)?;
        let data = record
            .get("data")
            .ok_or_else(|| invalid("semantic_contract", format!("missing data: {record_id}")))?;
        match record_type {
            "chat" => check_array_typed_refs(
                data,
                "participantRecordIds",
                types,
                record_id,
                &["participant"],
            )?,
            "chat_list" => {
                check_array_typed_refs(data, "chatRecordIds", types, record_id, &["chat"])?;
            }
            "participant" => {
                check_typed_ref(
                    data.get("containerRecordId"),
                    types,
                    record_id,
                    "containerRecordId",
                    &["chat", "channel", "community"],
                )?;
                check_typed_ref(
                    data.get("subjectRecordId"),
                    types,
                    record_id,
                    "subjectRecordId",
                    &["account", "contact"],
                )?;
            }
            "message" => verify_message_references(
                data,
                types,
                record_id,
                &["chat"],
                &["message"],
                &["account", "contact"],
            )?,
            "status" => verify_message_references(
                data,
                types,
                record_id,
                &["chat"],
                &["status"],
                &["account", "contact"],
            )?,
            "channel_event" => verify_message_references(
                data,
                types,
                record_id,
                &["channel"],
                &["channel_event"],
                &["account", "contact", "channel"],
            )?,
            "message_event" => {
                verify_event_refs(
                    data,
                    types,
                    record_id,
                    &["message"],
                    &["account", "contact"],
                )?;
            }
            "reaction" => {
                verify_event_refs(
                    data,
                    types,
                    record_id,
                    &["message", "status", "channel_event"],
                    &["account", "contact"],
                )?;
            }
            "receipt" | "poll_vote" => {
                verify_event_refs(
                    data,
                    types,
                    record_id,
                    &["message"],
                    &["account", "contact"],
                )?;
            }
            "group_event" => {
                verify_event_refs(
                    data,
                    types,
                    record_id,
                    &["chat", "account", "contact"],
                    &["account", "contact", "participant"],
                )?;
            }
            "call" => {
                verify_event_refs(
                    data,
                    types,
                    record_id,
                    &["chat", "account", "contact"],
                    &["account", "contact"],
                )?;
            }
            "presence_snapshot" => {
                verify_event_refs(
                    data,
                    types,
                    record_id,
                    &["account", "contact"],
                    &["account", "contact"],
                )?;
            }
            "community_relation" => {
                check_typed_ref(
                    data.get("fromRecordId"),
                    types,
                    record_id,
                    "fromRecordId",
                    &["community", "chat"],
                )?;
                check_resolvable_typed_ref(
                    data.get("toRecordId"),
                    types,
                    record_id,
                    "toRecordId",
                    &["community", "chat"],
                    data.get("resolution").and_then(Value::as_str) == Some("resolved"),
                )?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn verify_message_references(
    data: &Value,
    types: &HashMap<String, String>,
    owner: &str,
    container_types: &[&str],
    quoted_message_types: &[&str],
    actor_types: &[&str],
) -> Result<()> {
    check_typed_ref(
        data.pointer("/container/recordId"),
        types,
        owner,
        "container.recordId",
        container_types,
    )?;
    for field in ["senderRecordId", "authorRecordId"] {
        check_typed_ref(data.get(field), types, owner, field, actor_types)?;
    }
    for field in ["recipientRecordIds", "mentionRecordIds"] {
        check_array_typed_refs(data, field, types, owner, actor_types)?;
    }
    if let Some(quoted) = data.get("quoted").filter(|value| !value.is_null()) {
        let resolved = quoted.get("resolution").and_then(Value::as_str) == Some("resolved");
        check_resolvable_typed_ref(
            quoted.get("messageRecordId"),
            types,
            owner,
            "quoted.messageRecordId",
            quoted_message_types,
            resolved,
        )?;
        check_resolvable_typed_ref(
            quoted.get("participantRecordId"),
            types,
            owner,
            "quoted.participantRecordId",
            &["participant"],
            resolved,
        )?;
    }
    Ok(())
}

fn verify_event_refs(
    data: &Value,
    types: &HashMap<String, String>,
    owner: &str,
    subject_types: &[&str],
    actor_types: &[&str],
) -> Result<()> {
    check_array_typed_refs(data, "subjectRecordIds", types, owner, subject_types)?;
    check_array_typed_refs(data, "actorRecordIds", types, owner, actor_types)
}

fn verify_inventory(
    tree: &BagTree,
    validator: &SchemaValidator,
    source_id: &str,
    definitions: &[DatasetDefinition],
    records: &HashMap<String, Vec<Value>>,
    capabilities: &HashMap<String, String>,
) -> Result<Value> {
    let path = "data/dataset-inventory.json";
    let inventory = read_json(tree, path)?;
    validator.validate("dataset-inventory-1.0.schema.json", &inventory, path)?;
    require_source_id(&inventory, source_id, path)?;
    let datasets = inventory
        .get("datasets")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("semantic_contract", "inventory datasets are absent"))?;
    if datasets.len() != definitions.len() {
        return Err(invalid(
            "inventory_registry",
            "inventory dataset count differs from v1 registry",
        ));
    }
    for (entry, definition) in datasets.iter().zip(definitions) {
        if required_string(entry, "name", path)? != definition.name
            || required_string(entry, "path", path)? != definition.path
            || required_string(entry, "recordType", path)? != definition.record_type
        {
            return Err(invalid(
                "inventory_registry",
                format!("inventory registry mismatch for {}", definition.name),
            ));
        }
        let actual_records = records
            .get(&definition.name)
            .ok_or_else(|| invalid("semantic_contract", "normalized dataset map is incomplete"))?;
        let declared_count = entry.get("recordCount").and_then(Value::as_u64);
        if declared_count != u64::try_from(actual_records.len()).ok() {
            return Err(invalid(
                "inventory_record_count",
                format!("inventory record count mismatch for {}", definition.name),
            ));
        }
        let declared_bytes = entry.get("byteLength").and_then(Value::as_u64);
        if declared_bytes != Some(tree.file_length(&definition.path)?) {
            return Err(invalid(
                "inventory_byte_length",
                format!("inventory byte length mismatch for {}", definition.name),
            ));
        }
        verify_capability_inventory_causality(entry, &definition.name, capabilities)?;
    }
    Ok(inventory)
}

fn verify_capability_inventory_causality(
    inventory: &Value,
    name: &str,
    capabilities: &HashMap<String, String>,
) -> Result<()> {
    let probe = capabilities.get(name).map(String::as_str).ok_or_else(|| {
        invalid(
            "capability_inventory_mismatch",
            format!("missing capability {name}"),
        )
    })?;
    let capability = required_string(inventory, "capability", name)?;
    let request = required_string(inventory, "requestState", name)?;
    let result = required_string(inventory, "result", name)?;
    let consistent = match probe {
        "supported" => capability == "supported",
        "degraded" => {
            capability == "supported"
                && (request == "not_requested" || matches!(result, "partial" | "failed"))
        }
        "unsupported" => {
            capability == "unsupported"
                && ((request == "not_requested" && result == "not_requested")
                    || (request == "requested" && result == "unsupported"))
        }
        "error" => {
            capability == "unknown"
                && ((request == "not_requested" && result == "not_requested")
                    || (request == "requested" && result == "failed"))
        }
        _ => false,
    };
    if !consistent {
        return Err(invalid(
            "capability_inventory_mismatch",
            format!(
                "capability probe {probe} conflicts with inventory {capability}/{request}/{result} for {name}"
            ),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn verify_media(
    tree: &BagTree,
    validator: &SchemaValidator,
    source_id: &str,
    normalized: &NormalizedRecords,
) -> Result<MediaSummary> {
    let path = "data/indexes/media.ndjson";
    let records = read_ndjson(tree, path)?;
    let mut assets = HashMap::new();
    let mut cas_paths = HashSet::new();
    for (index, media) in records.iter().enumerate() {
        let label = format!("{path}:{}", index + 1);
        validator.validate("media-record-1.0.schema.json", media, &label)?;
        require_source_id(media, source_id, &label)?;
        let asset_id = required_string(media, "assetId", &label)?.to_owned();
        let sources = media
            .get("sourceRecordIds")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                invalid(
                    "semantic_contract",
                    format!("media sources absent at {label}"),
                )
            })?;
        let source_ids: HashSet<_> = sources
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        for source in &source_ids {
            if !normalized.types.contains_key(source) {
                return Err(invalid(
                    "dangling_media_source",
                    format!("media {asset_id} references absent normalized record {source}"),
                ));
            }
        }
        let related: HashSet<_> = media
            .get("relatedAssetIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let descriptor = MediaDescriptor {
            role: required_string(media, "role", &label)?.to_owned(),
            sources: source_ids,
            related,
        };
        if assets.insert(asset_id.clone(), descriptor).is_some() {
            return Err(invalid(
                "duplicate_media_asset",
                format!("duplicate media assetId: {asset_id}"),
            ));
        }
        if required_string(media, "acquisitionStatus", &label)? == "available" {
            let cas = media.get("cas").and_then(Value::as_object).ok_or_else(|| {
                invalid(
                    "media_cas",
                    format!("available media lacks CAS: {asset_id}"),
                )
            })?;
            let cas_path = required_string_object(cas, "path", &label)?;
            let digest = required_string_object(cas, "digest", &label)?;
            if !cas_path.ends_with(&format!("/{digest}"))
                || cas_path
                    .strip_prefix("data/media/sha256/")
                    .and_then(|rest| rest.split_once('/'))
                    .is_none_or(|(shard, _)| shard != &digest[..2])
            {
                return Err(invalid(
                    "media_cas_path",
                    format!("CAS path/digest mismatch for {asset_id}"),
                ));
            }
            let declared_length = cas.get("byteLength").and_then(Value::as_u64);
            if declared_length != Some(tree.file_length(cas_path)?) {
                return Err(invalid(
                    "media_cas_length",
                    format!("CAS byte length mismatch for {asset_id}"),
                ));
            }
            let actual = HashAlgorithm::Sha256.digest_file(&tree.file_path(cas_path)?)?;
            if actual != digest {
                return Err(invalid(
                    "media_cas_hash",
                    format!("CAS digest mismatch for {asset_id}"),
                ));
            }
            cas_paths.insert(cas_path.to_owned());
        }
    }
    let mut neighbors: HashMap<String, HashSet<String>> = HashMap::new();
    for (source, descriptor) in &assets {
        for target in &descriptor.related {
            if !assets.contains_key(target) {
                return Err(invalid(
                    "dangling_related_asset",
                    format!("media {source} references absent related asset {target}"),
                ));
            }
            neighbors
                .entry(source.clone())
                .or_default()
                .insert(target.clone());
            neighbors
                .entry(target.clone())
                .or_default()
                .insert(source.clone());
        }
    }
    let direct: HashMap<_, _> = normalized
        .asset_refs
        .iter()
        .map(|reference| {
            (
                (reference.source_id.as_str(), reference.asset_id.as_str()),
                reference.kind,
            )
        })
        .collect();
    for reference in &normalized.asset_refs {
        let Some(asset) = assets.get(&reference.asset_id) else {
            return Err(invalid(
                "dangling_attachment_asset",
                format!(
                    "normalized record {} references absent asset {}",
                    reference.source_id, reference.asset_id
                ),
            ));
        };
        if !asset.sources.contains(&reference.source_id)
            || !asset_role_allowed(reference.kind, &asset.role)
        {
            return Err(invalid(
                "media_reference_mismatch",
                format!(
                    "normalized record {} and media {} are not reciprocal for role {}",
                    reference.source_id, reference.asset_id, asset.role
                ),
            ));
        }
    }
    for (asset_id, descriptor) in &assets {
        for source_id in &descriptor.sources {
            let directly_referenced = direct.contains_key(&(source_id.as_str(), asset_id.as_str()));
            let allowed_via_related = is_secondary_media_role(&descriptor.role)
                && neighbors.get(asset_id).is_some_and(|related| {
                    related.iter().any(|related_id| {
                        direct.contains_key(&(source_id.as_str(), related_id.as_str()))
                    })
                });
            if !directly_referenced && !allowed_via_related {
                return Err(invalid(
                    "media_reference_mismatch",
                    format!(
                        "media {asset_id} source {source_id} has no reciprocal normalized reference"
                    ),
                ));
            }
        }
    }
    let actual_cas: HashSet<_> = tree
        .sorted_paths_with_prefix("data/media/")
        .into_iter()
        .collect();
    if actual_cas != cas_paths {
        return Err(invalid(
            "media_cas_coverage",
            "data/media contains an unindexed or missing CAS object",
        ));
    }
    Ok(MediaSummary { records })
}

fn asset_role_allowed(kind: AssetReferenceKind, role: &str) -> bool {
    match kind {
        AssetReferenceKind::Attachment => role != "avatar",
        AssetReferenceKind::Profile => role == "avatar",
        AssetReferenceKind::EntityMedia => matches!(role, "avatar" | "full" | "thumbnail"),
    }
}

fn is_secondary_media_role(role: &str) -> bool {
    matches!(
        role,
        "thumbnail" | "transmitted_ciphertext" | "decrypted_observable"
    )
}

#[allow(clippy::too_many_lines)]
fn verify_completeness(
    tree: &BagTree,
    validator: &SchemaValidator,
    source_id: &str,
    normalized: &NormalizedRecords,
    media: &MediaSummary,
    inventory: &Value,
    capabilities: &HashMap<String, String>,
) -> Result<usize> {
    let path = "data/completeness.json";
    let completeness = read_json(tree, path)?;
    validator.validate("completeness-1.0.schema.json", &completeness, path)?;
    require_source_id(&completeness, source_id, path)?;
    let chat_path = "data/completeness/chats.ndjson";
    let chat_records = read_ndjson(tree, chat_path)?;
    let chats: HashSet<_> = normalized
        .all
        .iter()
        .filter(|record| record.get("recordType").and_then(Value::as_str) == Some("chat"))
        .filter_map(|record| record.get("recordId").and_then(Value::as_str))
        .collect();
    let mut normalized_message_counts = HashMap::<&str, u64>::new();
    for message in normalized.by_dataset.get("messages").into_iter().flatten() {
        if let Some(chat_id) = message
            .pointer("/data/container/recordId")
            .and_then(Value::as_str)
        {
            *normalized_message_counts.entry(chat_id).or_default() += 1;
        }
    }
    let mut covered = HashSet::new();
    for (index, record) in chat_records.iter().enumerate() {
        let label = format!("{chat_path}:{}", index + 1);
        validator.validate("chat-completeness-1.0.schema.json", record, &label)?;
        require_source_id(record, source_id, &label)?;
        let chat_id = required_string(record, "chatRecordId", &label)?;
        if !chats.contains(chat_id) || !covered.insert(chat_id) {
            return Err(invalid(
                "chat_completeness_coverage",
                format!("duplicate or unknown chat completeness record: {chat_id}"),
            ));
        }
        let initial = record
            .get("initialMessageCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                invalid(
                    "semantic_contract",
                    format!("missing initial count at {label}"),
                )
            })?;
        let final_count = record
            .get("finalMessageCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                invalid(
                    "semantic_contract",
                    format!("missing final count at {label}"),
                )
            })?;
        let normalized_count = normalized_message_counts.get(chat_id).copied().unwrap_or(0);
        if final_count < initial || final_count != normalized_count {
            return Err(invalid(
                "chat_completeness_count",
                format!(
                    "chat {chat_id} declares initial/final {initial}/{final_count} but has {normalized_count} normalized messages"
                ),
            ));
        }
    }
    if covered.len() != chats.len() {
        return Err(invalid(
            "chat_completeness_coverage",
            "chat completeness records do not cover every normalized chat",
        ));
    }

    let expected_counts = media_counts(&media.records);
    let declared = completeness
        .get("mediaCounts")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("semantic_contract", "completeness mediaCounts is absent"))?;
    for (name, expected) in expected_counts {
        if declared.get(name).and_then(Value::as_u64) != Some(expected) {
            return Err(invalid(
                "completeness_media_count",
                format!("completeness media count mismatch: {name}"),
            ));
        }
    }
    let cross_checks = completeness
        .get("crossChecks")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("semantic_contract", "completeness crossChecks is absent"))?;
    for field in [
        "inventoryCountsMatch",
        "mediaIndexMatchesCas",
        "normalizedRefsResolved",
    ] {
        if cross_checks.get(field).and_then(Value::as_bool) != Some(true) {
            return Err(invalid(
                "completeness_cross_check",
                format!("completeness cross-check is not true: {field}"),
            ));
        }
    }
    if cross_checks
        .get("differences")
        .and_then(Value::as_array)
        .is_none_or(|items| !items.is_empty())
    {
        return Err(invalid(
            "completeness_cross_check",
            "completeness contains unresolved cross-check differences",
        ));
    }
    let requested = declared
        .get("requested")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let unavailable = ["missing", "expired", "decryptError", "notRequested"]
        .iter()
        .filter_map(|name| declared.get(*name).and_then(Value::as_u64))
        .sum::<u64>();
    let media_scope = required_string(&completeness, "mediaScope", path)?;
    match media_scope {
        "complete" if unavailable != 0 => {
            return Err(invalid(
                "completeness_media_scope",
                "complete media scope contains unavailable assets",
            ));
        }
        "not_requested" if requested != 0 => {
            return Err(invalid(
                "completeness_media_scope",
                "not_requested media scope contains attempted assets",
            ));
        }
        _ => {}
    }
    let media_capability = capabilities
        .get("media")
        .map(String::as_str)
        .ok_or_else(|| invalid("capability_media_mismatch", "media capability is absent"))?;
    let media_causality_valid = match media_capability {
        "supported" => true,
        "degraded" => matches!(media_scope, "partial" | "not_requested"),
        "unsupported" | "error" => media_scope == "not_requested" && requested == 0,
        _ => false,
    };
    if !media_causality_valid {
        return Err(invalid(
            "capability_media_mismatch",
            format!("media capability {media_capability} conflicts with mediaScope {media_scope}"),
        ));
    }
    if required_string(&completeness, "overall", path)? == "complete_as_observed" {
        if required_string(&completeness, "localSnapshot", path)? != "verified"
            || required_string(&completeness, "mediaScope", path)? != "complete"
            || inventory
                .get("datasets")
                .and_then(Value::as_array)
                .is_none_or(|datasets| {
                    datasets.iter().any(|dataset| {
                        !matches!(
                            dataset.get("result").and_then(Value::as_str),
                            Some("empty" | "complete_as_observed")
                        )
                    })
                })
        {
            return Err(invalid(
                "completeness_overall",
                "complete_as_observed conflicts with dataset or media completeness",
            ));
        }
    } else if completeness
        .get("reasonCodes")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        return Err(invalid(
            "completeness_reason",
            "partial/failed completeness lacks reason codes",
        ));
    }
    Ok(chat_records.len())
}

fn collect_asset_refs(record: &Value, record_id: &str, output: &mut Vec<AssetReference>) {
    let record_type = record.get("recordType").and_then(Value::as_str);
    let Some(data) = record.get("data") else {
        return;
    };
    let (field, kind) = match record_type {
        Some("message" | "status" | "channel_event") => {
            ("attachmentAssetIds", AssetReferenceKind::Attachment)
        }
        Some("account" | "contact") => ("profileAssetIds", AssetReferenceKind::Profile),
        Some("channel" | "community") => ("mediaAssetIds", AssetReferenceKind::EntityMedia),
        _ => return,
    };
    for asset in data
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        output.push(AssetReference {
            source_id: record_id.to_owned(),
            asset_id: asset.to_owned(),
            kind,
        });
    }
}

fn media_counts(records: &[Value]) -> HashMap<&'static str, u64> {
    let mut counts = HashMap::from([
        ("requested", 0),
        ("full", 0),
        ("thumbnail", 0),
        ("missing", 0),
        ("expired", 0),
        ("decryptError", 0),
        ("notRequested", 0),
    ]);
    for record in records {
        let status = record.get("acquisitionStatus").and_then(Value::as_str);
        let role = record.get("role").and_then(Value::as_str);
        if status != Some("not_requested") {
            *counts.entry("requested").or_default() += 1;
        }
        if status == Some("available") && role == Some("full") {
            *counts.entry("full").or_default() += 1;
        }
        if status == Some("available") && role == Some("thumbnail") {
            *counts.entry("thumbnail").or_default() += 1;
        }
        match status {
            Some("missing") => *counts.entry("missing").or_default() += 1,
            Some("expired") => *counts.entry("expired").or_default() += 1,
            Some("decrypt_error") => *counts.entry("decryptError").or_default() += 1,
            Some("not_requested") => *counts.entry("notRequested").or_default() += 1,
            _ => {}
        }
    }
    counts
}

fn check_array_typed_refs(
    object: &Value,
    field: &str,
    types: &HashMap<String, String>,
    owner: &str,
    allowed: &[&str],
) -> Result<()> {
    for value in object
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        check_typed_ref(Some(value), types, owner, field, allowed)?;
    }
    Ok(())
}

fn check_typed_ref(
    value: Option<&Value>,
    types: &HashMap<String, String>,
    owner: &str,
    field: &str,
    allowed: &[&str],
) -> Result<()> {
    let Some(reference) = value
        .filter(|value| !value.is_null())
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    let actual = types.get(reference).map(String::as_str).ok_or_else(|| {
        invalid(
            "dangling_normalized_ref",
            format!("normalized record {owner} references absent record {reference}"),
        )
    })?;
    if !allowed.contains(&actual) {
        return Err(invalid(
            "reference_type",
            format!(
                "normalized record {owner} field {field} references {reference} of type {actual}; expected one of {}",
                allowed.join(",")
            ),
        ));
    }
    Ok(())
}

fn check_resolvable_typed_ref(
    value: Option<&Value>,
    types: &HashMap<String, String>,
    owner: &str,
    field: &str,
    allowed: &[&str],
    must_resolve: bool,
) -> Result<()> {
    let Some(reference) = value
        .filter(|value| !value.is_null())
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    if !must_resolve && !types.contains_key(reference) {
        return Ok(());
    }
    check_typed_ref(value, types, owner, field, allowed)
}

fn canonical_sha256(value: &Value, label: &str) -> Result<String> {
    let canonical = serde_jcs::to_vec(value).map_err(|error| {
        invalid(
            "jcs_error",
            format!("cannot canonicalize content in {label}: {error}"),
        )
    })?;
    Ok(hex::encode(Sha256::digest(canonical)))
}

fn read_json(tree: &BagTree, path: &str) -> Result<Value> {
    let bytes = tree.read_limited(path, MAX_JSON_LINE_BYTES as u64)?;
    strict_json::from_slice(&bytes, path)
}

fn read_ndjson(tree: &BagTree, path: &str) -> Result<Vec<Value>> {
    let file = File::open(tree.file_path(path)?)
        .map_err(|error| invalid("file_read_error", format!("cannot open {path}: {error}")))?;
    let mut reader = BufReader::new(file);
    let mut records = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| invalid("file_read_error", format!("cannot read {path}: {error}")))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_JSON_LINE_BYTES {
            return Err(invalid(
                "ndjson_line_too_large",
                format!("{path} contains a line larger than {MAX_JSON_LINE_BYTES} bytes"),
            ));
        }
        if line.last() != Some(&b'\n') {
            return Err(invalid(
                "ndjson_line_endings",
                format!("{path} must end every record with LF"),
            ));
        }
        line.pop();
        if line.is_empty() || line.contains(&b'\r') {
            return Err(invalid(
                "ndjson_line_endings",
                format!("{path} contains a blank line or CR"),
            ));
        }
        let label = format!("{path}:{}", records.len() + 1);
        records.push(strict_json::from_slice(&line, &label)?);
    }
    Ok(records)
}

fn require_source_id(value: &Value, expected: &str, label: &str) -> Result<()> {
    if required_string(value, "sourceId", label)? != expected {
        return Err(invalid(
            "source_id_mismatch",
            format!("sourceId mismatch in {label}"),
        ));
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, field: &str, label: &str) -> Result<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        invalid(
            "semantic_contract",
            format!("{label} lacks string field {field}"),
        )
    })
}

fn required_string_object<'a>(
    value: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        invalid(
            "semantic_contract",
            format!("{label} lacks string field {field}"),
        )
    })
}
