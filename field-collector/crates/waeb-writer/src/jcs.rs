use serde::Serialize;
use serde_json::Value;
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
    validate_interoperable_numbers(&value)?;
    Ok(serde_jcs::to_vec(&value)?)
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

/// Canonicalizes evidence content using the same RFC 8785 implementation as
/// the independent verifier.
///
/// Finite IEEE-754 numbers are permitted because message coordinates and other
/// observed fields legitimately contain fractions. Integer tokens outside the
/// I-JSON interoperable range remain forbidden; protocol 64-bit values must be
/// decimal strings.
pub(crate) fn canonicalize_evidence<T: Serialize>(value: &T) -> Result<Vec<u8>, WaebError> {
    canonicalize(value)
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

fn validate_interoperable_numbers(value: &Value) -> Result<(), WaebError> {
    match value {
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                if value.unsigned_abs() > MAX_SAFE_INTEGER {
                    return Err(WaebError::UnsafeJsonNumber(number.to_string()));
                }
            } else if let Some(value) = number.as_u64() {
                if value > MAX_SAFE_INTEGER {
                    return Err(WaebError::UnsafeJsonNumber(number.to_string()));
                }
            } else if !number.as_f64().is_some_and(f64::is_finite) {
                return Err(WaebError::UnsafeJsonNumber(number.to_string()));
            }
            Ok(())
        }
        Value::Array(values) => values.iter().try_for_each(validate_interoperable_numbers),
        Value::Object(values) => values.values().try_for_each(validate_interoperable_numbers),
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

    #[test]
    fn integral_f64_uses_ecmascript_integer_spelling() {
        let actual = canonicalize(&json!({"n": 3.0}))
            .unwrap_or_else(|error| panic!("canonicalization failed: {error}"));
        assert_eq!(actual, br#"{"n":3}"#);
    }
}
