//! Reader support: DuckDB type mapping, credential redaction, and
//! `TableSchema` assembly.
use super::{ddl::TableDef, logical::LogicalType, Column, TableSchema};

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
                auto_increment: c.identity
                    || c.default_expression
                        .as_deref()
                        .is_some_and(|d| d.contains("nextval(")),
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
