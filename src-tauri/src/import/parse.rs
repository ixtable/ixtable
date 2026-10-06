//! Reads an external file: CSV, JSON, and Parquet through a DuckDB sandbox
//! that may read only that file, XLSX through calamine. A preview reads the
//! first rows with suggested types; an import streams every row
//! (`for_each_row`) and never holds the whole file in memory.
use crate::data::files::{sandbox, scan_sql, scan_text_sql, CsvOptions, FileFormat};
use crate::data::{duck_value, logical_from_duckdb, DataValue, LogicalType};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParseOptions {
    /// Detected from the extension when absent.
    #[serde(default)]
    pub format: Option<FileFormat>,
    /// The first CSV or XLSX row holds column names.
    #[serde(default = "yes")]
    pub header: bool,
    /// CSV delimiter; detected when absent.
    #[serde(default)]
    pub delimiter: Option<String>,
    /// XLSX worksheet; the first one when absent.
    #[serde(default)]
    pub sheet: Option<String>,
}
impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            format: None,
            header: true,
            delimiter: None,
            sheet: None,
        }
    }
}
fn yes() -> bool {
    true
}
impl ParseOptions {
    pub fn csv(&self) -> CsvOptions {
        CsvOptions {
            header: self.header,
            delimiter: self.delimiter.clone().filter(|d| !d.is_empty()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceColumn {
    pub name: String,
    pub logical_type: LogicalType,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFile {
    pub format: FileFormat,
    pub columns: Vec<SourceColumn>,
    pub rows: Vec<Vec<DataValue>>,
    pub total_rows: u64,
    /// XLSX worksheet names; empty for other formats.
    pub sheets: Vec<String>,
}

/// Largest file an import or preview reads.
pub const MAX_FILE_BYTES: u64 = 1 << 30;
/// Largest XLSX workbook: its shared strings are held in memory.
pub const MAX_XLSX_BYTES: u64 = 100 << 20;

pub fn resolve_format(path: &Path, options: &ParseOptions) -> Result<FileFormat, String> {
    options
        .format
        .or_else(|| FileFormat::from_path(path))
        .ok_or_else(|| {
            "Unsupported file type: choose a CSV, XLSX, JSON, or Parquet file".to_string()
        })
}

/// Checks that `path` is a readable file within the size cap of its format.
pub fn check_file(path: &Path, format: FileFormat) -> Result<(), String> {
    let max = match format {
        FileFormat::Xlsx => MAX_XLSX_BYTES,
        _ => MAX_FILE_BYTES,
    };
    check_size(path, max)
}

pub fn check_size(path: &Path, max: u64) -> Result<(), String> {
    let meta = std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .ok_or_else(|| format!("{} is not a readable file", path.display()))?;
    if meta.len() > max {
        return Err(format!(
            "The file is {} MB; files over {} MB cannot be imported",
            meta.len().div_ceil(1 << 20),
            max >> 20
        ));
    }
    Ok(())
}

/// Previews `path`: columns with suggested logical types, the first `limit`
/// rows, and the row count.
pub fn parse(path: &Path, options: &ParseOptions, limit: usize) -> Result<ParsedFile, String> {
    let format = resolve_format(path, options)?;
    check_file(path, format)?;
    match format {
        FileFormat::Xlsx => super::xlsx::preview(path, options, limit),
        format => preview_duckdb(path, format, &options.csv(), limit),
    }
}

/// Where a file's columns are, read before its rows.
#[derive(Debug, Clone)]
pub struct Layout {
    pub format: FileFormat,
    pub names: Vec<String>,
    pub(super) sheet: Option<super::xlsx::SheetLayout>,
}

/// The column names of `path`, without reading its rows (XLSX reads the sheet once).
pub fn layout(path: &Path, options: &ParseOptions) -> Result<Layout, String> {
    let format = resolve_format(path, options)?;
    check_file(path, format)?;
    if format == FileFormat::Xlsx {
        let sheet = super::xlsx::layout(path, options)?;
        return Ok(Layout {
            format,
            names: sheet.names.clone(),
            sheet: Some(sheet),
        });
    }
    let connection = sandbox(path)?;
    let scan = scan_text_sql(path, format, &options.csv())?;
    let names = describe(&connection, &scan)?
        .into_iter()
        .map(|c| c.name)
        .collect();
    Ok(Layout {
        format,
        names,
        sheet: None,
    })
}

/// Streams every row of `path` to `row` without holding the file in memory
/// and returns the row count. CSV values arrive as text; `row` returning an
/// error stops the read with that error.
pub fn for_each_row(
    path: &Path,
    options: &ParseOptions,
    layout: &Layout,
    mut row: impl FnMut(Vec<DataValue>) -> Result<(), String>,
) -> Result<u64, String> {
    if let Some(sheet) = &layout.sheet {
        return super::xlsx::for_each_row(path, sheet, row);
    }
    let connection = sandbox(path)?;
    let scan = scan_text_sql(path, layout.format, &options.csv())?;
    let mut stmt = connection
        .prepare(&format!("SELECT * FROM {scan}"))
        .map_err(read_error)?;
    let mut cursor = stmt.query([]).map_err(read_error)?;
    let width = layout.names.len();
    let mut count = 0;
    while let Some(r) = cursor.next().map_err(read_error)? {
        let values = (0..width)
            .map(|i| r.get::<_, duckdb::types::Value>(i).map(duck_value))
            .collect::<Result<Vec<_>, _>>()
            .map_err(read_error)?;
        count += 1;
        row(values)?;
    }
    Ok(count)
}

fn read_error(e: duckdb::Error) -> String {
    format!("Could not read the file: {e}")
}

fn describe(connection: &duckdb::Connection, scan: &str) -> Result<Vec<SourceColumn>, String> {
    let mut stmt = connection
        .prepare(&format!("DESCRIBE SELECT * FROM {scan}"))
        .map_err(read_error)?;
    let columns = stmt
        .query_map([], |r| {
            Ok(SourceColumn {
                name: r.get(0)?,
                logical_type: logical_from_duckdb(&r.get::<_, String>(1)?),
            })
        })
        .map_err(read_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_error)?;
    Ok(columns)
}

fn preview_duckdb(
    path: &Path,
    format: FileFormat,
    csv: &CsvOptions,
    limit: usize,
) -> Result<ParsedFile, String> {
    let connection = sandbox(path)?;
    let scan = scan_sql(path, format, csv)?;
    let columns = describe(&connection, &scan)?;
    let total_rows: u64 = connection
        .query_row(&format!("SELECT count(*) FROM {scan}"), [], |r| r.get(0))
        .map_err(read_error)?;
    let mut stmt = connection
        .prepare(&format!("SELECT * FROM {scan} LIMIT {limit}"))
        .map_err(read_error)?;
    let mut cursor = stmt.query([]).map_err(read_error)?;
    let mut rows = vec![];
    while let Some(row) = cursor.next().map_err(read_error)? {
        let values = (0..columns.len())
            .map(|i| row.get::<_, duckdb::types::Value>(i).map(duck_value))
            .collect::<Result<Vec<_>, _>>()
            .map_err(read_error)?;
        rows.push(values);
    }
    Ok(ParsedFile {
        format,
        columns,
        rows,
        total_rows,
        sheets: vec![],
    })
}

/// Unique, non-empty column names (`column_3`, `name_2`).
pub fn unique_names(raw: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .enumerate()
        .map(|(i, name)| {
            let base = match name.trim() {
                "" => format!("column_{}", i + 1),
                t => t.to_string(),
            };
            let mut candidate = base.clone();
            let mut n = 2;
            while !seen.insert(candidate.to_lowercase()) {
                candidate = format!("{base}_{n}");
                n += 1;
            }
            candidate
        })
        .collect()
}
