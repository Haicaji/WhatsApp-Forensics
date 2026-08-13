use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{Result, invalid, strict_json, trusted};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) struct SchemaValidator {
    schemas: HashMap<&'static str, Value>,
}

impl SchemaValidator {
    pub(crate) fn new() -> Result<Self> {
        let mut schemas = HashMap::new();
        for (path, bytes) in trusted::SCHEMAS {
            schemas.insert(*path, strict_json::from_slice(bytes, path)?);
        }
        Ok(Self { schemas })
    }

    pub(crate) fn validate(&self, schema_path: &str, value: &Value, label: &str) -> Result<()> {
        validate_json_safety(value, label)?;
        let schema = self.schemas.get(schema_path).ok_or_else(|| {
            invalid(
                "trusted_contract",
                format!("trusted schema is not registered: {schema_path}"),
            )
        })?;
        self.validate_node(schema, schema_path, value, "$", label)
            .map_err(|message| invalid("schema_contract", message))
    }

    // Keeping the supported JSON Schema keywords in one recursive dispatcher makes it
    // auditable that untrusted evidence never selects executable validation code.
    #[allow(clippy::too_many_lines, clippy::collapsible_if)]
    fn validate_node(
        &self,
        schema: &Value,
        schema_path: &str,
        value: &Value,
        instance_path: &str,
        label: &str,
    ) -> std::result::Result<(), String> {
        if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            let (target_path, target) = self.resolve_reference(schema_path, reference)?;
            self.validate_node(target, &target_path, value, instance_path, label)?;
        }

