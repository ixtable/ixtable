//! Executes planned action queries (`action::Plan`) on the writer connection.
//!
//! `direct` runs the statements on the read-write attachment in one
//! transaction. When triggers need the changed rows, it first copies the
//! table's keys (inserts) or rows (updates) and compares after the statement.
//! `compute_update` runs an embedded-SQLite UPDATE on a copy of the table and
//! returns the changed rows as RecordStore updates, joined to the live table by
//! rowid, so even a changed primary key is found. It never writes the file.
use super::action::{ChangedRows, UpdatedRow, WORK};
use crate::archive::ActionKind;
use crate::data::{self, DataValue, NamedValue};
use crate::manager::AppError;
use crate::recordstore::WriteOp;
use duckdb::types::Value as DuckValue;

const BEFORE: &str = "temp.main.__ixtable_before";
const ROWID: &str = "__ixtable_rowid";

/// What a run works on.
pub struct Job {
    /// The table, qualified in the `data` catalog.
    pub table: String,
    /// The table's plain name (RecordStore writes).
    pub name: String,
    /// Primary key columns; empty when the table has none.
    pub keys: Vec<String>,
    /// Whether the table has a rowid (SQLite tables not declared WITHOUT ROWID).
    pub rowid: bool,
    pub kind: ActionKind,
    /// Collect the changed rows for triggers.
    pub watch: bool,
    pub dry_run: bool,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub changed: u64,
    pub removed: u64,
    pub rows: ChangedRows,
}

/// A computed embedded-SQLite UPDATE: the RecordStore writes still to apply.
pub struct Computed {
    pub outcome: Outcome,
    pub ops: Vec<WriteOp>,
}

pub fn database_error(message: &str) -> AppError {
    let code = if message.to_ascii_lowercase().contains("constraint") {
        "CONSTRAINT"
    } else {
        "DATABASE_ERROR"
    };
    let message = message.trim_start_matches("Invalid Error: ");
    AppError::new(code, message.to_string())
}

fn failed(e: duckdb::Error) -> AppError {
    database_error(&e.to_string())
}

/// Runs `f` in a transaction that commits only when `commit` and `f` succeeded.
fn in_transaction<T>(
    connection: &duckdb::Connection,
    commit: bool,
    f: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    connection
        .execute_batch("BEGIN TRANSACTION")
        .map_err(failed)?;
    let result = f();
    let end = if result.is_ok() && commit {
        "COMMIT"
    } else {
        "ROLLBACK"
    };
    let ended = connection.execute_batch(end);
    let out = result?;
    ended.map_err(failed)?;
    Ok(out)
}

fn run_statement(
    connection: &duckdb::Connection,
    sql: &str,
    values: &[DuckValue],
) -> Result<u64, AppError> {
    let mut stmt = connection.prepare(sql).map_err(failed)?;
    let n = stmt.parameter_count().min(values.len());
    Ok(stmt
        .execute(duckdb::params_from_iter(values[..n].iter()))
        .map_err(failed)? as u64)
}

fn select_rows(
    connection: &duckdb::Connection,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<DataValue>>), AppError> {
    let mut stmt = connection.prepare(sql).map_err(failed)?;
    let mut rows = vec![];
    let mut cursor = stmt.query([]).map_err(failed)?;
    while let Some(row) = cursor.next().map_err(failed)? {
        let count = row.as_ref().column_count();
        rows.push(
            (0..count)
                .map(|i| data::duck_value(row.get::<_, DuckValue>(i).unwrap_or(DuckValue::Null)))
                .collect(),
        );
    }
    drop(cursor);
    let columns = stmt.column_names().iter().map(|c| c.to_string()).collect();
    Ok((columns, rows))
}

