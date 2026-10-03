//! Carrying unknown tables (from newer builds or tools) over from the previous
//! archive of the same document. Their schema text is untrusted.
use super::{read_header, KNOWN_TABLES};
use crate::archive::{ArchiveError, ArchiveMetadata};
use crate::logging;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// Copies ordinary tables unknown to this build (with rows and indexes) from `prev`.
pub(super) fn preserve_unknown_tables(
    conn: &Connection,
    prev: &Path,
    metadata: &ArchiveMetadata,
) -> Result<Vec<String>, ArchiveError> {
    match read_header(prev) {
        Ok(h) if h.metadata.document_id == metadata.document_id => {}
        _ => return Ok(vec![]),
    }
    conn.execute(
        "ATTACH DATABASE ?1 AS prev",
        [prev.to_string_lossy().as_ref()],
    )?;
    let result = (|| {
        let tables: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT name, sql FROM prev.sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut kept = vec![];
        for (name, sql) in tables {
            if KNOWN_TABLES.contains(&name.as_str()) {
                continue;
            }
            let quoted = format!("\"{}\"", name.replace('"', "\"\""));
            let columns: Vec<String> = {
                let mut stmt = conn.prepare(
                    "SELECT name FROM pragma_table_xinfo(?1, 'prev') WHERE hidden=0 ORDER BY cid",
                )?;
                let rows = stmt.query_map([&name], |r| r.get::<_, String>(0))?;
                rows.map(|c| c.map(|c| format!("\"{}\"", c.replace('"', "\"\""))))
                    .collect::<Result<_, _>>()?
            };
            if let Err(reason) = run_preserved_ddl(conn, &sql, DdlKind::Table) {
                logging::warn(
                    "archive",
                    &format!("did not preserve unknown table {name:?}: {reason}"),
                );
                continue;
            }
            let created: bool = conn
                .query_row(
                    "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?1",
                    [&name],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !created {
                logging::warn(
                    "archive",
                    &format!("did not preserve unknown table {name:?}: its schema creates a different table"),
                );
                continue;
            }
            let list = columns.join(",");
            conn.execute(
                &format!("INSERT INTO main.{quoted}({list}) SELECT {list} FROM prev.{quoted}"),
                [],
            )?;
            let indexes: Vec<String> = {
                let mut stmt = conn.prepare(
                    "SELECT sql FROM prev.sqlite_master WHERE type='index' AND tbl_name=?1 AND sql IS NOT NULL",
                )?;
                let rows = stmt.query_map([&name], |r| r.get(0))?;
                rows.collect::<Result<_, _>>()?
            };
            for index in indexes {
                if let Err(reason) = run_preserved_ddl(conn, &index, DdlKind::Index) {
                    logging::warn(
                        "archive",
                        &format!("did not preserve an index of {name:?}: {reason}"),
                    );
                }
            }
            kept.push(name);
        }
        Ok::<_, ArchiveError>(kept)
    })();
    conn.execute_batch("DETACH DATABASE prev")?;
    let kept = result?;
    if !kept.is_empty() {
        logging::info(
            "archive",
            &format!("preserved unknown archive tables: {}", kept.join(", ")),
        );
    }
    Ok(kept)
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum DdlKind {
    Table,
    Index,
}

/// Runs one `CREATE TABLE` / `CREATE [UNIQUE] INDEX` statement taken from another
/// archive's `sqlite_master`. That text is untrusted: it must be exactly one
/// statement of the expected kind, and an authorizer denies everything except
/// creating that object in `main` (no ATTACH/DETACH, PRAGMA, triggers, views,
/// temp objects, or writes to the attached previous archive).
pub(super) fn run_preserved_ddl(conn: &Connection, sql: &str, kind: DdlKind) -> Result<(), String> {
    let words: Vec<String> = sql
        .split_whitespace()
        .take(3)
        .map(str::to_ascii_uppercase)
        .collect();
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let shape_ok = match kind {
        DdlKind::Table => words.starts_with(&["CREATE", "TABLE"]),
        DdlKind::Index => {
            words.starts_with(&["CREATE", "INDEX"])
                || words.starts_with(&["CREATE", "UNIQUE", "INDEX"])
        }
    };
    if !shape_ok {
        return Err("schema is not a plain CREATE TABLE/INDEX statement".into());
    }
    let mut batch = rusqlite::Batch::new(conn, sql);
    match batch.next() {
        Ok(Some(_)) => {}
        Ok(None) => return Err("empty schema".into()),
        Err(e) => return Err(e.to_string()),
    }
    // A non-empty tail (anything after the first statement) is rejected outright.
    if !matches!(batch.next(), Ok(None)) {
        return Err("schema holds more than one statement".into());
    }
    let _ = conn.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true);
    conn.authorizer(Some(move |ctx: rusqlite::hooks::AuthContext<'_>| {
        use rusqlite::hooks::{AuthAction as A, Authorization};
        let main = ctx.database_name == Some("main");
        let allowed = match ctx.action {
            A::CreateTable { .. } => kind == DdlKind::Table && main,
            A::CreateIndex { .. } => kind == DdlKind::Index && main,
            A::Insert { table_name } | A::Update { table_name, .. } => {
                main && table_name.eq_ignore_ascii_case("sqlite_master")
            }
            A::Read { .. } | A::Function { .. } | A::Reindex { .. } => true,
            _ => false,
        };
        if allowed {
            Authorization::Allow
        } else {
            Authorization::Deny
        }
    }));
    // Prepared again under the authorizer: SQLite authorizes at compile time.
    let result = conn
        .prepare(sql)
        .and_then(|mut s| s.execute([]))
        .map(|_| ())
        .map_err(|e| e.to_string());
    conn.authorizer(None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>);
    result
}
