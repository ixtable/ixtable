//! Writes parsed rows into a new or existing table through the RecordStore.
//! Each value is checked against its field's logical type first; rows that
//! fail are reported and skipped. Valid rows go in batches of `BATCH` (one
//! transaction each); a batch the store rejects is retried row by row so only
//! the rows that break a constraint are reported.
use super::parse::{ParseOptions, ParsedFile};
use crate::data::{ColumnDef, CreateColumn, CreateTable, DataValue, LogicalType, NamedValue};
use crate::manager::SessionState;
use crate::recordstore::{RecordStore, StoreError, WriteOp};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const BATCH: usize = 500;
/// Row errors kept in a report; `failed` still counts every one.
pub const MAX_REPORTED_ERRORS: usize = 500;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewColumn {
    /// Source column name.
    pub source: String,
    pub name: String,
    pub logical_type: LogicalType,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldMapping {
    pub source: String,
    pub field: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportTarget {
    /// Creates `table`. `primary_key` names one of `columns`; without it an `id` integer key is added.
    NewTable {
        table: String,
        columns: Vec<NewColumn>,
        #[serde(default)]
        primary_key: Option<String>,
    },
    ExistingTable {
        table: String,
        mapping: Vec<FieldMapping>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub path: String,
    #[serde(default)]
    pub options: ParseOptions,
    pub target: ImportTarget,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowError {
    /// 1-based data row (the header row is not counted).
    pub row: u64,
    pub column: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub table: String,
    pub total_rows: u64,
    pub imported: u64,
    pub failed: u64,
    pub errors: Vec<RowError>,
    pub state: Option<SessionState>,
}

/// The `CreateTable` for a new-table import.
pub fn new_table_spec(
    table: &str,
    columns: &[NewColumn],
    primary_key: Option<&str>,
) -> Result<CreateTable, String> {
    if columns.is_empty() {
        return Err("Choose at least one column to import".into());
    }
    let mut out = vec![];
    if primary_key.is_none() {
        if columns.iter().any(|c| c.name.eq_ignore_ascii_case("id")) {
            return Err("A column is named id: make it the primary key or rename it".into());
        }
        out.push(CreateColumn {
            name: "id".into(),
            logical_type: Some(LogicalType::Integer),
            nullable: false,
            primary_key_position: 1,
            ..Default::default()
        });
    } else if !columns.iter().any(|c| Some(c.name.as_str()) == primary_key) {
        return Err("The primary key must be one of the imported columns".into());
    }
    out.extend(columns.iter().map(|c| {
        let key = Some(c.name.as_str()) == primary_key;
        CreateColumn {
            name: c.name.clone(),
            logical_type: Some(c.logical_type.clone()),
            nullable: !key,
            primary_key_position: key as u32,
            ..Default::default()
        }
    }));
    Ok(CreateTable {
        name: table.into(),
        columns: out,
        ..Default::default()
    })
}

/// Pairs source column indexes with target fields, refusing unknown names,
/// generated fields, duplicate targets, and unmapped required fields.
pub fn plan_fields(
    parsed: &ParsedFile,
    mapping: &[FieldMapping],
    fields: &[ColumnDef],
) -> Result<Vec<(usize, ColumnDef)>, String> {
    let sources: HashMap<&str, usize> = parsed
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| (c.name.as_str(), i))
        .collect();
    let mut seen = HashSet::new();
    let mut out = vec![];
    for m in mapping {
        let index = *sources
            .get(m.source.as_str())
            .ok_or_else(|| format!("The file has no column {:?}", m.source))?;
        let field = fields
            .iter()
            .find(|f| f.name == m.field)
            .ok_or_else(|| format!("The table has no field {:?}", m.field))?;
        if field.generated_expression.is_some() {
            return Err(format!("{} is computed and cannot be imported", field.name));
        }
        if !seen.insert(field.name.clone()) {
            return Err(format!("{} is mapped more than once", field.name));
        }
        out.push((index, field.clone()));
    }
    if out.is_empty() {
        return Err("Map at least one column to a field".into());
    }
    let missing: Vec<&str> = fields
        .iter()
        .filter(|f| required(f) && !seen.contains(&f.name))
        .map(|f| f.name.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Required fields are not mapped: {}",
            missing.join(", ")
        ));
    }
    Ok(out)
}

/// The target table's fields; SQLite's `INTEGER PRIMARY KEY` counts as database-filled.
pub fn table_fields(
    store: &mut dyn RecordStore,
    table: &str,
) -> Result<Vec<ColumnDef>, StoreError> {
    let mut def = store.table_def(table)?;
    if store.kind() == "sqlite" {
        crate::data::read::mark_rowid_alias(&mut def);
    }
    Ok(def.columns)
}

/// A field every row must fill in: not null, no default, not database-filled.
fn required(f: &ColumnDef) -> bool {
    !f.nullable && f.default_expression.is_none() && !f.identity && f.generated_expression.is_none()
}

/// Converts each row to its fields' logical types. Returns the rows to write
/// (with their 1-based row numbers) and the rows that failed. Nulls are left
/// out so field defaults apply.
pub fn convert_rows(
    parsed: &ParsedFile,
    fields: &[(usize, ColumnDef)],
) -> (Vec<(u64, Vec<NamedValue>)>, Vec<RowError>) {
    let mut good = vec![];
    let mut bad = vec![];
    'rows: for (i, row) in parsed.rows.iter().enumerate() {
        let number = i as u64 + 1;
        let mut values = vec![];
        for (index, field) in fields {
            let raw = row.get(*index).unwrap_or(&DataValue::Null);
            let error = |message: String| RowError {
                row: number,
                column: Some(field.name.clone()),
                message,
            };
            match field.logical_type.normalize(&field.name, raw) {
                Ok(DataValue::Null) if required(field) => {
                    bad.push(error(format!("{} is required", field.name)));
                    continue 'rows;
                }
                Ok(DataValue::Null) => {}
                Ok(value) => values.push(NamedValue {
                    column: field.name.clone(),
                    value,
                }),
                Err(message) => {
                    bad.push(error(message));
                    continue 'rows;
                }
            }
        }
        good.push((number, values));
    }
    (good, bad)
}

/// A store error that belongs to one row (a broken constraint or a bad value)
/// rather than to the whole import (connection lost, database busy).
fn row_level(e: &StoreError) -> bool {
    matches!(
        e.code,
        "CONSTRAINT_VIOLATION" | "VALIDATION_ERROR" | "DATABASE_ERROR"
    )
}

/// Inserts `rows` into `table`; returns how many were written and the rows the store refused.
pub fn insert_rows(
    store: &mut dyn RecordStore,
    table: &str,
    rows: &[(u64, Vec<NamedValue>)],
) -> Result<(u64, Vec<RowError>), StoreError> {
    let mut imported = 0;
    let mut errors = vec![];
    for chunk in rows.chunks(BATCH) {
        let ops: Vec<WriteOp> = chunk
            .iter()
            .map(|(_, values)| WriteOp::Insert {
                table: table.into(),
                values: values.clone(),
            })
            .collect();
        match store.execute_batch(&ops) {
            Ok(_) => imported += chunk.len() as u64,
            Err(e) if !row_level(&e) => return Err(e),
            Err(_) => {
                for (number, values) in chunk {
                    match store.insert(table, values) {
                        Ok(_) => imported += 1,
                        Err(e) if !row_level(&e) => return Err(e),
                        Err(e) => errors.push(RowError {
                            row: *number,
                            column: None,
                            message: e.message,
                        }),
                    }
                }
            }
        }
    }
    Ok((imported, errors))
}
