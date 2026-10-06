//! Parses an external file into typed rows: CSV, JSON, and Parquet through a
//! DuckDB sandbox that may read only that file, XLSX through calamine.
use crate::data::files::{sandbox, scan_sql, CsvOptions, FileFormat};
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

pub fn resolve_format(path: &Path, options: &ParseOptions) -> Result<FileFormat, String> {
    options
        .format
        .or_else(|| FileFormat::from_path(path))
        .ok_or_else(|| {
            "Unsupported file type: choose a CSV, XLSX, JSON, or Parquet file".to_string()
        })
}

/// Reads `path`. `limit` caps the rows returned (`total_rows` still counts all).
pub fn parse(
    path: &Path,
    options: &ParseOptions,
    limit: Option<usize>,
) -> Result<ParsedFile, String> {
    if !path.is_file() {
        return Err(format!("{} is not a readable file", path.display()));
    }
    match resolve_format(path, options)? {
        FileFormat::Xlsx => super::xlsx::parse(path, options, limit),
        format => parse_duckdb(path, format, &options.csv(), limit),
    }
}

fn parse_duckdb(
    path: &Path,
    format: FileFormat,
    csv: &CsvOptions,
    limit: Option<usize>,
) -> Result<ParsedFile, String> {
    let connection = sandbox(path)?;
    let scan = scan_sql(path, format, csv)?;
    let error = |e: duckdb::Error| format!("Could not read the file: {e}");
    let mut describe = connection
        .prepare(&format!("DESCRIBE SELECT * FROM {scan}"))
        .map_err(error)?;
    let columns = describe
        .query_map([], |r| {
            Ok(SourceColumn {
                name: r.get(0)?,
                logical_type: logical_from_duckdb(&r.get::<_, String>(1)?),
            })
        })
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    let total_rows: u64 = connection
        .query_row(&format!("SELECT count(*) FROM {scan}"), [], |r| r.get(0))
        .map_err(error)?;
    let sql = match limit {
        Some(n) => format!("SELECT * FROM {scan} LIMIT {n}"),
        None => format!("SELECT * FROM {scan}"),
    };
    let mut stmt = connection.prepare(&sql).map_err(error)?;
    let mut cursor = stmt.query([]).map_err(error)?;
    let mut rows = vec![];
    while let Some(row) = cursor.next().map_err(error)? {
        let values = (0..columns.len())
            .map(|i| row.get::<_, duckdb::types::Value>(i).map(duck_value))
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
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
