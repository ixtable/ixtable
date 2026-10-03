//! `SqliteRecordStore`: the embedded `data.db` write path (PRD §9.2).
//! Values are always bound parameters; identifiers come from the parsed
//! table definition and are quoted.
use super::model::{StoreError, WriteOp, WriteOutcome};
use crate::data::{self, q, DataValue, LogicalType, NamedValue, TableDef};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection, OpenFlags,
};
use std::path::{Path, PathBuf};

pub struct SqliteRecordStore {
    pub path: PathBuf,
}

pub use super::sqlite_errors::{map_error, se};

pub fn open(path: &Path) -> Result<Connection, StoreError> {
    if !path.is_file() {
        return Err(StoreError::new(
            "CONNECTION",
            format!("{} is missing", path.display()),
        ));
    }
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(se)?;
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(se)?;
    Ok(c)
}

/// The parsed definition of a table (views are rejected as read-only).
pub fn table_def(c: &Connection, table: &str) -> Result<TableDef, StoreError> {
    let row: Option<(String, Option<String>)> = c
        .query_row(
            "SELECT type, sql FROM sqlite_schema WHERE name=?1 AND type IN ('table','view')",
            [table],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (kind, sql) = row.ok_or_else(|| {
        StoreError::new(
            "NOT_FOUND",
            format!("Table or view {table:?} does not exist"),
        )
    })?;
    if kind == "view" {
        return Err(StoreError::new(
            "READ_ONLY",
            format!("{table:?} is a read-only view"),
        ));
    }
    let mut def = data::parse_sqlite_create_table(&sql.unwrap_or_default())
        .map_err(StoreError::validation)?;
    let mut s = c
        .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=?1 AND sql IS NOT NULL ORDER BY name")
        .map_err(se)?;
    let sqls = s
        .query_map([table], |r| r.get::<_, String>(0))
        .map_err(se)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(se)?;
    for sql in sqls {
        if let Ok(index) = data::parse_sqlite_create_index(&sql) {
            def.indexes.push(index);
        }
    }
    Ok(def)
}

pub fn bind(v: &DataValue) -> Result<SqlValue, StoreError> {
    Ok(match v {
        DataValue::Null => SqlValue::Null,
        DataValue::Integer(v) => SqlValue::Integer(*v),
        DataValue::Real(v) if v.is_finite() => SqlValue::Real(*v),
        DataValue::Real(_) => return Err(StoreError::validation("Real values must be finite")),
        DataValue::Boolean(v) => SqlValue::Integer(*v as i64),
        DataValue::Blob(v) => SqlValue::Blob(
            STANDARD
                .decode(v)
                .map_err(|_| StoreError::validation("Blob values must be valid base64"))?,
        ),
        DataValue::Text(v)
        | DataValue::Date(v)
        | DataValue::Timestamp(v)
        | DataValue::Decimal(v)
        | DataValue::Time(v) => SqlValue::Text(v.clone()),
    })
}
pub fn read(v: ValueRef<'_>) -> DataValue {
    match v {
        ValueRef::Null => DataValue::Null,
        ValueRef::Integer(v) => DataValue::Integer(v),
        ValueRef::Real(v) => DataValue::Real(v),
        ValueRef::Text(v) => DataValue::Text(String::from_utf8_lossy(v).into()),
        ValueRef::Blob(v) => DataValue::Blob(STANDARD.encode(v)),
    }
}

/// Identity columns of a table: its primary key, or SQLite's rowid.
pub fn identity(def: &TableDef) -> Result<Vec<(String, LogicalType)>, StoreError> {
    if def.primary_key.is_empty() {
        if def.without_rowid {
            return Err(StoreError::validation(
                "WITHOUT ROWID tables require a primary key",
            ));
        }
        return Ok(vec![("rowid".into(), LogicalType::Integer)]);
    }
    Ok(def
        .primary_key
        .iter()
        .map(|k| {
            let t = def
                .column(k)
                .map(|c| c.logical_type.clone())
                .unwrap_or(LogicalType::Text);
            (k.clone(), t)
        })
        .collect())
}

/// Validates column names and canonicalises values by logical type.
pub fn prepare(
    def: &TableDef,
    values: &[NamedValue],
    allow_generated: bool,
) -> Result<Vec<(String, LogicalType, DataValue)>, StoreError> {
    values
        .iter()
        .map(|v| {
            let c = def
                .columns
                .iter()
                .find(|c| c.name == v.column)
                .or_else(|| def.column(&v.column))
                .ok_or_else(|| StoreError::validation(format!("Unknown column {:?}", v.column)))?;
            if c.generated_expression.is_some() && !allow_generated {
                return Err(StoreError::validation(format!(
                    "{:?} is a generated column",
                    c.name
                )));
            }
            let value = c
                .logical_type
                .normalize(&c.name, &v.value)
                .map_err(StoreError::validation)?;
            Ok((c.name.clone(), c.logical_type.clone(), value))
        })
        .collect()
}
fn identity_values(
    def: &TableDef,
    values: &[DataValue],
) -> Result<Vec<(String, LogicalType, DataValue)>, StoreError> {
    let keys = identity(def)?;
    if keys.len() != values.len() {
        return Err(StoreError::new(
            "STALE_ROW",
            "Row identity does not match the primary key",
        ));
    }
    keys.into_iter()
        .zip(values)
        .map(|((k, t), v)| {
            let v = t.normalize(&k, v).map_err(StoreError::validation)?;
            Ok((k, t, v))
        })
        .collect()
}
fn comparison(column: &str, t: &LogicalType) -> String {
    let c = if column == "rowid" {
        "rowid".into()
    } else {
        q(column)
    };
    match t {
        LogicalType::Date | LogicalType::Timestamp => format!("julianday({c}) IS julianday(?)"),
        LogicalType::Time => {
            format!("julianday('2000-01-01 ' || {c}) IS julianday('2000-01-01 ' || ?)")
        }
        _ => format!("{c} IS ?"),
    }
}
pub fn display(v: &DataValue) -> String {
    match v {
        DataValue::Null => "empty".into(),
        DataValue::Blob(_) => "(binary)".into(),
        DataValue::Text(t) | DataValue::Date(t) | DataValue::Timestamp(t) | DataValue::Time(t) => {
            format!("'{t}'")
        }
        other => other.as_text().unwrap_or_default(),
    }
}
fn select_row(
    c: &Connection,
    def: &TableDef,
    keys: &[(String, LogicalType, DataValue)],
) -> Result<Option<Vec<NamedValue>>, StoreError> {
    let wh = keys
        .iter()
        .map(|(k, t, _)| comparison(k, t))
        .collect::<Vec<_>>()
        .join(" AND ");
    let cols = def
        .columns
        .iter()
        .map(|c| q(&c.name))
        .collect::<Vec<_>>()
        .join(",");
    let binds = keys
        .iter()
        .map(|k| bind(&k.2))
        .collect::<Result<Vec<_>, _>>()?;
    let mut s = c
        .prepare(&format!("SELECT {cols} FROM {} WHERE {wh}", q(&def.name)))
        .map_err(se)?;
    let mut rows = s.query(params_from_iter(binds.iter())).map_err(se)?;
    Ok(match rows.next().map_err(se)? {
        Some(r) => Some(
            def.columns
                .iter()
                .enumerate()
                .map(|(i, col)| NamedValue {
                    column: col.name.clone(),
                    value: col.logical_type.coerce_read(read(r.get_ref(i).unwrap())),
                })
                .collect(),
        ),
        None => None,
    })
}
/// Explains why an identity-plus-expected-values write matched no row.
fn no_match(
    c: &Connection,
    def: &TableDef,
    keys: &[(String, LogicalType, DataValue)],
    expected: Option<&[NamedValue]>,
) -> StoreError {
    match select_row(c, def, keys) {
        Ok(Some(current)) if expected.is_some() => {
            let expected = expected.unwrap();
            let changed: Vec<String> = current
                .iter()
                .filter(|cur| {
                    expected.iter().any(|e| {
                        e.column == cur.column
                            && def
                                .column(&e.column)
                                .and_then(|col| {
                                    col.logical_type.normalize(&e.column, &e.value).ok()
                                })
                                .map(|v| v != cur.value)
                                .unwrap_or(true)
                    })
                })
                .map(|cur| format!("{} is now {}", cur.column, display(&cur.value)))
                .collect();
            StoreError::new(
                "CONFLICT",
                format!(
                    "This record was changed by someone else since you opened it{}{}. Reload to see the current values.",
                    if changed.is_empty() { "" } else { ": " },
                    changed.join(", ")
                ),
            )
        }
        Ok(_) => StoreError::new("STALE_ROW", "The record no longer exists"),
        Err(e) => e,
    }
}
fn expected_clause(
    def: &TableDef,
    expected: Option<&[NamedValue]>,
) -> Result<(String, Vec<SqlValue>), StoreError> {
    let mut sql = String::new();
    let mut binds = vec![];
    for e in expected.unwrap_or_default() {
        let col = def
            .column(&e.column)
            .ok_or_else(|| StoreError::validation(format!("Unknown column {:?}", e.column)))?;
        let value = col
            .logical_type
            .normalize(&col.name, &e.value)
            .unwrap_or_else(|_| e.value.clone());
        sql.push_str(" AND ");
        sql.push_str(&comparison(&col.name, &col.logical_type));
        binds.push(bind(&value)?);
    }
    Ok((sql, binds))
}

pub fn insert_on(
    c: &Connection,
    table: &str,
    values: &[NamedValue],
) -> Result<Vec<DataValue>, StoreError> {
    let def = table_def(c, table)?;
    let values = prepare(&def, values, false)?;
    let keys = identity(&def)?;
    let returning = keys
        .iter()
        .map(|(k, _)| if k == "rowid" { "rowid".into() } else { q(k) })
        .collect::<Vec<_>>()
        .join(",");
    let base = if values.is_empty() {
        format!("INSERT INTO {} DEFAULT VALUES", q(table))
    } else {
        format!(
            "INSERT INTO {} ({}) VALUES ({})",
            q(table),
            values.iter().map(|x| q(&x.0)).collect::<Vec<_>>().join(","),
            vec!["?"; values.len()].join(",")
        )
    };
    let binds = values
        .iter()
        .map(|x| bind(&x.2))
        .collect::<Result<Vec<_>, _>>()?;
    c.query_row(
        &format!("{base} RETURNING {returning}"),
        params_from_iter(binds.iter()),
        |r| {
            Ok(keys
                .iter()
                .enumerate()
                .map(|(i, (_, t))| t.coerce_read(read(r.get_ref(i).unwrap())))
                .collect())
        },
    )
    .map_err(se)
}

pub fn update_on(
    c: &Connection,
    table: &str,
    values: &[NamedValue],
    identity_values_in: &[DataValue],
    expected: Option<&[NamedValue]>,
) -> Result<u64, StoreError> {
    let def = table_def(c, table)?;
    if values.is_empty() {
        return Err(StoreError::validation("No values to update"));
    }
    let values = prepare(&def, values, false)?;
    let keys = identity_values(&def, identity_values_in)?;
    let (extra, extra_binds) = expected_clause(&def, expected)?;
    let wh = keys
        .iter()
        .map(|(k, t, _)| comparison(k, t))
        .collect::<Vec<_>>()
        .join(" AND ");
    let set = values
        .iter()
        .map(|x| format!("{}=?", q(&x.0)))
        .collect::<Vec<_>>()
        .join(",");
    let mut binds = values
        .iter()
        .map(|x| bind(&x.2))
        .collect::<Result<Vec<_>, _>>()?;
    for k in &keys {
        binds.push(bind(&k.2)?);
    }
    binds.extend(extra_binds);
    let n = c
        .execute(
            &format!("UPDATE {} SET {set} WHERE {wh}{extra}", q(table)),
            params_from_iter(binds.iter()),
        )
        .map_err(se)?;
    match n {
        1 => Ok(1),
        0 => Err(no_match(c, &def, &keys, expected)),
        n => Err(StoreError::new(
            "STALE_ROW",
            format!("Expected one row, changed {n}"),
        )),
    }
}

pub fn delete_on(
    c: &Connection,
    table: &str,
    identity_values_in: &[DataValue],
    expected: Option<&[NamedValue]>,
) -> Result<u64, StoreError> {
    let def = table_def(c, table)?;
    let keys = identity_values(&def, identity_values_in)?;
    let (extra, extra_binds) = expected_clause(&def, expected)?;
    let wh = keys
        .iter()
        .map(|(k, t, _)| comparison(k, t))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut binds = keys
        .iter()
        .map(|k| bind(&k.2))
        .collect::<Result<Vec<_>, _>>()?;
    binds.extend(extra_binds);
    let n = c
        .execute(
            &format!("DELETE FROM {} WHERE {wh}{extra}", q(table)),
            params_from_iter(binds.iter()),
        )
        .map_err(se)?;
    match n {
        1 => Ok(1),
        0 => Err(no_match(c, &def, &keys, expected)),
        n => Err(StoreError::new(
            "STALE_ROW",
            format!("Expected one row, changed {n}"),
        )),
    }
}

pub fn apply_op(c: &Connection, op: &WriteOp) -> Result<WriteOutcome, StoreError> {
    Ok(match op {
        WriteOp::Insert { table, values } => WriteOutcome {
            changed: 1,
            identity: Some(insert_on(c, table, values)?),
        },
        WriteOp::Update {
            table,
            values,
            identity,
            expected,
        } => WriteOutcome {
            changed: update_on(c, table, values, identity, expected.as_deref())?,
            identity: None,
        },
        WriteOp::Delete {
            table,
            identity,
            expected,
        } => WriteOutcome {
            changed: delete_on(c, table, identity, expected.as_deref())?,
            identity: None,
        },
    })
}

/// A store connection holding the file's exclusive gate (see `data::gate`).
pub type GatedConnection = data::gate::Gated<Connection>;

impl SqliteRecordStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    /// A connection that holds the file's gate exclusively until dropped, so no
    /// DuckDB read of the same file overlaps it (see `data::gate`).
    pub fn connection(&self) -> Result<GatedConnection, StoreError> {
        let gate = data::gate::exclusive(&self.path).map_err(|e| StoreError::new("BUSY", e))?;
        Ok(GatedConnection::new(open(&self.path)?, Some(gate)))
    }
    /// Runs `f` in one transaction; any error rolls everything back.
    pub fn transaction<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut c = self.connection()?;
        let tx = c.transaction().map_err(se)?;
        let out = f(&tx)?;
        tx.commit().map_err(se)?;
        Ok(out)
    }
}
