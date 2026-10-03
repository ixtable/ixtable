//! Logical column types (PRD §11) and their per-store physical mapping.
//!
//! A logical type is what the designer, forms, and expressions speak. Each
//! RecordStore maps it to a physical type: SQLite declared types plus named
//! `ixt_type_*` CHECK constraints where SQLite has no native enforcement;
//! PostgreSQL native types. Values cross the command boundary in canonical
//! text forms so DuckDB reads over either store compare equal:
//! decimal `-12.30`, date `2024-01-31`, time `13:05:09[.123]`,
//! timestamp `2024-01-31T13:05:09[.123]` (UTC, no zone), uuid lower-case.
pub use super::values::{
    canonical_decimal, format_time, format_timestamp, parse_date, parse_time, parse_timestamp,
};
use super::{q, DataValue};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{fmt, str::FromStr};

/// Largest decimal precision SQLite can store losslessly (NUMERIC affinity
/// keeps 15 significant digits). PostgreSQL allows 1000; DuckDB reads 38.
pub const SQLITE_MAX_DECIMAL_PRECISION: u8 = 15;
pub const MAX_DECIMAL_PRECISION: u8 = 38;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogicalType {
    Text,
    Integer,
    Real,
    Decimal { precision: Option<u8>, scale: u8 },
    Boolean,
    Date,
    Time,
    Timestamp,
    Uuid,
    Json,
    Blob,
}

impl fmt::Display for LogicalType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text => f.write_str("text"),
            Self::Integer => f.write_str("integer"),
            Self::Real => f.write_str("real"),
            Self::Decimal {
                precision: Some(p),
                scale,
            } => write!(f, "decimal({p},{scale})"),
            Self::Decimal {
                precision: None, ..
            } => f.write_str("decimal"),
            Self::Boolean => f.write_str("boolean"),
            Self::Date => f.write_str("date"),
            Self::Time => f.write_str("time"),
            Self::Timestamp => f.write_str("timestamp"),
            Self::Uuid => f.write_str("uuid"),
            Self::Json => f.write_str("json"),
            Self::Blob => f.write_str("blob"),
        }
    }
}

impl FromStr for LogicalType {
    type Err = String;
    fn from_str(raw: &str) -> Result<Self, String> {
        let s = raw.trim().to_ascii_lowercase();
        let (head, args) = match s.find('(') {
            Some(open) if s.ends_with(')') => (s[..open].trim(), Some(&s[open + 1..s.len() - 1])),
            _ => (s.as_str(), None),
        };
        Ok(match (head, args) {
            ("text", None) => Self::Text,
            ("integer", None) => Self::Integer,
            ("real", None) => Self::Real,
            ("decimal", None) => Self::Decimal {
                precision: None,
                scale: 0,
            },
            ("decimal", Some(args)) => {
                let parts: Vec<_> = args.split(',').map(str::trim).collect();
                let precision: u8 = parts[0]
                    .parse()
                    .map_err(|_| format!("Invalid decimal precision in {raw:?}"))?;
                let scale: u8 = match parts.get(1) {
                    Some(s) => s
                        .parse()
                        .map_err(|_| format!("Invalid decimal scale in {raw:?}"))?,
                    None => 0,
                };
                if parts.len() > 2 || precision == 0 || precision > MAX_DECIMAL_PRECISION {
                    return Err(format!(
                        "Decimal precision must be between 1 and {MAX_DECIMAL_PRECISION}"
                    ));
                }
                if scale > precision {
                    return Err("Decimal scale cannot exceed its precision".into());
                }
                Self::Decimal {
                    precision: Some(precision),
                    scale,
                }
            }
            ("boolean", None) => Self::Boolean,
            ("date", None) => Self::Date,
            ("time", None) => Self::Time,
            ("timestamp", None) => Self::Timestamp,
            ("uuid", None) => Self::Uuid,
            ("json", None) => Self::Json,
            ("blob", None) => Self::Blob,
            _ => return Err(format!("Unknown logical type {raw:?}")),
        })
    }
}

