//! Reader support: DuckDB type mapping, credential redaction, the
//! checksum-pinned postgres_scanner location, and `TableSchema` assembly.
use super::{ddl::TableDef, logical::LogicalType, Column, TableSchema};
use std::path::PathBuf;

/// Logical type of a DuckDB column type (used for views and ad-hoc results).
pub fn logical_from_duckdb(data_type: &str) -> LogicalType {
    let upper = data_type.to_ascii_uppercase();
    match upper.split('(').next().unwrap_or("").trim() {
        "BOOLEAN" => LogicalType::Boolean,
        "DATE" => LogicalType::Date,
        "TIME" => LogicalType::Time,
        "UUID" => LogicalType::Uuid,
        "JSON" => LogicalType::Json,
        "BLOB" => LogicalType::Blob,
        "DOUBLE" | "FLOAT" | "REAL" => LogicalType::Real,
        "DECIMAL" => LogicalType::from_sqlite_declared(&upper),
        t if t.starts_with("TIMESTAMP") => LogicalType::Timestamp,
        t if t.contains("INT") => LogicalType::Integer,
        _ => LogicalType::Text,
    }
}

/// Removes credentials (`password=...`, quoted values with spaces or escapes,
/// URL user info) from libpq error text before it is surfaced.
pub fn redact(message: &str) -> String {
    crate::logging::redact(message)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET: &str = "macos-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET: &str = "macos-x64";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET: &str = "windows-x64";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET: &str = "linux-x64";
#[cfg(not(any(
    all(
        target_os = "macos",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
const TARGET: &str = "unsupported";

/// postgres_scanner v1.5.5 (DuckDB 1.5.5 ABI), uncompressed SHA-256 per
/// platform; see resources/duckdb/manifest.json.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const POSTGRES_EXPECTED: &str = "f39dd59bf57679d0242e19e180d90b4222e5cdb691ab67c7506658f3548c0e05";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const POSTGRES_EXPECTED: &str = "0df780444ce04a75c5a4e7b89896eab5cebe1ca21163fc6c267f3365ffe4a3c1";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const POSTGRES_EXPECTED: &str = "fc026ca03659889080606f0dacfd4e3976479df52660fafc763642e14bb36be2";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const POSTGRES_EXPECTED: &str = "b1ced4cfc6311313e117c2afb3eac76508718778dde0716421503c7dbfb5605c";
#[cfg(not(any(
    all(
        target_os = "macos",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
const POSTGRES_EXPECTED: &str = "";

pub(crate) fn resource_candidates(file: &str) -> Vec<PathBuf> {
    let relative = PathBuf::from("resources")
        .join("duckdb")
        .join(TARGET)
        .join(file);
    let mut candidates = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&relative)];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(&relative));
            candidates.push(parent.join("../Resources").join(&relative));
        }
    }
    candidates
}

/// The bundled, checksum-pinned postgres_scanner extension for this platform
/// (`IXTABLE_DUCKDB_POSTGRES_EXTENSION` overrides the location, not the pin).
pub fn postgres_extension_path() -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let path = std::env::var_os("IXTABLE_DUCKDB_POSTGRES_EXTENSION")
        .map(PathBuf::from)
        .or_else(|| {
            resource_candidates("postgres_scanner.duckdb_extension")
                .into_iter()
                .find(|p| p.is_file())
        })
        .ok_or_else(|| format!("Missing bundled DuckDB PostgreSQL extension for {TARGET}"))?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != POSTGRES_EXPECTED {
        return Err(format!(
            "DuckDB PostgreSQL extension checksum mismatch: {actual}"
        ));
    }
    Ok(path)
}

impl TableSchema {
    pub fn from_def(def: TableDef, object_type: String) -> Self {
        let columns = def
            .columns
            .iter()
            .map(|c| Column {
                name: c.name.clone(),
                declared_type: c.declared_type.clone(),
                logical_type: c.logical_type.clone(),
                nullable: c.nullable
                    && !def
                        .primary_key
                        .iter()
                        .any(|k| k == &c.name && def.without_rowid),
                default_value: c.default_expression.clone(),
                primary_key_position: def
                    .primary_key
                    .iter()
                    .position(|k| k.eq_ignore_ascii_case(&c.name))
                    .map(|p| p as u32 + 1)
                    .unwrap_or(0),
                generated: c.generated_expression.is_some(),
                unique: def.is_unique_column(&c.name),
            })
            .collect();
        Self {
            foreign_keys: def
                .foreign_keys
                .iter()
                .enumerate()
                .map(|(id, f)| super::ForeignKey {
                    id: id as i64,
                    name: f.name.clone(),
                    from_columns: f.columns.clone(),
                    target_table: f.target_table.clone(),
                    target_columns: f.target_columns.clone(),
                    on_update: f.on_update.clone(),
                    on_delete: f.on_delete.clone(),
                })
                .collect(),
            name: def.name,
            columns,
            without_rowid: def.without_rowid,
            primary_key: def.primary_key,
            uniques: def.uniques,
            checks: def.checks,
            indexes: def.indexes,
            object_type,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_redacted_from_connection_errors() {
        assert_eq!(
            redact("failed: host=db password='se cret' user=x"),
            "failed: host=db password='***' user=x"
        );
        assert_eq!(redact("password=abc dbname=x"), "password=*** dbname=x");
        assert_eq!(
            redact(r"password='it\'s secret' dbname=x"),
            "password='***' dbname=x"
        );
        assert_eq!(redact(r#"pwd="x y" dbname=x"#), r#"pwd="***" dbname=x"#);
        let url = redact("connect to postgresql://app:p@ss%20word@db:5432/x failed");
        assert!(!url.contains("p@ss"), "{url}");
    }
    #[test]
    fn duckdb_types_map_to_logical_types() {
        assert_eq!(
            logical_from_duckdb("DECIMAL(10,2)").to_string(),
            "decimal(10,2)"
        );
        assert_eq!(
            logical_from_duckdb("TIMESTAMP WITH TIME ZONE"),
            LogicalType::Timestamp
        );
        assert_eq!(logical_from_duckdb("BIGINT"), LogicalType::Integer);
        assert_eq!(logical_from_duckdb("VARCHAR"), LogicalType::Text);
    }
}
