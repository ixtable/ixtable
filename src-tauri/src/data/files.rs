//! External files on the read path (PRD §10): the import sandbox and the
//! bundled read-only file sources.
//!
//! DuckDB parses CSV, JSON, and Parquet with its built-in readers (`json` and
//! `parquet` are compiled into the bundled DuckDB, not loaded). External access
//! stays off: a sandbox or reader may open only the files named in its
//! `allowed_paths`, set before `enable_external_access=false` and
//! `lock_configuration=true`.
use super::q;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Csv,
    Xlsx,
    Json,
    Parquet,
}

impl FileFormat {
    /// The format named by a file's extension.
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
        Some(match ext.as_str() {
            "csv" | "tsv" | "txt" => Self::Csv,
            "xlsx" | "xlsm" => Self::Xlsx,
            "json" | "jsonl" | "ndjson" => Self::Json,
            "parquet" => Self::Parquet,
            _ => return None,
        })
    }
}

/// CSV parsing options. Without a delimiter DuckDB detects it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
    #[serde(default = "yes")]
    pub header: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delimiter: Option<String>,
}
impl Default for CsvOptions {
    fn default() -> Self {
        Self {
            header: true,
            delimiter: None,
        }
    }
}
fn yes() -> bool {
    true
}

/// A bundled file the reader exposes as the view `files.<name>`.
#[derive(Debug, Clone, PartialEq)]
pub struct FileView {
    pub name: String,
    pub path: PathBuf,
    pub format: FileFormat,
    pub csv: CsvOptions,
}

/// A path quoted for a SQL string literal.
pub fn literal(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

/// The DuckDB table function that reads `path` as `format`.
pub fn scan_sql(path: &Path, format: FileFormat, csv: &CsvOptions) -> Result<String, String> {
    let p = literal(path);
    Ok(match format {
        FileFormat::Csv => {
            let mut args = format!("'{p}', header={}", csv.header);
            if let Some(d) = csv.delimiter.as_deref().filter(|d| !d.is_empty()) {
                let mut chars = d.chars();
                let (Some(c), None) = (chars.next(), chars.next()) else {
                    return Err("The delimiter must be one character".into());
                };
                if matches!(c, '\'' | '"' | '\n' | '\r') {
                    return Err(format!("{c:?} cannot be a delimiter"));
                }
                args.push_str(&format!(", delim='{c}'"));
            }
            format!("read_csv({args})")
        }
        FileFormat::Json => format!("read_json('{p}')"),
        FileFormat::Parquet => format!("read_parquet('{p}')"),
        FileFormat::Xlsx => return Err("XLSX files are read without DuckDB".into()),
    })
}

/// Turns external access off, allowing only `paths`, and locks the configuration.
pub(super) fn lock_down(connection: &duckdb::Connection, paths: &[&Path]) -> Result<(), String> {
    let list = paths
        .iter()
        .map(|p| format!("'{}'", literal(p)))
        .collect::<Vec<_>>()
        .join(", ");
    connection
        .execute_batch(&format!(
            "SET allowed_paths=[{list}]; SET enable_external_access=false; SET lock_configuration=true"
        ))
        .map_err(|e| format!("DuckDB lockdown: {e}"))
}

/// An in-memory DuckDB database that can read `path` and nothing else.
pub fn sandbox(path: &Path) -> Result<duckdb::Connection, String> {
    let config = duckdb::Config::default()
        .enable_autoload_extension(false)
        .map_err(|e| e.to_string())?;
    let connection = duckdb::Connection::open_in_memory_with_flags(config)
        .map_err(|e| format!("DuckDB startup: {e}"))?;
    lock_down(&connection, &[path])?;
    Ok(connection)
}

/// Attaches the in-memory `files` catalog and creates one view per file.
/// Views are bound now, while external access is still on; a view that fails
/// is skipped and its error returned.
pub(super) fn create_views(connection: &duckdb::Connection, views: &[FileView]) -> Vec<String> {
    if let Err(e) = connection.execute_batch("ATTACH ':memory:' AS files") {
        return vec![format!("files catalog: {e}")];
    }
    let mut errors = vec![];
    for view in views {
        let created = scan_sql(&view.path, view.format, &view.csv).and_then(|scan| {
            connection
                .execute_batch(&format!(
                    "CREATE VIEW files.main.{} AS SELECT * FROM {scan}",
                    q(&view.name)
                ))
                .map_err(|e| e.to_string())
        });
        if let Err(e) = created {
            errors.push(format!("{}: {e}", view.name));
        }
    }
    errors
}