        if let Some(expected) = schema.get("const") {
            if value != expected {
                return Err(format!("{label} {instance_path} differs from schema const"));
            }
        }
        if let Some(options) = schema.get("enum").and_then(Value::as_array) {
            if !options.iter().any(|candidate| candidate == value) {
                return Err(format!(
                    "{label} {instance_path} is outside the schema enum"
                ));
            }
        }
        if let Some(types) = schema.get("type") {
            let matches = match types {
                Value::String(kind) => type_matches(kind, value),
                Value::Array(kinds) => kinds
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|kind| type_matches(kind, value)),
                _ => false,
            };
            if !matches {
                return Err(format!("{label} {instance_path} has the wrong JSON type"));
            }
        }

        if let Some(branches) = schema.get("allOf").and_then(Value::as_array) {
            for branch in branches {
                self.validate_node(branch, schema_path, value, instance_path, label)?;
            }
        }
        if let Some(branches) = schema.get("oneOf").and_then(Value::as_array) {
            let matches = branches
                .iter()
                .filter(|branch| {
                    self.validate_node(branch, schema_path, value, instance_path, label)
                        .is_ok()
                })
                .count();
            if matches != 1 {
                return Err(format!(
                    "{label} {instance_path} must match exactly one schema branch (matched {matches})"
                ));
            }
        }
        if let Some(condition) = schema.get("if") {
            let keyword = if self
                .validate_node(condition, schema_path, value, instance_path, label)
                .is_ok()
            {
                "then"
            } else {
                "else"
            };
            if let Some(branch) = schema.get(keyword) {
                self.validate_node(branch, schema_path, value, instance_path, label)?;
            }
        }

        if let Some(text) = value.as_str() {
            if let Some(minimum) = schema.get("minLength").and_then(Value::as_u64) {
                if text.chars().count() < usize_from_u64(minimum)? {
                    return Err(format!("{label} {instance_path} is shorter than minLength"));
                }
            }
            if let Some(maximum) = schema.get("maxLength").and_then(Value::as_u64) {
                if text.chars().count() > usize_from_u64(maximum)? {
                    return Err(format!("{label} {instance_path} exceeds maxLength"));
                }
            }
            if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
                if !pattern_matches(pattern, text) {
                    return Err(format!(
                        "{label} {instance_path} does not match its pattern"
                    ));
                }
            }
            if schema.get("format").and_then(Value::as_str) == Some("date-time")
                && !valid_rfc3339(text)
            {
                return Err(format!(
                    "{label} {instance_path} is not an RFC 3339 date-time"
                ));
            }
        }

        if value.is_number() {
            let number = value.as_f64().ok_or_else(|| {
                format!("{label} {instance_path} cannot be represented as a finite number")
            })?;
            if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
                if number < minimum {
                    return Err(format!("{label} {instance_path} is below minimum"));
                }
            }
            if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
                if number > maximum {
                    return Err(format!("{label} {instance_path} exceeds maximum"));
                }
            }
        }

        if let Some(array) = value.as_array() {
            if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64) {
                if array.len() < usize_from_u64(minimum)? {
                    return Err(format!("{label} {instance_path} has too few items"));
                }
            }
            if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64) {
                if array.len() > usize_from_u64(maximum)? {
                    return Err(format!("{label} {instance_path} has too many items"));
                }
            }
            if schema.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
                let mut seen = HashSet::new();
                for item in array {
                    let canonical = serde_jcs::to_string(item).map_err(|error| {
                        format!("cannot canonicalize {label} {instance_path}: {error}")
                    })?;
                    if !seen.insert(canonical) {
                        return Err(format!("{label} {instance_path} contains duplicate items"));
                    }
                }
            }
            let prefix = schema.get("prefixItems").and_then(Value::as_array);
            if let Some(prefix_schemas) = prefix {
                for (index, item_schema) in prefix_schemas.iter().enumerate() {
                    if let Some(item) = array.get(index) {
                        self.validate_node(
                            item_schema,
                            schema_path,
                            item,
                            &format!("{instance_path}/{index}"),
                            label,
                        )?;
                    }
                }
            }
            if let Some(items) = schema.get("items") {
                let start = prefix.map_or(0, Vec::len);
                if items == &Value::Bool(false) && array.len() > start {
                    return Err(format!("{label} {instance_path} has forbidden extra items"));
                }
                if items.is_object() {
                    for (index, item) in array.iter().enumerate().skip(start) {
                        self.validate_node(
                            items,
                            schema_path,
                            item,
                            &format!("{instance_path}/{index}"),
                            label,
                        )?;
                    }
                }
            }
        }

        if let Some(object) = value.as_object() {
            if let Some(minimum) = schema.get("minProperties").and_then(Value::as_u64) {
                if object.len() < usize_from_u64(minimum)? {
                    return Err(format!("{label} {instance_path} has too few properties"));
                }
            }
            if let Some(maximum) = schema.get("maxProperties").and_then(Value::as_u64) {
                if object.len() > usize_from_u64(maximum)? {
                    return Err(format!("{label} {instance_path} has too many properties"));
                }
            }
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for name in required.iter().filter_map(Value::as_str) {
                    if !object.contains_key(name) {
                        return Err(format!(
                            "{label} {instance_path} is missing property {name}"
                        ));
                    }
                }
            }
            if let Some(name_schema) = schema.get("propertyNames") {
                for name in object.keys() {
                    self.validate_node(
                        name_schema,
                        schema_path,
                        &Value::String(name.clone()),
                        &format!("{instance_path}/<property-name>"),
                        label,
                    )?;
                }
            }
            let properties = schema.get("properties").and_then(Value::as_object);
            if let Some(known) = properties {
                for (name, property_schema) in known {
                    if let Some(property) = object.get(name) {
                        self.validate_node(
                            property_schema,
                            schema_path,
                            property,
                            &format!("{instance_path}/{}", escape_pointer(name)),
                            label,
                        )?;
                    }
                }
            }
            if let Some(additional) = schema.get("additionalProperties") {
                for (name, property) in object {
                    if properties.is_some_and(|known| known.contains_key(name)) {
                        continue;
                    }
                    match additional {
                        Value::Bool(false) => {
                            return Err(format!(
                                "{label} {instance_path} contains unexpected property {name}"
                            ));
                        }
                        Value::Object(_) => self.validate_node(
                            additional,
                            schema_path,
                            property,
                            &format!("{instance_path}/{}", escape_pointer(name)),
                            label,
                        )?,
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    }

    fn resolve_reference<'a>(
        &'a self,
        current_path: &str,
        reference: &str,
    ) -> std::result::Result<(String, &'a Value), String> {
        let (file_part, fragment) = reference.split_once('#').unwrap_or((reference, ""));
        let target_path = if file_part.is_empty() {
            current_path.to_owned()
        } else {
            normalize_schema_path(current_path, file_part)?
        };
        let root = self
            .schemas
            .get(target_path.as_str())
            .ok_or_else(|| format!("unregistered schema reference: {reference}"))?;
        let target = if fragment.is_empty() {
            root
        } else {
            root.pointer(fragment)
                .ok_or_else(|| format!("unresolved schema fragment: {reference}"))?
        };
        Ok((target_path, target))
    }
}

