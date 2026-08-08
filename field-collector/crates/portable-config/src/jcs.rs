use serde_json::{Map, Value};

use crate::PortableConfigError;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn canonicalize(value: &Value) -> Result<Vec<u8>, PortableConfigError> {
    let mut output = String::new();
    write_value(value, &mut output)?;
    Ok(output.into_bytes())
}

fn write_value(value: &Value, output: &mut String) -> Result<(), PortableConfigError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => write_number(value, output)?,
        Value::String(value) => output.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => write_object(values, output)?,
    }
    Ok(())
}

fn write_number(
    value: &serde_json::Number,
    output: &mut String,
) -> Result<(), PortableConfigError> {
    if let Some(value) = value.as_u64() {
        if value > MAX_SAFE_INTEGER {
            return Err(PortableConfigError::InvalidDocument(
                "configuration integer exceeds the I-JSON safe range".to_owned(),
            ));
        }
        output.push_str(&value.to_string());
        return Ok(());
    }
    if let Some(value) = value.as_i64() {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(PortableConfigError::InvalidDocument(
                "configuration integer exceeds the I-JSON safe range".to_owned(),
            ));
        }
        output.push_str(&value.to_string());
        return Ok(());
    }
    Err(PortableConfigError::InvalidDocument(
        "floating-point configuration values are forbidden".to_owned(),
    ))
}

fn write_object(
    values: &Map<String, Value>,
    output: &mut String,
) -> Result<(), PortableConfigError> {
    if values
        .keys()
        .any(|key| !key.bytes().all(|byte| byte.is_ascii()))
    {
        return Err(PortableConfigError::InvalidDocument(
            "configuration object keys must be ASCII in v1".to_owned(),
        ));
    }
    let mut keys = values.keys().collect::<Vec<_>>();
    keys.sort_unstable();
    output.push('{');
    for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&serde_json::to_string(key)?);
        output.push(':');
        let item = values.get(key).ok_or_else(|| {
            PortableConfigError::InvalidDocument("canonical object key disappeared".to_owned())
        })?;
        write_value(item, output)?;
    }
    output.push('}');
    Ok(())
}
