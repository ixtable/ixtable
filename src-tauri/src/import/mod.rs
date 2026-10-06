//! External files (PRD §3.2, §10): the import wizard and bundled file sources.
//!
//! Imports parse a CSV, XLSX, JSON, or Parquet file (`parse`, `xlsx`) and
//! write its rows through the RecordStore (`write`), never through DuckDB.
//! File sources (`sources`) are assets the reader exposes as read-only views.
//! Record triggers do not run for imported rows.
pub mod parse;
pub mod sources;
#[cfg(test)]
mod tests;
pub mod write;
pub mod xlsx;

pub use sources::{validate, FileSource};

use crate::manager::{read_only_guard, AppError};
use crate::recordstore::{commands::after_write, with_store};
use parse::SourceColumn;
use serde::Serialize;
use std::path::PathBuf;
use write::{ImportReport, ImportRequest, ImportTarget, MAX_REPORTED_ERRORS};

/// Rows a preview returns.
pub const PREVIEW_ROWS: usize = 50;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::new("IMPORT_FAILED", e))?
}

fn guard(window: &str) -> Result<(), AppError> {
    crate::manager()?.with_session(window, |s| {
        read_only_guard(s)?;
        crate::authz::unrestricted_session(s, "import files")
    })
}

fn failed(e: String) -> AppError {
    AppError::new("IMPORT_FAILED", e)
}

/// Columns with inferred logical types and the first rows of a file.
#[tauri::command]
pub async fn preview_import_file(
    window_label: String,
    path: String,
    options: Option<crate::import::parse::ParseOptions>,
) -> Result<crate::import::parse::ParsedFile, AppError> {
    blocking(move || {
        guard(&window_label)?;
        parse::parse(
            &PathBuf::from(path),
            &options.unwrap_or_default(),
            Some(PREVIEW_ROWS),
        )
        .map_err(failed)
    })
    .await
}

/// Imports every row of a file into a new or existing table.
#[tauri::command]
pub async fn import_file(
    window_label: String,
    request: crate::import::write::ImportRequest,
) -> Result<crate::import::write::ImportReport, AppError> {
    blocking(move || import_now(&window_label, request)).await
}

pub fn import_now(window: &str, request: ImportRequest) -> Result<ImportReport, AppError> {
    guard(window)?;
    let parsed =
        parse::parse(&PathBuf::from(&request.path), &request.options, None).map_err(failed)?;
    let (table, mapping) = match request.target {
        ImportTarget::NewTable {
            table,
            columns,
            primary_key,
        } => {
            let spec =
                write::new_table_spec(&table, &columns, primary_key.as_deref()).map_err(failed)?;
            let mapping = columns
                .iter()
                .map(|c| write::FieldMapping {
                    source: c.source.clone(),
                    field: c.name.clone(),
                })
                .collect::<Vec<_>>();
            // Check the mapping before creating anything.
            for m in &mapping {
                if !parsed.columns.iter().any(|c| c.name == m.source) {
                    return Err(failed(format!("The file has no column {:?}", m.source)));
                }
            }
            crate::recordstore::commands::create_table(window, &spec)?;
            (table, mapping)
        }
        ImportTarget::ExistingTable { table, mapping } => (table, mapping),
    };
    let columns = {
        let table = table.clone();
        with_store(window, move |s| write::table_fields(s, &table))?
    };
    let fields = write::plan_fields(&parsed, &mapping, &columns).map_err(failed)?;
    let (rows, mut errors) = write::convert_rows(&parsed, &fields);
    let written = {
        let table = table.clone();
        with_store(window, move |s| write::insert_rows(s, &table, &rows))
    };
    let state = after_write(window).ok();
    let (imported, refused) = written?;
    errors.extend(refused);
    errors.sort_by_key(|e| e.row);
    let failed = errors.len() as u64;
    errors.truncate(MAX_REPORTED_ERRORS);
    crate::logging::info(
        "import",
        &format!(
            "imported {imported} of {} rows into {table}",
            parsed.total_rows
        ),
    );
    Ok(ImportReport {
        table,
        total_rows: parsed.total_rows,
        imported,
        failed,
        errors,
        state,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSourceInfo {
    pub id: String,
    pub name: String,
    pub columns: Vec<SourceColumn>,
    pub row_count: Option<u64>,
    pub error: Option<String>,
}

/// Columns and row counts of the document's file sources, read through the session reader.
#[tauri::command]
pub async fn file_source_info(
    window_label: String,
) -> Result<Vec<crate::import::FileSourceInfo>, AppError> {
    blocking(move || {
        let m = crate::manager()?;
        let (sources, errors) = m.with_session(&window_label, |s| {
            Ok((
                s.doc.config.file_sources.clone(),
                s.reader.file_errors().to_vec(),
            ))
        })?;
        let connection = m.read_connection(&window_label)?;
        Ok(sources
            .into_iter()
            .map(|s| {
                let prefix = format!("{}: ", s.name);
                let error = errors
                    .iter()
                    .find_map(|e| e.strip_prefix(&prefix).map(str::to_string));
                let described = match error {
                    Some(e) => Err(e),
                    None => describe(&connection, &s.name),
                };
                let (columns, row_count, error) = match described {
                    Ok((columns, count)) => (columns, Some(count), None),
                    Err(e) => (vec![], None, Some(e)),
                };
                FileSourceInfo {
                    id: s.id,
                    name: s.name,
                    columns,
                    row_count,
                    error,
                }
            })
            .collect())
    })
    .await
}

fn describe(
    connection: &duckdb::Connection,
    name: &str,
) -> Result<(Vec<SourceColumn>, u64), String> {
    let view = format!("files.main.{}", crate::data::q(name));
    let mut stmt = connection
        .prepare(&format!("DESCRIBE {view}"))
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |r| {
            Ok(SourceColumn {
                name: r.get(0)?,
                logical_type: crate::data::logical_from_duckdb(&r.get::<_, String>(1)?),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let count = connection
        .query_row(&format!("SELECT count(*) FROM {view}"), [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok((columns, count))
}