fn normalize_schema_path(current: &str, relative: &str) -> std::result::Result<String, String> {
    let mut components: Vec<&str> = current.split('/').collect();
    components.pop();
    for component in relative.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                if components.pop().is_none() {
                    return Err(format!("schema reference escapes trusted root: {relative}"));
                }
            }
            other => components.push(other),
        }
    }
    Ok(components.join("/"))
}

fn type_matches(kind: &str, value: &Value) -> bool {
    match kind {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value
            .as_number()
            .is_some_and(|number| number.is_i64() || number.is_u64()),
        _ => false,
    }
}

fn pattern_matches(pattern: &str, text: &str) -> bool {
    match pattern {
        "Z$" => text.ends_with('Z'),
        "^(0|[1-9][0-9]*)$" => valid_decimal(text),
        "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[ -~]+$" => {
            !text.is_empty()
                && !text.starts_with('/')
                && !text.contains('\\')
                && text.bytes().all(|byte| (b' '..=b'~').contains(&byte))
                && !text.split('/').any(|part| part == "..")
        }
        "^[0-9a-f]{128}$" => lower_hex(text, 128),
        "^[0-9a-f]{64}$" => lower_hex(text, 64),
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" => {
            valid_uuid_pattern(text)
        }
        "^[A-Za-z0-9+/]+={0,2}$" => valid_base64_pattern(text),
        "^[a-z0-9-]{3,80}$" => ascii_class(text, 3, 80, |byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
        }),
        "^[a-z0-9][a-z0-9.-]{2,100}$" => {
            text.as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                && ascii_class(text, 3, 101, |byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'.' | b'-')
                })
        }
        "^[a-z0-9_-]{3,80}$" => ascii_class(text, 3, 80, |byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        }),
        "^[a-z0-9_]{3,100}$" => ascii_class(text, 3, 100, |byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
        }),
        "^[a-z0-9_]{3,80}$" => ascii_class(text, 3, 80, |byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
        }),
        "^[a-zA-Z0-9_.-]{1,160}$" => ascii_class(text, 1, 160, identifier_byte),
        "^[a-zA-Z0-9_.-]{3,120}$" => ascii_class(text, 3, 120, identifier_byte),
        "^[A-Za-z0-9][A-Za-z0-9_.-]{2,119}$" => {
            text.as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && ascii_class(text, 3, 120, identifier_byte)
        }
        "^[a-z][a-z0-9_]{2,100}$" => lower_identifier(text, 3, 101),
        "^[a-z][a-z0-9_]{2,80}$" => lower_identifier(text, 3, 81),
        "^[a-z][a-z0-9_]{7,127}$" => lower_identifier(text, 8, 128),
        "^[a-z][a-zA-Z0-9_]{0,79}$" => {
            text.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && ascii_class(text, 1, 80, |byte| {
                    byte.is_ascii_alphanumeric() || byte == b'_'
                })
        }
        "^\\.[a-z0-9]{1,16}$" => text.strip_prefix('.').is_some_and(|rest| {
            ascii_class(rest, 1, 16, |byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit()
            })
        }),
        "^data/media/sha256/[0-9a-f]{2}/[0-9a-f]{64}$" => valid_cas_path(text),
        "^sha256:[0-9a-f]{64}$" => text
            .strip_prefix("sha256:")
            .is_some_and(|digest| lower_hex(digest, 64)),
        _ => false,
    }
}

