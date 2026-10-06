//! Writes file rows into a new or existing table through the RecordStore.
//! Rows stream from the file; each value is checked against its field's
//! logical type first, and rows that fail are reported and skipped. Valid
//! rows go in batches of `BATCH` (one transaction each); a batch the store
//! rejects with a constraint or validation error is retried row by row so only
//! the rows at fault are reported. Any other store error stops the import.
use super::parse::{Layout, ParseOptions};
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
    /// Why the import stopped early; rows written before it stay.
    pub aborted: Option<String>,
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
    columns: &[String],
    mapping: &[FieldMapping],
    fields: &[ColumnDef],
) -> Result<Vec<(usize, ColumnDef)>, String> {
    let sources: HashMap<&str, usize> = columns
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), i))
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

/// Converts one file row (`number` is 1-based) to its fields' logical types.
/// Nulls are left out so field defaults apply.
pub fn convert_row(
    number: u64,
    row: &[DataValue],
    fields: &[(usize, ColumnDef)],
) -> Result<Vec<NamedValue>, RowError> {
    let mut values = Vec::with_capacity(fields.len());
    for (index, field) in fields {
        let raw = row.get(*index).unwrap_or(&DataValue::Null);
        let error = |message: String| RowError {
            row: number,
            column: Some(field.name.clone()),
            message,
        };
        match field.logical_type.normalize(&field.name, raw) {
            Ok(DataValue::Null) if required(field) => {
                return Err(error(format!("{} is required", field.name)))
            }
            Ok(DataValue::Null) => {}
            Ok(value) => values.push(NamedValue {
                column: field.name.clone(),
                value,
            }),
            Err(message) => return Err(error(message)),
        }
    }
    Ok(values)
}

/// A store error that belongs to one row (a broken constraint or a bad
/// value) rather than to the whole import (connection lost, database busy,
/// disk full).
fn row_level(e: &StoreError) -> bool {
    matches!(e.code, "CONSTRAINT_VIOLATION" | "VALIDATION_ERROR")
}

/// Converts and writes rows one batch at a time, so memory holds at most one
/// batch whatever the file size.
pub struct Writer<'a> {
    store: &'a mut dyn RecordStore,
    table: &'a str,
    fields: &'a [(usize, ColumnDef)],
    batch: Vec<(u64, Vec<NamedValue>)>,
    pub rows: u64,
    pub imported: u64,
    pub failed: u64,
    errors: Vec<RowError>,
}

impl<'a> Writer<'a> {
    pub fn new(
        store: &'a mut dyn RecordStore,
        table: &'a str,
        fields: &'a [(usize, ColumnDef)],
    ) -> Self {
        Self {
            store,
            table,
            fields,
            batch: Vec::with_capacity(BATCH),
            rows: 0,
            imported: 0,
            failed: 0,
            errors: vec![],
        }
    }

    /// Converts and queues the next file row; a full batch is written.
    pub fn push(&mut self, row: Vec<DataValue>) -> Result<(), StoreError> {
        self.rows += 1;
        match convert_row(self.rows, &row, self.fields) {
            Ok(values) => self.batch.push((self.rows, values)),
            Err(e) => self.reject(e),
        }
        if self.batch.len() >= BATCH {
            self.flush()?;
        }
        Ok(())
    }

    /// Writes the queued rows in one transaction, or row by row when the store refuses one.
    pub fn flush(&mut self) -> Result<(), StoreError> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let (numbers, ops): (Vec<u64>, Vec<WriteOp>) = std::mem::take(&mut self.batch)
            .into_iter()
            .map(|(number, values)| {
                let table = self.table.to_string();
                (number, WriteOp::Insert { table, values })
            })
            .unzip();
        match self.store.execute_batch(&ops) {
            Ok(_) => self.imported += ops.len() as u64,
            Err(e) if !row_level(&e) => return Err(e),
            Err(_) => {
                for (row, op) in numbers.into_iter().zip(ops) {
                    let WriteOp::Insert { values, .. } = op else {
                        continue;
                    };
                    match self.store.insert(self.table, &values) {
                        Ok(_) => self.imported += 1,
                        Err(e) if !row_level(&e) => return Err(e),
                        Err(e) => self.reject(RowError {
                            row,
                            column: None,
                            message: e.message,
                        }),
                    }
                }
            }
        }
        Ok(())
    }

    /// Counts a skipped row, keeping only the first `MAX_REPORTED_ERRORS` by row.
    fn reject(&mut self, e: RowError) {
        self.failed += 1;
        self.errors.push(e);
        if self.errors.len() >= 2 * MAX_REPORTED_ERRORS {
            self.trim();
        }
    }

    fn trim(&mut self) {
        self.errors.sort_by_key(|e| e.row);
        self.errors.truncate(MAX_REPORTED_ERRORS);
    }

    /// The reported errors, sorted by row.
    pub fn take_errors(&mut self) -> Vec<RowError> {
        self.trim();
        std::mem::take(&mut self.errors)
    }
}

/// What an import wrote; `aborted` is set when it stopped early.
#[derive(Debug, Default)]
pub struct Outcome {
    pub rows: u64,
    pub imported: u64,
    pub failed: u64,
    pub errors: Vec<RowError>,
    pub aborted: Option<String>,
}

/// Streams the file at `path` into `table`, then moves the table's key
/// sequence past the imported keys. Never fails: an error that stops the
/// import is returned in `aborted`, and the batches committed before it stay.
pub fn write_file(
    store: &mut dyn RecordStore,
    table: &str,
    fields: &[(usize, ColumnDef)],
    path: &std::path::Path,
    options: &ParseOptions,
    layout: &Layout,
) -> Outcome {
    let mut writer = Writer::new(store, table, fields);
    let read = super::parse::for_each_row(path, options, layout, |row| {
        writer.push(row).map_err(|e| e.message)
    });
    let mut aborted = read
        .and_then(|_| writer.flush().map_err(|e| e.message))
        .err();
    let errors = writer.take_errors();
    let (rows, imported, failed) = (writer.rows, writer.imported, writer.failed);
    if imported > 0 {
        if let Err(e) = store.sync_identity(table) {
            aborted.get_or_insert(format!(
                "The rows were imported, but the key sequence could not be advanced: {}",
                e.message
            ));
        }
    }
    Outcome {
        rows,
        imported,
        failed,
        errors,
        aborted,
    }
}
