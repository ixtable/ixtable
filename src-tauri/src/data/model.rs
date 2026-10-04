//! Store-neutral table definition model shared by the reader, both stores, and the designer.
use super::logical::LogicalType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub declared_type: String,
    pub logical_type: LogicalType,
    pub nullable: bool,
    #[serde(default)]
    pub default_expression: Option<String>,
    #[serde(default)]
    pub generated_expression: Option<String>,
    /// True for a PostgreSQL identity column (`GENERATED ... AS IDENTITY`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub identity: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UniqueDef {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckDef {
    #[serde(default)]
    pub name: Option<String>,
    pub expression: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub target_table: String,
    pub target_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub unique: bool,
    /// Original DDL (SQLite) or `pg_get_indexdef` (PostgreSQL).
    #[serde(default)]
    pub sql: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableDef {
    pub name: String,
    pub columns: Vec<ColumnDef>,
    #[serde(default)]
    pub primary_key: Vec<String>,
    #[serde(default)]
    pub primary_key_name: Option<String>,
    #[serde(default)]
    pub autoincrement: bool,
    #[serde(default)]
    pub uniques: Vec<UniqueDef>,
    #[serde(default)]
    pub checks: Vec<CheckDef>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDef>,
    #[serde(default)]
    pub indexes: Vec<IndexDef>,
    #[serde(default)]
    pub without_rowid: bool,
}
impl TableDef {
    pub fn column(&self, name: &str) -> Option<&ColumnDef> {
        self.columns
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case(name))
    }
    pub fn is_unique_column(&self, name: &str) -> bool {
        self.uniques
            .iter()
            .any(|u| u.columns.len() == 1 && u.columns[0].eq_ignore_ascii_case(name))
    }
}
