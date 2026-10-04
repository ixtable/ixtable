//! Parameter typing, defaults, and DuckDB value binding.
use super::*;

/// Canonical logical type for a parameter, or `None` when unsupported.
pub fn logical_type(name: &str) -> Option<&'static str> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "" | "text" | "string" | "varchar" => "text",
        "integer" | "int" | "bigint" => "integer",
        "number" | "real" | "double" | "float" | "decimal" | "currency" => "number",
        "boolean" | "bool" => "boolean",
        "date" => "date",
        "timestamp" | "datetime" => "timestamp",
        "blob" => "blob",
        _ => return None,
    })
}

/// Converts a JSON default value (plain JSON or a tagged `DataValue`) to a `DataValue`.
pub fn json_value(value: &serde_json::Value) -> DataValue {
    use serde_json::Value as J;
    match value {
        J::Null => DataValue::Null,
        J::Bool(b) => DataValue::Boolean(*b),
        J::Number(n) => n
            .as_i64()
            .map(DataValue::Integer)
            .unwrap_or_else(|| DataValue::Real(n.as_f64().unwrap_or(f64::NAN))),
        J::String(s) => DataValue::Text(s.clone()),
        other => serde_json::from_value(other.clone())
            .unwrap_or_else(|_| DataValue::Text(other.to_string())),
    }
}

fn text_of(value: &DataValue) -> Option<&str> {
    match value {
        DataValue::Text(s) | DataValue::Date(s) | DataValue::Timestamp(s) => Some(s.trim()),
        _ => None,
    }
}

fn parse_date(s: &str) -> Option<i32> {
    let date = chrono::NaiveDate::parse_from_str(s.get(..10).unwrap_or(s), "%Y-%m-%d").ok()?;
    Some((date - chrono::NaiveDate::from_ymd_opt(1970, 1, 1)?).num_days() as i32)
}

fn parse_timestamp(s: &str) -> Option<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(t.timestamp_micros());
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, format) {
            return Some(t.and_utc().timestamp_micros());
        }
    }
    let days = parse_date(s)?;
    Some(days as i64 * 86_400_000_000)
}

/// Converts a value to the DuckDB value bound for a parameter of `logical` type
/// (`None` infers the type from the value).
pub fn bind_value(
    name: &str,
    logical: Option<&str>,
    value: &DataValue,
) -> Result<DuckValue, String> {
    let bad = |expected: &str| format!("Parameter ${name} expects {expected}, got {value:?}");
    if matches!(value, DataValue::Null) {
        return Ok(DuckValue::Null);
    }
    let logical = match logical {
        Some(t) => logical_type(t)
            .ok_or_else(|| format!("Parameter ${name} has unsupported type {t:?}"))?,
        None => match value {
            DataValue::Integer(_) => "integer",
            DataValue::Real(_) => "number",
            DataValue::Boolean(_) => "boolean",
            DataValue::Date(_) => "date",
            DataValue::Timestamp(_) => "timestamp",
            DataValue::Blob(_) => "blob",
            _ => "text",
        },
    };
    Ok(match logical {
        "text" => match value {
            DataValue::Integer(v) => DuckValue::Text(v.to_string()),
            DataValue::Real(v) => DuckValue::Text(v.to_string()),
            DataValue::Boolean(v) => DuckValue::Text(v.to_string()),
            other => DuckValue::Text(text_of(other).ok_or_else(|| bad("text"))?.to_string()),
        },
        "integer" => DuckValue::BigInt(match value {
            DataValue::Integer(v) => *v,
            DataValue::Real(v) if v.fract() == 0.0 && v.is_finite() => *v as i64,
            DataValue::Boolean(v) => *v as i64,
            other => text_of(other)
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| bad("an integer"))?,
        }),
        "number" => DuckValue::Double(match value {
            DataValue::Integer(v) => *v as f64,
            DataValue::Real(v) if v.is_finite() => *v,
            other => text_of(other)
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .ok_or_else(|| bad("a number"))?,
        }),
        "boolean" => DuckValue::Boolean(match value {
            DataValue::Boolean(v) => *v,
            DataValue::Integer(v @ (0 | 1)) => *v == 1,
            other => match text_of(other).map(str::to_ascii_lowercase).as_deref() {
                Some("true" | "yes" | "1") => true,
                Some("false" | "no" | "0") => false,
                _ => return Err(bad("true or false")),
            },
        }),
        "date" => DuckValue::Date32(
            text_of(value)
                .and_then(parse_date)
                .ok_or_else(|| bad("a date (YYYY-MM-DD)"))?,
        ),
        "timestamp" => DuckValue::Timestamp(
            TimeUnit::Microsecond,
            text_of(value)
                .and_then(parse_timestamp)
                .ok_or_else(|| bad("a timestamp"))?,
        ),
        _ => DuckValue::Blob(match value {
            DataValue::Blob(v) => STANDARD.decode(v).map_err(|_| bad("base64 data"))?,
            _ => return Err(bad("binary data")),
        }),
    })
}

/// Resolves the value bound to each placeholder: supplied value, else declared
/// default, else NULL. A required parameter without a value is a validation error.
/// When `declared_only` is set, every placeholder must be a declared parameter.
pub fn resolve_params(
    names: &[String],
    declared: &[QueryParameter],
    supplied: &[NamedValue],
    declared_only: bool,
) -> Result<Vec<DuckValue>, AppError> {
    let invalid = |m: String| AppError::new("VALIDATION_ERROR", m);
    names
        .iter()
        .map(|name| {
            let decl = declared.iter().find(|p| &p.name == name);
            let given = supplied
                .iter()
                .find(|v| &v.column == name)
                .map(|v| &v.value);
            let value = match (given, decl) {
                (Some(v), _) if !matches!(v, DataValue::Null) => v.clone(),
                (_, Some(p)) => match p.default_value.as_ref().map(json_value) {
                    Some(v) if !matches!(v, DataValue::Null) => v,
                    _ if p.required => {
                        return Err(invalid(format!("Parameter ${name} is required")))
                    }
                    _ => DataValue::Null,
                },
                (None, None) if !declared_only => {
                    return Err(invalid(format!("Missing value for parameter ${name}")))
                }
                (_, None) if declared_only => {
                    return Err(invalid(format!(
                        "Query uses ${name}, but no parameter named {name} is declared"
                    )))
                }
                _ => DataValue::Null,
            };
            bind_value(name, decl.map(|p| p.logical_type.as_str()), &value).map_err(invalid)
        })
        .collect()
}