impl Serialize for LogicalType {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for LogicalType {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Every logical type name the designer offers, in picker order.
pub const LOGICAL_TYPE_NAMES: &[&str] = &[
    "text",
    "integer",
    "real",
    "decimal",
    "boolean",
    "date",
    "time",
    "timestamp",
    "uuid",
    "json",
    "blob",
];

impl LogicalType {
    /// SQLite declared type; it also records the logical type (`TIME TEXT` keeps DuckDB from reading times as timestamps).
    pub fn sqlite_declared(&self) -> String {
        match self {
            Self::Text => "TEXT".into(),
            Self::Integer => "INTEGER".into(),
            Self::Real => "REAL".into(),
            Self::Decimal {
                precision: Some(p),
                scale,
            } => format!("DECIMAL({p},{scale})"),
            Self::Decimal {
                precision: None, ..
            } => "DECIMAL".into(),
            Self::Boolean => "BOOLEAN".into(),
            Self::Date => "DATE".into(),
            Self::Time => "TIME TEXT".into(),
            Self::Timestamp => "TIMESTAMP".into(),
            Self::Uuid => "UUID".into(),
            Self::Json => "JSON".into(),
            Self::Blob => "BLOB".into(),
        }
    }
    /// The SQLite CHECK body that enforces the logical domain, if SQLite needs one.
    pub fn sqlite_check(&self, column: &str) -> Option<String> {
        let c = q(column);
        Some(match self {
            Self::Decimal { .. } => {
                format!("{c} IS NULL OR typeof({c}) IN ('integer','real')")
            }
            Self::Boolean => format!("{c} IS NULL OR {c} IN (0,1)"),
            Self::Date => format!("{c} IS NULL OR date({c}) IS {c}"),
            Self::Time => format!("{c} IS NULL OR time({c}) IS NOT NULL"),
            Self::Timestamp => format!("{c} IS NULL OR datetime({c}) IS NOT NULL"),
            Self::Uuid => format!("{c} IS NULL OR (typeof({c})='text' AND length({c})=36)"),
            Self::Json => format!("{c} IS NULL OR json_valid({c})"),
            _ => return None,
        })
    }
    /// The name of the generated logical-type CHECK for a column.
    pub fn sqlite_check_name(column: &str) -> String {
        format!("ixt_type_{column}")
    }
    pub fn postgres_type(&self) -> String {
        match self {
            Self::Text => "TEXT".into(),
            Self::Integer => "BIGINT".into(),
            Self::Real => "DOUBLE PRECISION".into(),
            Self::Decimal {
                precision: Some(p),
                scale,
            } => format!("NUMERIC({p},{scale})"),
            Self::Decimal {
                precision: None, ..
            } => "NUMERIC".into(),
            Self::Boolean => "BOOLEAN".into(),
            Self::Date => "DATE".into(),
            Self::Time => "TIME".into(),
            Self::Timestamp => "TIMESTAMP".into(),
            Self::Uuid => "UUID".into(),
            Self::Json => "JSONB".into(),
            Self::Blob => "BYTEA".into(),
        }
    }
    /// Infers the logical type of a SQLite declared type (affinity rules plus the names `sqlite_declared` emits). Unknown or empty types are text.
    pub fn from_sqlite_declared(declared: &str) -> Self {
        let upper = declared.trim().to_ascii_uppercase();
        let head = upper.split('(').next().unwrap_or("").trim();
        let decimal_args = || {
            let inner = upper.split_once('(')?.1.trim_end_matches(')');
            let mut parts = inner.split(',').map(|x| x.trim().parse::<u8>().ok());
            Some((parts.next()??, parts.next().flatten().unwrap_or(0)))
        };
        match head {
            "BOOLEAN" | "BOOL" => Self::Boolean,
            "DATE" => Self::Date,
            "TIME" | "TIME TEXT" => Self::Time,
            "TIMESTAMP" | "DATETIME" => Self::Timestamp,
            "UUID" => Self::Uuid,
            "JSON" | "JSONB" => Self::Json,
            "DECIMAL" | "NUMERIC" => match decimal_args() {
                Some((p, s)) if p > 0 && s <= p => Self::Decimal {
                    precision: Some(p),
                    scale: s,
                },
                _ => Self::Decimal {
                    precision: None,
                    scale: 0,
                },
            },
            _ if upper.contains("INT") => Self::Integer,
            _ if upper.contains("CHAR") || upper.contains("CLOB") || upper.contains("TEXT") => {
                Self::Text
            }
            _ if upper.contains("BLOB") => Self::Blob,
            _ if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") => {
                Self::Real
            }
            _ => Self::Text,
        }
    }
    /// Infers the logical type of a PostgreSQL `format_type` string.
    pub fn from_postgres(formatted: &str) -> Self {
        let lower = formatted.trim().to_ascii_lowercase();
        let head = lower.split('(').next().unwrap_or("").trim();
        match head {
            "smallint" | "integer" | "bigint" | "int2" | "int4" | "int8" => Self::Integer,
            "real" | "double precision" | "float4" | "float8" => Self::Real,
            "numeric" | "decimal" => {
                Self::from_sqlite_declared(&lower.replace("numeric", "decimal"))
            }
            "boolean" | "bool" => Self::Boolean,
            "date" => Self::Date,
            "uuid" => Self::Uuid,
            "json" | "jsonb" => Self::Json,
            "bytea" => Self::Blob,
            _ if head.starts_with("timestamp") => Self::Timestamp,
            _ if head.starts_with("time") => Self::Time,
            _ => Self::Text,
        }
    }
    pub fn decimal_scale(&self) -> Option<u8> {
        match self {
            Self::Decimal { scale, .. } => Some(*scale),
            _ => None,
        }
    }

