use serde::Serialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256, Sha512};

use crate::WaebError;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Canonicalizes a serializable value using the RFC 8785 object and string rules.
///
/// Integers outside the I-JSON interoperable range are rejected. Native 64-bit
/// identifiers and clocks must therefore be represented as decimal strings.
///
/// # Errors
///
/// Returns an error for serialization failures or values outside I-JSON.
pub fn canonicalize<T: Serialize>(value: &T) -> Result<Vec<u8>, WaebError> {
    let value = serde_json::to_value(value)?;
    let mut output = Vec::new();
    write_value(&value, &mut output)?;
    Ok(output)
}

/// Returns canonical UTF-8 followed by one LF, suitable for JSON/NDJSON files.
///
/// # Errors
///
/// Returns an error for serialization failures or values outside I-JSON.
pub fn canonicalize_line<T: Serialize>(value: &T) -> Result<Vec<u8>, WaebError> {
    let mut bytes = canonicalize(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Canonicalizes evidence content while rejecting native floating-point values.
///
/// The first Collector release admits only booleans, strings, null, arrays,
/// objects, and I-JSON safe integers. Protocol 64-bit values must be decimal
/// strings. This keeps production output inside the currently tested JCS subset.
pub(crate) fn canonicalize_evidence<T: Serialize>(value: &T) -> Result<Vec<u8>, WaebError> {
    let value = serde_json::to_value(value)?;
    reject_native_floats(&value)?;
    canonicalize(&value)
}

/// Evidence-safe canonical UTF-8 followed by one LF.
pub(crate) fn canonicalize_evidence_line<T: Serialize>(value: &T) -> Result<Vec<u8>, WaebError> {
    let mut bytes = canonicalize_evidence(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Computes a lowercase SHA-256 digest.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Computes a lowercase SHA-512 digest.
#[must_use]
pub fn sha512_hex(bytes: &[u8]) -> String {
    hex::encode(Sha512::digest(bytes))
}

fn write_value(value: &Value, output: &mut Vec<u8>) -> Result<(), WaebError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(number) => write_number(number, output)?,
        Value::String(value) => output.extend_from_slice(serde_json::to_string(value)?.as_bytes()),
        Value::Array(values) => {
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_value(item, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => write_object(values, output)?,
    }
    Ok(())
}

fn write_object(values: &Map<String, Value>, output: &mut Vec<u8>) -> Result<(), WaebError> {
    let mut keys: Vec<&String> = values.keys().collect();
    keys.sort_unstable();
    output.push(b'{');
    for (index, key) in keys.into_iter().enumerate() {
        if index != 0 {
            output.push(b',');
        }
        output.extend_from_slice(serde_json::to_string(key)?.as_bytes());
        output.push(b':');
        write_value(&values[key], output)?;
    }
    output.push(b'}');
    Ok(())
}

fn write_number(number: &Number, output: &mut Vec<u8>) -> Result<(), WaebError> {
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(WaebError::UnsafeJsonNumber(number.to_string()));
        }
        output.extend_from_slice(value.to_string().as_bytes());
        return Ok(());
    }
    if let Some(value) = number.as_u64() {
        if value > MAX_SAFE_INTEGER {
            return Err(WaebError::UnsafeJsonNumber(number.to_string()));
        }
        output.extend_from_slice(value.to_string().as_bytes());
        return Ok(());
    }

    let value = number
        .as_f64()
        .ok_or_else(|| WaebError::UnsafeJsonNumber(number.to_string()))?;
    if !value.is_finite() {
        return Err(WaebError::UnsafeJsonNumber(number.to_string()));
    }
    if value == 0.0 {
        output.push(b'0');
        return Ok(());
    }

    // serde_json uses the same shortest-round-trip Ryu family as ECMAScript.
    // Its exponent spelling matches RFC 8785 for the range admitted here.
    let mut rendered = number.to_string();
    if let Some(exponent) = rendered.find('e')
        && rendered
            .as_bytes()
            .get(exponent + 1)
            .is_some_and(u8::is_ascii_digit)
    {
        rendered.insert(exponent + 1, '+');
    }
    output.extend_from_slice(rendered.as_bytes());
    Ok(())
}

fn reject_native_floats(value: &Value) -> Result<(), WaebError> {
    match value {
        Value::Number(number) if number.as_i64().is_none() && number.as_u64().is_none() => {
            Err(WaebError::UnsafeJsonNumber(number.to_string()))
        }
        Value::Array(values) => values.iter().try_for_each(reject_native_floats),
        Value::Object(values) => values.values().try_for_each(reject_native_floats),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::canonicalize;

    #[test]
    fn passes_repository_jcs_vectors() {
        let vector: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../../spec/wa-evidence-bag/v1/test-vectors/jcs/canonicalization.json"
        ))
        .unwrap_or_else(|error| panic!("invalid checked-in vector: {error}"));
        for case in vector["cases"]
            .as_array()
            .unwrap_or_else(|| panic!("cases must be an array"))
        {
            let actual = canonicalize(&case["input"])
                .unwrap_or_else(|error| panic!("canonicalization failed: {error}"));
            assert_eq!(
                String::from_utf8(actual).unwrap_or_else(|error| panic!("not UTF-8: {error}")),
                case["canonical"]
            );
        }
    }

    #[test]
    fn rejects_unsafe_integer() {
        assert!(canonicalize(&json!({"n": 9_007_199_254_740_992_u64})).is_err());
    }
}
