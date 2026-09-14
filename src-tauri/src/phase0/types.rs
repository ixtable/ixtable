//! RecordStore / DuckDB logical-type compatibility matrix for the MVP.
use duckdb::Connection;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeMapping {
    pub logical: &'static str,
    pub sqlite: &'static str,
    pub postgres: &'static str,
    pub duckdb: &'static str,
    pub notes: &'static str,
}

pub const MATRIX: &[TypeMapping] = &[
    TypeMapping {
        logical: "boolean",
        sqlite: "INTEGER 0/1",
        postgres: "BOOLEAN",
        duckdb: "BOOLEAN",
        notes: "SQLite has no native boolean. Writers store 0/1. DuckDB reads BOOLEAN.",
    },
    TypeMapping {
        logical: "integer",
        sqlite: "INTEGER",
        postgres: "BIGINT",
        duckdb: "BIGINT",
        notes: "Identity integers use the full i64 domain.",
    },
    TypeMapping {
        logical: "real",
        sqlite: "REAL",
        postgres: "DOUBLE PRECISION",
        duckdb: "DOUBLE",
        notes: "NaN and infinities are rejected at the RecordStore boundary.",
    },
    TypeMapping {
        logical: "decimal",
        sqlite: "TEXT",
        postgres: "NUMERIC",
        duckdb: "DECIMAL",
        notes: "SQLite stores canonical decimal text. Do not use REAL for money.",
    },
    TypeMapping {
        logical: "text",
        sqlite: "TEXT",
        postgres: "TEXT",
        duckdb: "VARCHAR",
        notes: "UTF-8. NULs are rejected.",
    },
    TypeMapping {
        logical: "date",
        sqlite: "TEXT ISO-8601",
        postgres: "DATE",
        duckdb: "DATE",
        notes: "Calendar dates as YYYY-MM-DD.",
    },
    TypeMapping {
        logical: "timestamp",
        sqlite: "TEXT RFC3339",
        postgres: "TIMESTAMPTZ",
        duckdb: "TIMESTAMP WITH TIME ZONE",
        notes: "UTC. Store offsets explicitly.",
    },
    TypeMapping {
        logical: "blob",
        sqlite: "BLOB",
        postgres: "BYTEA",
        duckdb: "BLOB",
        notes: "Application assets stay in archive rows, not this type.",
    },
    TypeMapping {
        logical: "uuid",
        sqlite: "TEXT",
        postgres: "UUID",
        duckdb: "UUID",
        notes: "Canonical lowercase hyphenated form.",
    },
    TypeMapping {
        logical: "json",
        sqlite: "TEXT",
        postgres: "JSONB",
        duckdb: "JSON",
        notes: "Validated JSON text. Postgres may reorder JSONB keys.",
    },
];

pub fn duckdb_round_trip(path: &Path) -> Result<Vec<(String, String)>, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE type_probe(
            flag BOOLEAN NOT NULL,
            whole BIGINT NOT NULL,
            real_value DOUBLE NOT NULL,
            money DECIMAL(10,2) NOT NULL,
            label VARCHAR NOT NULL,
            day DATE NOT NULL,
            ts TIMESTAMP NOT NULL,
            blob_value BLOB NOT NULL,
            id UUID NOT NULL,
            doc JSON NOT NULL
         );
         INSERT INTO type_probe VALUES(
            true, 9223372036854775807, 1.5, 12.50, 'ok',
            DATE '2026-09-14', TIMESTAMP '2026-09-14 00:00:00',
            '\\xDEADBEEF'::BLOB,
            '11111111-1111-1111-1111-111111111111'::UUID,
            '{\"a\":1}'::JSON
         );",
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT typeof(flag), typeof(whole), typeof(real_value), typeof(money),
                    typeof(label), typeof(day), typeof(ts), typeof(blob_value),
                    typeof(id), typeof(doc) FROM type_probe",
        )
        .map_err(|e| e.to_string())?;
    stmt.query_row([], |r| {
        Ok(vec![
            ("boolean", r.get::<_, String>(0)?),
            ("integer", r.get::<_, String>(1)?),
            ("real", r.get::<_, String>(2)?),
            ("decimal", r.get::<_, String>(3)?),
            ("text", r.get::<_, String>(4)?),
            ("date", r.get::<_, String>(5)?),
            ("timestamp", r.get::<_, String>(6)?),
            ("blob", r.get::<_, String>(7)?),
            ("uuid", r.get::<_, String>(8)?),
            ("json", r.get::<_, String>(9)?),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v))
        .collect())
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::ReadRuntime;
    use uuid::Uuid;

    #[test]
    fn matrix_covers_mvp_logical_types() {
        let names: Vec<_> = MATRIX.iter().map(|m| m.logical).collect();
        assert_eq!(
            names,
            [
                "boolean", "integer", "real", "decimal", "text", "date", "timestamp", "blob",
                "uuid", "json"
            ]
        );
        for mapping in MATRIX {
            assert!(!mapping.sqlite.is_empty());
            assert!(!mapping.postgres.is_empty());
            assert!(!mapping.duckdb.is_empty());
        }
    }

    #[test]
    fn duckdb_storage_types_match_the_matrix() {
        let path = std::env::temp_dir().join(format!("ixtable-types-{}.db", Uuid::new_v4()));
        let classes = duckdb_round_trip(&path).unwrap();
        assert_eq!(classes[0], ("boolean".into(), "BOOLEAN".into()));
        assert_eq!(classes[1], ("integer".into(), "BIGINT".into()));
        assert_eq!(classes[2], ("real".into(), "DOUBLE".into()));
        assert!(classes[3].1.to_ascii_uppercase().contains("DECIMAL"));
        assert_eq!(classes[7], ("blob".into(), "BLOB".into()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn duckdb_reads_native_logical_values() {
        let workspace = std::env::temp_dir().join(format!("ixtable-types-duck-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let db = workspace.join("data.db");
        duckdb_round_trip(&db).unwrap();
        let runtime = ReadRuntime::new(&workspace, std::path::Path::new("")).unwrap();
        let result = runtime
            .query("SELECT flag, whole, money, day, id FROM type_probe")
            .unwrap();
        assert_eq!(result.rows[0][0], crate::data::DataValue::Boolean(true));
        assert_eq!(
            result.rows[0][1],
            crate::data::DataValue::Integer(i64::MAX)
        );
        let _ = std::fs::remove_dir_all(workspace);
    }
}
