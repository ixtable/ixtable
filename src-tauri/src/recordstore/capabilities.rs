//! Published store capabilities (PRD §9.4). The designer reads these to speak
//! "changes in place" vs "requires table rebuild" instead of SQLite-only terms.
use crate::data::{LogicalType, LOGICAL_TYPE_NAMES, SQLITE_MAX_DECIMAL_PRECISION};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TypeCapability {
    pub logical_type: String,
    pub physical_type: String,
    pub enforcement: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_precision: Option<u8>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DdlCapability {
    pub operation: String,
    /// `inPlace`, `rebuild`, or `unsupported` (the usual case; a preview may differ).
    pub mode: String,
    pub notes: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexCapability {
    pub unique: bool,
    pub multi_column: bool,
    pub partial: bool,
    pub expression: bool,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransactionCapability {
    pub atomic_batches: bool,
    pub transactional_ddl: bool,
    pub savepoints: bool,
    pub isolation: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCapability {
    pub transactional_ddl: bool,
    pub dry_run: String,
    pub health_checks: Vec<String>,
    pub notes: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorMapping {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraint: Option<String>,
    pub native: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConcurrencyCapability {
    pub policies: Vec<String>,
    pub optimistic_check: String,
    pub row_locking: bool,
    pub multi_user: bool,
    pub notes: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreCapabilities {
    pub store: String,
    pub logical_types: Vec<TypeCapability>,
    pub ddl: Vec<DdlCapability>,
    pub constraints: Vec<String>,
    pub foreign_key_actions: Vec<String>,
    pub indexes: IndexCapability,
    pub transactions: TransactionCapability,
    pub parameter_style: String,
    pub generated_values: Vec<String>,
    pub migrations: MigrationCapability,
    pub error_codes: Vec<ErrorMapping>,
    pub concurrency: ConcurrencyCapability,
}

fn ddl(operation: &str, mode: &str, notes: &str) -> DdlCapability {
    DdlCapability {
        operation: operation.into(),
        mode: mode.into(),
        notes: notes.into(),
    }
}
fn err(code: &str, constraint: Option<&str>, native: &str, description: &str) -> ErrorMapping {
    ErrorMapping {
        code: code.into(),
        constraint: constraint.map(Into::into),
        native: native.into(),
        description: description.into(),
    }
}
fn common_errors(native: [&str; 9]) -> Vec<ErrorMapping> {
    vec![
        err(
            "CONSTRAINT_VIOLATION",
            Some("not_null"),
            native[0],
            "A required value is missing.",
        ),
        err(
            "CONSTRAINT_VIOLATION",
            Some("unique"),
            native[1],
            "A value must be unique.",
        ),
        err(
            "CONSTRAINT_VIOLATION",
            Some("primary_key"),
            native[2],
            "The primary key already exists.",
        ),
        err(
            "CONSTRAINT_VIOLATION",
            Some("foreign_key"),
            native[3],
            "A related record is missing or still referenced.",
        ),
        err(
            "CONSTRAINT_VIOLATION",
            Some("check"),
            native[4],
            "A check constraint rejected the value.",
        ),
        err(
            "READ_ONLY",
            None,
            native[5],
            "The object or connection does not accept writes.",
        ),
        err(
            "CONNECTION",
            None,
            native[6],
            "The store could not be reached.",
        ),
        err(
            "BUSY",
            None,
            native[7],
            "The store is locked or a transaction must be retried.",
        ),
        err(
            "NOT_FOUND",
            None,
            native[8],
            "The table, column, or index does not exist.",
        ),
        err(
            "CONFLICT",
            None,
            "optimistic check",
            "The record changed since it was read (optimistic policy).",
        ),
        err(
            "STALE_ROW",
            None,
            "0 rows matched identity",
            "The record no longer exists.",
        ),
        err(
            "VALIDATION_ERROR",
            None,
            "ixtable",
            "A value or definition was rejected before reaching the store.",
        ),
        err(
            "DATABASE_ERROR",
            None,
            "other",
            "Any other backend failure; the message carries the detail.",
        ),
    ]
}
fn types(store: &str) -> Vec<TypeCapability> {
    LOGICAL_TYPE_NAMES
        .iter()
        .map(|name| {
            let t: LogicalType = if *name == "decimal" {
                "decimal(10,2)".parse().unwrap()
            } else {
                name.parse().unwrap()
            };
            let sqlite = store == "sqlite";
            let physical = if sqlite {
                t.sqlite_declared()
            } else {
                t.postgres_type()
            };
            let enforcement = match (sqlite, t.sqlite_check("x").is_some()) {
                (true, true) => "declared type + CHECK constraint",
                (true, false) => "declared type affinity",
                (false, _) => "native type",
            };
            TypeCapability {
                logical_type: if *name == "decimal" {
                    "decimal(p,s)".into()
                } else {
                    name.to_string()
                },
                physical_type: physical.replace("10,2", "p,s"),
                enforcement: enforcement.into(),
                max_precision: (*name == "decimal").then_some(if sqlite {
                    SQLITE_MAX_DECIMAL_PRECISION
                } else {
                    crate::data::MAX_DECIMAL_PRECISION
                }),
            }
        })
        .collect()
}
fn constraints() -> Vec<String> {
    [
        "primaryKey",
        "compositePrimaryKey",
        "foreignKey",
        "unique",
        "check",
        "notNull",
        "default",
    ]
    .map(String::from)
    .to_vec()
}
fn fk_actions() -> Vec<String> {
    [
        "NO ACTION",
        "RESTRICT",
        "CASCADE",
        "SET NULL",
        "SET DEFAULT",
    ]
    .map(String::from)
    .to_vec()
}
fn policies() -> Vec<String> {
    super::POLICIES.iter().map(|s| s.to_string()).collect()
}

pub fn sqlite() -> StoreCapabilities {
    StoreCapabilities {
        store: "sqlite".into(),
        logical_types: types("sqlite"),
        ddl: vec![
            ddl("create_table", "inPlace", ""),
            ddl("drop_table", "inPlace", "Destructive; previewed with row counts and dependents."),
            ddl("rename_table", "inPlace", "References in other tables are updated."),
            ddl("rename_column", "inPlace", ""),
            ddl("add_column", "inPlace", "Rebuild when the column is unique, part of the key, required without a default, or has an expression default."),
            ddl("drop_column", "inPlace", "Rebuild when the column is keyed, indexed, constrained, or referenced."),
            ddl("alter_column", "rebuild", "Type, required, default, and check changes recreate the table."),
            ddl("set_primary_key", "rebuild", ""),
            ddl("add_foreign_key", "rebuild", ""),
            ddl("drop_foreign_key", "rebuild", ""),
            ddl("add_unique", "rebuild", "A unique index is an in-place alternative."),
            ddl("drop_unique", "rebuild", ""),
            ddl("add_check", "rebuild", ""),
            ddl("drop_check", "rebuild", ""),
            ddl("create_index", "inPlace", ""),
            ddl("drop_index", "inPlace", ""),
        ],
        constraints: constraints(),
        foreign_key_actions: fk_actions(),
        indexes: IndexCapability {
            unique: true,
            multi_column: true,
            partial: false,
            expression: false,
        },
        transactions: TransactionCapability {
            atomic_batches: true,
            transactional_ddl: true,
            savepoints: true,
            isolation: "serializable (single writer)".into(),
        },
        parameter_style: "?".into(),
        generated_values: vec![
            "rowid alias for a single INTEGER primary key".into(),
            "default expressions".into(),
            "generated columns (virtual)".into(),
        ],
        migrations: MigrationCapability {
            transactional_ddl: true,
            dry_run: "run on a copy of the database and discard it".into(),
            health_checks: vec!["PRAGMA foreign_key_check".into(), "PRAGMA integrity_check".into()],
            notes: "Each migration runs in one transaction with foreign keys enforced.".into(),
        },
        error_codes: common_errors([
            "SQLITE_CONSTRAINT_NOTNULL",
            "SQLITE_CONSTRAINT_UNIQUE",
            "SQLITE_CONSTRAINT_PRIMARYKEY",
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "SQLITE_CONSTRAINT_CHECK",
            "SQLITE_READONLY / view",
            "SQLITE_CANTOPEN",
            "SQLITE_BUSY / SQLITE_LOCKED",
            "no such table / column",
        ]),
        concurrency: ConcurrencyCapability {
            policies: policies(),
            optimistic_check: "expected original values compared in the UPDATE/DELETE WHERE clause".into(),
            row_locking: false,
            multi_user: false,
            notes: "SQLite applications are single-user in the MVP; the policy still guards stale edits.".into(),
        },
    }
}

pub fn postgres() -> StoreCapabilities {
    let all_in_place = [
        "create_table",
        "drop_table",
        "rename_table",
        "rename_column",
        "add_column",
        "drop_column",
        "alter_column",
        "set_primary_key",
        "add_foreign_key",
        "drop_foreign_key",
        "add_unique",
        "drop_unique",
        "add_check",
        "drop_check",
        "create_index",
        "drop_index",
    ];
    StoreCapabilities {
        store: "postgres".into(),
        logical_types: types("postgres"),
        ddl: all_in_place
            .iter()
            .map(|op| ddl(op, "inPlace", if *op == "alter_column" { "Type changes use USING casts and may fail on incompatible data." } else { "" }))
            .collect(),
        constraints: constraints(),
        foreign_key_actions: fk_actions(),
        indexes: IndexCapability {
            unique: true,
            multi_column: true,
            partial: true,
            expression: true,
        },
        transactions: TransactionCapability {
            atomic_batches: true,
            transactional_ddl: true,
            savepoints: true,
            isolation: "read committed".into(),
        },
        parameter_style: "$1".into(),
        generated_values: vec![
            "identity column for a single integer primary key".into(),
            "default expressions".into(),
            "generated columns (stored)".into(),
        ],
        migrations: MigrationCapability {
            transactional_ddl: true,
            dry_run: "BEGIN … ROLLBACK on the live database".into(),
            health_checks: vec!["constraint validation (NOT VALID constraints)".into()],
            notes: "Statements that cannot run in a transaction (CREATE INDEX CONCURRENTLY, VACUUM) are rejected.".into(),
        },
        error_codes: common_errors([
            "23502 not_null_violation",
            "23505 unique_violation",
            "23505 on the primary key",
            "23503 foreign_key_violation",
            "23514 check_violation",
            "25006 read_only_sql_transaction / 42501",
            "08xxx connection_exception",
            "40001 serialization_failure / 40P01 / 55P03",
            "42P01 undefined_table / 42703",
        ]),
        concurrency: ConcurrencyCapability {
            policies: policies(),
            optimistic_check: "expected original values compared in the UPDATE/DELETE WHERE clause".into(),
            row_locking: true,
            multi_user: true,
            notes: "Concurrency follows the per-entity policy and PostgreSQL row locking.".into(),
        },
    }
}