    /// Validates and canonicalises a value before it is written to any store. Text input is accepted for every type so grids and forms can send what the user typed; the result is the canonical `DataValue` for the type.
    pub fn normalize(&self, column: &str, value: &DataValue) -> Result<DataValue, String> {
        let bad = |what: &str| format!("{column} requires {what}");
        if matches!(value, DataValue::Null) {
            return Ok(DataValue::Null);
        }
        let text = value.as_text();
        Ok(match self {
            Self::Text => match value {
                DataValue::Blob(_) => return Err(bad("text")),
                _ => DataValue::Text(text.ok_or_else(|| bad("text"))?),
            },
            Self::Integer => DataValue::Integer(match value {
                DataValue::Integer(v) => *v,
                DataValue::Boolean(v) => *v as i64,
                DataValue::Real(v) if v.fract() == 0.0 && v.abs() < 9.2e18 => *v as i64,
                _ => text
                    .and_then(|t| t.trim().parse().ok())
                    .ok_or_else(|| bad("an integer"))?,
            }),
            Self::Real => DataValue::Real(match value {
                DataValue::Real(v) if v.is_finite() => *v,
                DataValue::Integer(v) => *v as f64,
                _ => text
                    .and_then(|t| t.trim().parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .ok_or_else(|| bad("a finite number"))?,
            }),
            Self::Decimal { precision, scale } => {
                let raw = match value {
                    DataValue::Real(v) if v.is_finite() => format!("{v}"),
                    _ => text.ok_or_else(|| bad("a decimal number"))?,
                };
                DataValue::Decimal(
                    canonical_decimal(&raw, *precision, *scale)
                        .map_err(|e| format!("{column}: {e}"))?,
                )
            }
            Self::Boolean => DataValue::Boolean(match value {
                DataValue::Boolean(v) => *v,
                DataValue::Integer(0) => false,
                DataValue::Integer(1) => true,
                _ => match text
                    .as_deref()
                    .map(|t| t.trim().to_ascii_lowercase())
                    .as_deref()
                {
                    Some("true" | "1" | "yes") => true,
                    Some("false" | "0" | "no") => false,
                    _ => return Err(bad("true or false")),
                },
            }),
            Self::Date => DataValue::Date(
                text.as_deref()
                    .and_then(parse_date)
                    .ok_or_else(|| bad("a date (YYYY-MM-DD)"))?
                    .format("%Y-%m-%d")
                    .to_string(),
            ),
            Self::Time => DataValue::Time(format_time(
                text.as_deref()
                    .and_then(parse_time)
                    .ok_or_else(|| bad("a time (HH:MM:SS)"))?,
            )),
            Self::Timestamp => DataValue::Timestamp(format_timestamp(
                text.as_deref()
                    .and_then(parse_timestamp)
                    .ok_or_else(|| bad("a timestamp (YYYY-MM-DDTHH:MM:SS)"))?,
            )),
            Self::Uuid => DataValue::Text(
                uuid::Uuid::parse_str(text.as_deref().unwrap_or("").trim())
                    .map_err(|_| bad("a UUID"))?
                    .hyphenated()
                    .to_string(),
            ),
            Self::Json => {
                let t = text.ok_or_else(|| bad("JSON text"))?;
                serde_json::from_str::<serde_json::Value>(&t).map_err(|_| bad("valid JSON"))?;
                DataValue::Text(t)
            }
            Self::Blob => match value {
                DataValue::Blob(v) => {
                    STANDARD
                        .decode(v)
                        .map_err(|_| "Blob values must be valid base64".to_string())?;
                    DataValue::Blob(v.clone())
                }
                _ => return Err(bad("binary data")),
            },
        })
    }

    /// Converts a value read through DuckDB into the canonical form for the column's logical type (e.g. SQLite stores booleans as 0/1 and decimals with NUMERIC affinity; PostgreSQL JSON arrives as text).
    pub fn coerce_read(&self, value: DataValue) -> DataValue {
        match (self, value) {
            (_, DataValue::Null) => DataValue::Null,
            (Self::Boolean, DataValue::Integer(v)) => DataValue::Boolean(v != 0),
            (Self::Boolean, DataValue::Text(t)) => match t.to_ascii_lowercase().as_str() {
                "1" | "true" | "t" => DataValue::Boolean(true),
                "0" | "false" | "f" => DataValue::Boolean(false),
                _ => DataValue::Text(t),
            },
            (Self::Decimal { scale, .. }, DataValue::Real(v)) => {
                DataValue::Decimal(format!("{v:.*}", *scale as usize))
            }
            (Self::Decimal { scale, .. }, DataValue::Integer(v)) => {
                DataValue::Decimal(if *scale == 0 {
                    v.to_string()
                } else {
                    format!("{v}.{}", "0".repeat(*scale as usize))
                })
            }
            (Self::Decimal { precision, scale }, DataValue::Text(t))
            | (Self::Decimal { precision, scale }, DataValue::Decimal(t)) => {
                DataValue::Decimal(canonical_decimal(&t, *precision, *scale).unwrap_or(t))
            }
            (Self::Date, DataValue::Text(t)) => match parse_date(&t) {
                Some(d) => DataValue::Date(d.format("%Y-%m-%d").to_string()),
                None => DataValue::Text(t),
            },
            (Self::Date, DataValue::Timestamp(t)) => DataValue::Date(t[..10.min(t.len())].into()),
            (Self::Time, DataValue::Text(t)) => match parse_time(&t) {
                Some(v) => DataValue::Time(format_time(v)),
                None => DataValue::Text(t),
            },
            (Self::Time, DataValue::Timestamp(t)) => match parse_timestamp(&t) {
                Some(v) => DataValue::Time(format_time(v.time())),
                None => DataValue::Timestamp(t),
            },
            (Self::Timestamp, DataValue::Text(t)) => match parse_timestamp(&t) {
                Some(v) => DataValue::Timestamp(format_timestamp(v)),
                None => DataValue::Text(t),
            },
            (Self::Uuid | Self::Json | Self::Text, DataValue::Integer(v)) => {
                DataValue::Text(v.to_string())
            }
            (Self::Uuid | Self::Json | Self::Text, DataValue::Real(v)) => {
                DataValue::Text(v.to_string())
            }
            (Self::Uuid, DataValue::Text(t)) => DataValue::Text(t.to_ascii_lowercase()),
            (_, other) => other,
        }
    }
}

impl DataValue {
    /// The text form of a scalar value (blobs excluded).
    pub fn as_text(&self) -> Option<String> {
        match self {
            Self::Null | Self::Blob(_) => None,
            Self::Integer(v) => Some(v.to_string()),
            Self::Real(v) => Some(v.to_string()),
            Self::Boolean(v) => Some(v.to_string()),
            Self::Text(v)
            | Self::Date(v)
            | Self::Timestamp(v)
            | Self::Decimal(v)
            | Self::Time(v) => Some(v.clone()),
        }
    }
}
