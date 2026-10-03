//! Migration and health checks run on installation data before a definition activates
//! (PRD §22.3 steps 7–8, §24).
use crate::archive::DocumentConfig;
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

/// Applies the definition's pending SQLite migrations to `db` via
/// `migrations::apply_sqlite` (one transaction per migration, tracked in `_ixtable_migrations`).
pub fn apply_migrations(db: &Path, config: &DocumentConfig) -> Result<(), String> {
    if config.migrations.is_empty() {
        return Ok(());
    }
    crate::migrations::apply_sqlite(db, &config.migrations).map(|_| ())
}

fn table_columns(conn: &Connection) -> Result<HashMap<String, HashSet<String>>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for name in names {
        let mut info = conn
            .prepare("SELECT name FROM pragma_table_info(?1)")
            .map_err(|e| e.to_string())?;
        let cols: HashSet<String> = info
            .query_map([&name], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|c| c.to_lowercase())
            .collect();
        out.insert(name.to_lowercase(), cols);
    }
    Ok(out)
}

/// Integrity, foreign keys, and every table/column referenced by forms must exist.
pub fn health_check(db: &Path, config: &DocumentConfig) -> Result<(), String> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Cannot open installation data: {e}"))?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err(format!("Integrity check failed: {integrity}"));
    }
    let violations: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    if violations > 0 {
        return Err(format!(
            "{violations} foreign key violation(s) in installation data"
        ));
    }
    let tables = table_columns(&conn)?;
    let design = serde_json::to_value(&config.design).map_err(|e| e.to_string())?;
    let mut missing = vec![];
    for form in design["forms"].as_array().into_iter().flatten() {
        let form_name = form["name"].as_str().unwrap_or("form");
        // v3 forms read from `source` (table or query); v2 forms had a `table` field.
        let source = &form["source"];
        let form_table = if source.is_object() {
            match source["kind"].as_str() {
                None | Some("table") => source["table"].as_str(),
                _ => None,
            }
        } else {
            form["table"].as_str()
        }
        .filter(|t| !t.is_empty());
        if let Some(table) = form_table {
            if !tables.contains_key(&table.to_lowercase()) {
                missing.push(format!("form \"{form_name}\" uses missing table {table}"));
            }
        }
        for control in form["controls"].as_array().into_iter().flatten() {
            let binding = &control["binding"];
            let Some(column) = binding["column"].as_str() else {
                continue;
            };
            let Some(table) = binding["table"].as_str().or(form_table) else {
                continue;
            };
            let ok = tables
                .get(&table.to_lowercase())
                .is_some_and(|cols| cols.contains(&column.to_lowercase()));
            if !ok {
                missing.push(format!(
                    "form \"{form_name}\" uses missing column {table}.{column}"
                ));
            }
        }
    }
    if !missing.is_empty() {
        return Err(format!("Health check failed: {}", missing.join("; ")));
    }
    Ok(())
}