fn list(columns: &[String], alias: &str) -> String {
    columns
        .iter()
        .map(|c| format!("{alias}.{}", data::q(c)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn same_keys(keys: &[String]) -> String {
    keys.iter()
        .map(|k| format!("t.{0} IS NOT DISTINCT FROM b.{0}", data::q(k)))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn any_differs(columns: &[String], new: &str, old: &str) -> String {
    columns
        .iter()
        .map(|c| format!("{new}.{0} IS DISTINCT FROM {old}.{0}", data::q(c)))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn columns_of(connection: &duckdb::Connection, table: &str) -> Result<Vec<String>, AppError> {
    Ok(select_rows(connection, &format!("SELECT * FROM {table} LIMIT 0"))?.0)
}

/// Runs the statements on the attachment in one transaction.
pub fn direct(
    connection: &duckdb::Connection,
    sql: &[String],
    values: &[DuckValue],
    job: &Job,
) -> Result<Outcome, AppError> {
    in_transaction(connection, !job.dry_run, || {
        let table = &job.table;
        if job.watch && matches!(job.kind, ActionKind::Insert | ActionKind::Update) {
            // Updates compare every column; inserts only need the keys that existed.
            let snapshot = match job.kind {
                ActionKind::Update => "*".to_string(),
                _ => list(&job.keys, "t"),
            };
            connection
                .execute_batch(&format!(
                    "CREATE OR REPLACE TEMP TABLE __ixtable_before AS SELECT {snapshot} FROM {table} t"
                ))
                .map_err(failed)?;
        }
        let counts = sql
            .iter()
            .map(|s| run_statement(connection, s, values))
            .collect::<Result<Vec<_>, _>>()?;
        let (removed, changed) = match counts.as_slice() {
            [removed, inserted] => (*removed, *inserted),
            [n] => (0, *n),
            _ => (0, 0),
        };
        let rows = match (job.watch, job.kind) {
            (false, _) | (_, ActionKind::Delete) => ChangedRows::default(),
            (true, ActionKind::Update) => updated_since_snapshot(connection, job)?,
            (true, ActionKind::Replace) => ChangedRows {
                created: select_rows(
                    connection,
                    &format!("SELECT {} FROM {table} t", list(&job.keys, "t")),
                )?
                .1,
                updated: vec![],
            },
            (true, ActionKind::Insert) => ChangedRows {
                created: select_rows(
                    connection,
                    &format!(
                        "SELECT {} FROM {table} t ANTI JOIN {BEFORE} b ON {}",
                        list(&job.keys, "t"),
                        same_keys(&job.keys)
                    ),
                )?
                .1,
                updated: vec![],
            },
        };
        Ok(Outcome {
            changed,
            removed,
            rows,
        })
    })
}

/// Rows with the same key and some different column, with their old values.
fn updated_since_snapshot(
    connection: &duckdb::Connection,
    job: &Job,
) -> Result<ChangedRows, AppError> {
    let columns = columns_of(connection, BEFORE)?;
    let sql = format!(
        "SELECT {}, {} FROM {} t JOIN {BEFORE} b ON {} WHERE {}",
        list(&job.keys, "t"),
        list(&columns, "b"),
        job.table,
        same_keys(&job.keys),
        any_differs(&columns, "t", "b")
    );
    let (_, rows) = select_rows(connection, &sql)?;
    let updated = rows
        .into_iter()
        .map(|row| {
            let (identity, old) = row.split_at(job.keys.len());
            UpdatedRow {
                identity: identity.to_vec(),
                old: named(&columns, old),
            }
        })
        .collect();
    Ok(ChangedRows {
        created: vec![],
        updated,
    })
}

fn named(columns: &[String], values: &[DataValue]) -> Vec<NamedValue> {
    columns
        .iter()
        .zip(values)
        .map(|(column, value)| NamedValue {
            column: column.clone(),
            value: value.clone(),
        })
        .collect()
}

/// Runs an embedded-SQLite UPDATE on a copy and returns the changed rows as
/// RecordStore updates (only the changed columns), plus the old values. The
/// transaction always rolls back: the attachment is never written.
pub fn compute_update(
    connection: &duckdb::Connection,
    sql: &str,
    values: &[DuckValue],
    job: &Job,
) -> Result<Computed, AppError> {
    if !job.rowid && job.keys.is_empty() {
        return Err(AppError::new(
            "VALIDATION_ERROR",
            format!(
                "The table \"{}\" has neither a rowid nor a primary key",
                job.name
            ),
        ));
    }
    in_transaction(connection, false, || {
        let table = &job.table;
        let columns = columns_of(connection, table)?;
        let row_key = if job.rowid {
            format!("rowid AS {ROWID}, ")
        } else {
            String::new()
        };
        connection
            .execute_batch(&format!(
                "CREATE OR REPLACE TEMP TABLE __ixtable_work AS SELECT {row_key}* FROM {table}"
            ))
            .map_err(failed)?;
        let changed = run_statement(connection, sql, values)?;
        let (identity, join) = if job.rowid {
            let identity = if job.keys.is_empty() {
                "b.rowid".to_string()
            } else {
                list(&job.keys, "b")
            };
            (identity, format!("t.{ROWID} = b.rowid"))
        } else {
            (list(&job.keys, "b"), same_keys(&job.keys))
        };
        let width = if job.keys.is_empty() {
            1
        } else {
            job.keys.len()
        };
        let diff = format!(
            "SELECT {identity}, {}, {} FROM {WORK} t JOIN {table} b ON {join} WHERE {}",
            list(&columns, "t"),
            list(&columns, "b"),
            any_differs(&columns, "t", "b")
        );
        let (_, rows) = select_rows(connection, &diff)?;
        let mut ops = vec![];
        let mut updated = vec![];
        for row in rows {
            let (identity, rest) = row.split_at(width);
            let (new, old) = rest.split_at(columns.len());
            let values: Vec<NamedValue> = columns
                .iter()
                .zip(new.iter().zip(old))
                .filter(|(_, (n, o))| n != o)
                .map(|(c, (n, _))| NamedValue {
                    column: c.clone(),
                    value: n.clone(),
                })
                .collect();
            ops.push(WriteOp::Update {
                table: job.name.clone(),
                values,
                identity: identity.to_vec(),
                expected: None,
            });
            // Triggers read the row by its key after the update (a changed key included).
            let current = if job.keys.is_empty() {
                identity.to_vec()
            } else {
                job.keys
                    .iter()
                    .filter_map(|k| columns.iter().position(|c| c == k).map(|i| new[i].clone()))
                    .collect()
            };
            updated.push(UpdatedRow {
                identity: current,
                old: named(&columns, old),
            });
        }
        let rows = if job.watch {
            ChangedRows {
                created: vec![],
                updated,
            }
        } else {
            ChangedRows::default()
        };
        Ok(Computed {
            outcome: Outcome {
                changed,
                removed: 0,
                rows,
            },
            ops,
        })
    })
}
