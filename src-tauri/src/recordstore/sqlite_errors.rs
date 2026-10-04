//! Maps SQLite failures to stable RecordStore error codes.
use super::model::StoreError;
use rusqlite::ffi;

pub fn map_error(e: rusqlite::Error) -> StoreError {
    let text = e.to_string();
    if let rusqlite::Error::SqliteFailure(f, msg) = &e {
        let detail = msg.clone().unwrap_or_default();
        let after = |prefix: &str| detail.split_once(prefix).map(|x| x.1.trim().to_string());
        return match f.extended_code {
            ffi::SQLITE_CONSTRAINT_NOTNULL => StoreError::constraint(
                "not_null",
                after("failed:")
                    .map(|c| format!("{c} is required"))
                    .unwrap_or(detail),
            ),
            ffi::SQLITE_CONSTRAINT_UNIQUE => StoreError::constraint(
                "unique",
                after("failed:")
                    .map(|c| format!("{c} must be unique"))
                    .unwrap_or(detail),
            ),
            ffi::SQLITE_CONSTRAINT_PRIMARYKEY | ffi::SQLITE_CONSTRAINT_ROWID => {
                StoreError::constraint("primary_key", after("failed:").unwrap_or(detail))
            }
            ffi::SQLITE_CONSTRAINT_FOREIGNKEY => StoreError::constraint(
                "foreign_key",
                "a related record is missing or still references this record",
            ),
            ffi::SQLITE_CONSTRAINT_CHECK => {
                let name = after("failed:").unwrap_or_default();
                match name.strip_prefix("ixt_type_") {
                    Some(column) => StoreError::constraint(
                        "check",
                        format!("{column} has a value of the wrong type"),
                    ),
                    None => StoreError::constraint("check", name),
                }
            }
            _ => match f.code {
                rusqlite::ErrorCode::ConstraintViolation => StoreError::constraint("", detail),
                rusqlite::ErrorCode::ReadOnly => StoreError::new("READ_ONLY", text),
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                    StoreError::new("BUSY", text)
                }
                rusqlite::ErrorCode::CannotOpen => StoreError::new("CONNECTION", text),
                _ if detail.contains("no such table")
                    || detail.contains("no such column")
                    || detail.contains("no such index") =>
                {
                    StoreError::new("NOT_FOUND", detail)
                }
                _ if detail.contains("cannot modify") && detail.contains("view") => {
                    StoreError::new("READ_ONLY", detail)
                }
                _ => StoreError::new(
                    "DATABASE_ERROR",
                    if detail.is_empty() { text } else { detail },
                ),
            },
        };
    }
    StoreError::new("DATABASE_ERROR", text)
}
pub fn se(e: rusqlite::Error) -> StoreError {
    map_error(e)
}