fn validate_json_safety(value: &Value, label: &str) -> Result<()> {
    match value {
        Value::Number(number) => {
            if let Some(value) = number.as_u64() {
                if value > MAX_SAFE_INTEGER {
                    return Err(invalid(
                        "ijson_number",
                        format!("unsafe integer in {label}"),
                    ));
                }
            } else if let Some(value) = number.as_i64() {
                if value.unsigned_abs() > MAX_SAFE_INTEGER {
                    return Err(invalid(
                        "ijson_number",
                        format!("unsafe integer in {label}"),
                    ));
                }
            } else if !number.as_f64().is_some_and(f64::is_finite) {
                return Err(invalid(
                    "ijson_number",
                    format!("non-finite number in {label}"),
                ));
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_json_safety(item, label)?;
            }
        }
        Value::Object(object) => {
            for item in object.values() {
                validate_json_safety(item, label)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn usize_from_u64(value: u64) -> std::result::Result<usize, String> {
    usize::try_from(value).map_err(|_| "schema bound exceeds platform usize".to_owned())
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_decimal(value: &str) -> bool {
    value == "0"
        || (value
            .as_bytes()
            .first()
            .is_some_and(|byte| matches!(byte, b'1'..=b'9'))
            && value.bytes().all(|byte| byte.is_ascii_digit()))
}

fn ascii_class(
    value: &str,
    minimum: usize,
    maximum: usize,
    predicate: impl Fn(u8) -> bool,
) -> bool {
    (minimum..=maximum).contains(&value.len()) && value.bytes().all(predicate)
}

fn identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

fn lower_identifier(value: &str, minimum: usize, maximum: usize) -> bool {
    value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && ascii_class(value, minimum, maximum, |byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
        })
}

fn valid_uuid_pattern(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index) || byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
        })
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn valid_base64_pattern(value: &str) -> bool {
    if value.is_empty() || value.len() % 4 != 0 {
        return false;
    }
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    padding <= 2
        && value[..value.len() - padding]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

fn valid_cas_path(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("data/media/sha256/") else {
        return false;
    };
    let Some((shard, digest)) = rest.split_once('/') else {
        return false;
    };
    lower_hex(shard, 2) && lower_hex(digest, 64)
}

fn valid_rfc3339(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }
    let number = |start: usize, end: usize| -> Option<u32> {
        std::str::from_utf8(bytes.get(start..end)?)
            .ok()?
            .parse()
            .ok()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0, 4),
        number(5, 7),
        number(8, 10),
        number(11, 13),
        number(14, 16),
        number(17, 19),
    ) else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 60 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > maximum_day {
        return false;
    }
    let mut cursor = 19;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == start {
            return false;
        }
    }
    match bytes.get(cursor..) {
        Some(b"Z") => true,
        Some(zone) if zone.len() == 6 && matches!(zone[0], b'+' | b'-') && zone[3] == b':' => {
            let Ok(hours) = std::str::from_utf8(&zone[1..3])
                .unwrap_or("")
                .parse::<u32>()
            else {
                return false;
            };
            let Ok(minutes) = std::str::from_utf8(&zone[4..6])
                .unwrap_or("")
                .parse::<u32>()
            else {
                return false;
            };
            hours <= 23 && minutes <= 59
        }
        _ => false,
    }
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use super::{SchemaValidator, pattern_matches, valid_rfc3339};
    use serde_json::json;

    #[test]
    fn known_patterns_and_dates_are_strict() {
        assert!(pattern_matches("^[a-z][a-z0-9_]{7,127}$", "msg_12345678"));
        assert!(!pattern_matches("^[a-z][a-z0-9_]{7,127}$", "BAD"));
        assert!(pattern_matches(
            "^[A-Za-z0-9][A-Za-z0-9_.-]{2,119}$",
            "CASE-2026-001"
        ));
        assert!(valid_rfc3339("2026-08-08T12:13:14.123Z"));
        assert!(!valid_rfc3339("2026-02-30T12:13:14Z"));
    }

    #[test]
    fn trusted_media_schema_enforces_conditional_cas() {
        let validator = SchemaValidator::new().unwrap_or_else(|error| panic!("{error}"));
        let invalid = json!({
            "schemaVersion":"1.0.0", "assetId":"asset_12345678",
            "sourceId":"22222222-2222-4222-8222-222222222222",
            "sourceRecordIds":["msg_12345678"], "role":"full", "kind":"image",
            "acquisitionStatus":"available", "cas":null, "declaredMime":null,
            "detectedMime":null, "detector":null, "suggestedExtension":null,
            "originalFileName":null, "relatedAssetIds":[],
            "acquisition":{
                "method":"not_attempted", "attempts":0, "capturedAtUtc":null,
                "errorCode":null, "capturedByteLength":0, "networkActionAttempted":false
            }
        });
        assert!(
            validator
                .validate("media-record-1.0.schema.json", &invalid, "media")
                .is_err()
        );
    }
}
