//! Typed database operations used by the data view.
//!
//! Identifiers are discovered from SQLite and quoted here; values are always
//! bound parameters.  Consequently none of the mutation entry points accepts
//! arbitrary SQL.
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection, OpenFlags,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

/// Session-scoped DuckDB reader. Production callers pass the signed extension
/// copied from the application resources; no extension may be auto-installed.
/// Writes never enter this connection and are performed by the rusqlite
/// transaction functions below.
pub struct ReadRuntime {
    pub workspace: std::path::PathBuf,
    connection: duckdb::Connection,
}
impl ReadRuntime {
    pub fn new(workspace: &Path, sqlite_extension: &Path) -> Result<Self, String> {
        let config = duckdb::Config::default()
            .enable_autoload_extension(false)
            .map_err(|e| e.to_string())?
            .enable_external_access(true)
            .map_err(|e| e.to_string())?;
        let connection = duckdb::Connection::open_in_memory_with_flags(config)
            .map_err(|e| format!("DuckDB startup: {e}"))?;
        let extension = sqlite_extension.to_string_lossy().replace('\'', "''");
        connection
            .execute_batch(&format!("LOAD '{extension}'"))
            .map_err(|e| format!("SQLite extension startup: {e}"))?;
        let mut runtime = Self {
            workspace: workspace.to_owned(),
            connection,
        };
        runtime.refresh()?;
        Ok(runtime)
    }
    pub fn refresh(&mut self) -> Result<(), String> {
        let _ = self.connection.execute_batch("USE memory; DETACH data");
        let db = self
            .workspace
            .join("data.db")
            .to_string_lossy()
            .replace('\'', "''");
        self.connection
            .execute_batch(&format!(
                "ATTACH '{db}' AS data (TYPE SQLITE, READ_ONLY); USE data"
            ))
            .map_err(|e| format!("SQLite attachment: {e}"))
    }
    pub fn connection(&self) -> &duckdb::Connection {
        &self.connection
    }

    #[cfg(test)]
    fn isolated_for_test() -> Result<Self, String> {
        let config = duckdb::Config::default()
            .enable_autoload_extension(false)
            .map_err(|e| e.to_string())?;
        let connection =
            duckdb::Connection::open_in_memory_with_flags(config).map_err(|e| e.to_string())?;
        Ok(Self {
            workspace: std::path::PathBuf::new(),
            connection,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum DataValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(String),
    Boolean(bool),
    Date(String),
    Timestamp(String),
}
impl DataValue {
    fn sql(&self) -> Result<SqlValue, String> {
        Ok(match self {
            Self::Null => SqlValue::Null,
            Self::Integer(v) => SqlValue::Integer(*v),
            Self::Real(v) if v.is_finite() => SqlValue::Real(*v),
            Self::Real(_) => return Err("Real values must be finite".into()),
            Self::Text(v) | Self::Date(v) | Self::Timestamp(v) => SqlValue::Text(v.clone()),
            Self::Blob(v) => SqlValue::Blob(
                STANDARD
                    .decode(v)
                    .map_err(|_| "Blob values must be valid base64")?,
            ),
            Self::Boolean(v) => SqlValue::Integer(*v as i64),
        })
    }
}
fn value(v: ValueRef<'_>) -> DataValue {
    match v {
        ValueRef::Null => DataValue::Null,
        ValueRef::Integer(v) => DataValue::Integer(v),
        ValueRef::Real(v) => DataValue::Real(v),
        ValueRef::Text(v) => DataValue::Text(String::from_utf8_lossy(v).into()),
        ValueRef::Blob(v) => DataValue::Blob(STANDARD.encode(v)),
    }
}
fn duck_value(v: duckdb::types::Value) -> DataValue {
    use duckdb::types::Value as V;
    match v {
        V::Null => DataValue::Null,
        V::Boolean(v) => DataValue::Boolean(v),
        V::TinyInt(v) => DataValue::Integer(v as i64),
        V::SmallInt(v) => DataValue::Integer(v as i64),
        V::Int(v) => DataValue::Integer(v as i64),
        V::BigInt(v) => DataValue::Integer(v),
        V::UTinyInt(v) => DataValue::Integer(v as i64),
        V::USmallInt(v) => DataValue::Integer(v as i64),
        V::UInt(v) => DataValue::Integer(v as i64),
        V::Float(v) => DataValue::Real(v as f64),
        V::Double(v) => DataValue::Real(v),
        V::Text(v) => DataValue::Text(v),
        V::Blob(v) => DataValue::Blob(STANDARD.encode(v)),
        other => DataValue::Text(format!("{other:?}")),
    }
}
fn q(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn sql_names(list: &str) -> Vec<String> {
    list.split(',')
        .map(|name| {
            name.trim()
                .trim_matches(|c| matches!(c, '"' | '`' | '[' | ']'))
                .replace("\"\"", "\"")
        })
        .collect()
}
fn foreign_keys_from_ddl(sql: &str) -> Vec<ForeignKey> {
    let upper = sql.to_ascii_uppercase();
    let mut cursor = 0;
    let mut out = vec![];
    while let Some(relative) = upper[cursor..].find("FOREIGN KEY") {
        let start = cursor + relative;
        let Some(open) = sql[start..].find('(').map(|v| start + v) else {
            break;
        };
        let Some(close) = sql[open + 1..].find(')').map(|v| open + 1 + v) else {
            break;
        };
        let Some(reference) = upper[close..]
            .find("REFERENCES")
            .map(|v| close + v + "REFERENCES".len())
        else {
            break;
        };
        let Some(target_open) = sql[reference..].find('(').map(|v| reference + v) else {
            break;
        };
        let Some(target_close) = sql[target_open + 1..]
            .find(')')
            .map(|v| target_open + 1 + v)
        else {
            break;
        };
        let target_table = sql[reference..target_open]
            .trim()
            .trim_matches(|c| matches!(c, '"' | '`' | '[' | ']'))
            .replace("\"\"", "\"");
        let tail = upper[target_close + 1..].split(',').next().unwrap_or("");
        let action = |kind: &str| {
            tail.find(kind)
                .map(|p| {
                    tail[p + kind.len()..]
                        .trim()
                        .split_whitespace()
                        .take(2)
                        .collect::<Vec<_>>()
                })
                .map(|parts| {
                    if parts.first() == Some(&"SET") || parts.first() == Some(&"NO") {
                        parts.join(" ")
                    } else {
                        parts.first().copied().unwrap_or("NO ACTION").into()
                    }
                })
                .unwrap_or_else(|| "NO ACTION".into())
        };
        out.push(ForeignKey {
            id: out.len() as i64,
            from_columns: sql_names(&sql[open + 1..close]),
            target_table,
            target_columns: sql_names(&sql[target_open + 1..target_close]),
            on_update: action("ON UPDATE"),
            on_delete: action("ON DELETE"),
        });
        cursor = target_close + 1
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    pub object_type: String,
    pub row_count: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub declared_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key_position: u32,
    pub generated: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub id: i64,
    pub from_columns: Vec<String>,
    pub target_table: String,
    pub target_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<Column>,
    pub foreign_keys: Vec<ForeignKey>,
    pub without_rowid: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<DataValue>>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<DataValue>>,
    pub identities: Vec<Vec<DataValue>>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub column: String,
    pub descending: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOperator {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    Contains,
    StartsWith,
    IsNull,
    IsNotNull,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub operator: FilterOperator,
    pub value: Option<DataValue>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedValue {
    pub column: String,
    pub value: DataValue,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    pub identity: Vec<DataValue>,
    pub values: Vec<NamedValue>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateColumn {
    pub name: String,
    pub declared_type: String,
    pub nullable: bool,
    pub primary_key_position: u32,
    pub unique: bool,
    pub default_expression: Option<String>,
    pub generated_expression: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateForeignKey {
    pub columns: Vec<String>,
    pub target_table: String,
    pub target_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTable {
    pub name: String,
    pub columns: Vec<CreateColumn>,
    #[serde(default)]
    pub foreign_keys: Vec<CreateForeignKey>,
    #[serde(default)]
    pub checks: Vec<String>,
    #[serde(default)]
    pub without_rowid: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum AlterTable {
    RenameTable { new_name: String },
    RenameColumn { column: String, new_name: String },
    AddColumn { column: CreateColumn },
    DropColumn { column: String },
}

impl ReadRuntime {
    pub fn objects(&self) -> Result<Vec<DbObject>, String> {
        let mut stmt=self.connection.prepare("SELECT table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_catalog='data' AND table_schema='main' AND table_name NOT LIKE 'sqlite_%' ORDER BY lower(table_name)").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = vec![];
        for row in rows {
            let (name, object_type) = row.map_err(|e| e.to_string())?;
            let row_count = self
                .connection
                .query_row(
                    &format!("SELECT count(*) FROM data.{}", q(&name)),
                    [],
                    |r| r.get::<_, u64>(0),
                )
                .ok();
            out.push(DbObject {
                name,
                object_type,
                row_count,
            })
        }
        Ok(out)
    }
    pub fn query(&self, sql: &str) -> Result<QueryResult, String> {
        let trimmed = sql.trim();
        if trimmed.is_empty()
            || trimmed.contains(';') && trimmed.trim_end_matches(';').contains(';')
        {
            return Err("Exactly one query statement is required".into());
        }
        let upper = trimmed.to_ascii_uppercase();
        let first = upper.split_whitespace().next().unwrap_or("");
        let forbidden = [
            "INSERT",
            "UPDATE",
            "DELETE",
            "CREATE",
            "DROP",
            "ALTER",
            "ATTACH",
            "DETACH",
            "INSTALL",
            "LOAD",
            "COPY",
            "EXPORT",
            "IMPORT",
            "CALL",
            "PRAGMA",
            "SET",
            "RESET",
            "READ_CSV",
            "READ_JSON",
            "READ_NDJSON",
            "READ_PARQUET",
            "PARQUET_SCAN",
            "SQLITE_SCAN",
            "READ_BLOB",
            "READ_TEXT",
            "GLOB",
            "HTTPFS",
        ];
        if !matches!(first, "SELECT" | "WITH" | "VALUES" | "SHOW" | "DESCRIBE")
            || forbidden.iter().any(|word| {
                upper
                    .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                    .any(|token| token == *word)
            })
        {
            return Err("Only one read-only query is allowed".into());
        }
        let mut stmt = self
            .connection
            .prepare(trimmed)
            .map_err(|e| e.to_string())?;
        let mut cursor = stmt.query([]).map_err(|e| e.to_string())?;
        let mut rows = vec![];
        while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
            let count = row.as_ref().column_count();
            rows.push(
                (0..count)
                    .map(|i| duck_value(row.get::<_, duckdb::types::Value>(i).unwrap()))
                    .collect(),
            )
        }
        drop(cursor);
        let columns = stmt.column_names().iter().map(|x| x.to_string()).collect();
        Ok(QueryResult { columns, rows })
    }
    pub fn schema(&self, table: &str) -> Result<TableSchema, String> {
        if !self.objects()?.iter().any(|o| o.name == table) {
            return Err(format!("Table or view {table:?} does not exist"));
        }
        let mut stmt=self.connection.prepare("SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_catalog='data' AND table_schema='main' AND table_name=? ORDER BY ordinal_position").map_err(|e|e.to_string())?;
        let mut columns = stmt
            .query_map([table], |r| {
                Ok(Column {
                    name: r.get(0)?,
                    declared_type: r.get(1)?,
                    nullable: r.get::<_, String>(2)? == "YES",
                    default_value: r.get(3)?,
                    primary_key_position: 0,
                    generated: false,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut pk=self.connection.prepare("SELECT k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k USING (constraint_catalog,constraint_schema,constraint_name) WHERE t.table_catalog='data' AND t.table_schema='main' AND t.table_name=? AND t.constraint_type='PRIMARY KEY' ORDER BY k.ordinal_position").map_err(|e|e.to_string())?;
        for (position, name) in pk
            .query_map([table], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .enumerate()
        {
            let name = name.map_err(|e| e.to_string())?;
            if let Some(column) = columns.iter_mut().find(|c| c.name == name) {
                column.primary_key_position = (position + 1) as u32
            }
        }
        let sql: Option<String> = self
            .connection
            .query_row(
                "SELECT sql FROM data.sqlite_master WHERE name=?",
                [table],
                |r| r.get(0),
            )
            .ok();
        let ddl = sql.unwrap_or_default();
        Ok(TableSchema {
            name: table.into(),
            columns,
            foreign_keys: foreign_keys_from_ddl(&ddl),
            without_rowid: ddl.to_ascii_uppercase().contains("WITHOUT ROWID"),
        })
    }
    pub fn page(
        &self,
        table: &str,
        offset: u64,
        limit: u64,
        sorts: &[Sort],
        filters: &[Filter],
    ) -> Result<Page, String> {
        if limit == 0 || limit > 1000 {
            return Err("Page size must be between 1 and 1000".into());
        }
        let meta = self.schema(table)?;
        let cols: HashSet<_> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        for name in sorts
            .iter()
            .map(|s| s.column.as_str())
            .chain(filters.iter().map(|f| f.column.as_str()))
        {
            if !cols.contains(name) {
                return Err(format!("Unknown column {name:?}"));
            }
        }
        let mut binds: Vec<duckdb::types::Value> = vec![];
        let mut predicates = vec![];
        for f in filters {
            let col = q(&f.column);
            let predicate = match f.operator {
                FilterOperator::IsNull => format!("{col} IS NULL"),
                FilterOperator::IsNotNull => format!("{col} IS NOT NULL"),
                FilterOperator::Contains | FilterOperator::StartsWith => {
                    let text = match &f.value {
                        Some(DataValue::Text(v)) => v,
                        _ => return Err("Text filter value is required".into()),
                    };
                    binds.push(duckdb::types::Value::Text(
                        if matches!(f.operator, FilterOperator::Contains) {
                            format!("%{text}%")
                        } else {
                            format!("{text}%")
                        },
                    ));
                    format!("{col} LIKE ? ESCAPE '\\'")
                }
                _ => {
                    let value = f.value.as_ref().ok_or("Filter value is required")?;
                    binds.push(match value {
                        DataValue::Null => duckdb::types::Value::Null,
                        DataValue::Integer(v) => duckdb::types::Value::BigInt(*v),
                        DataValue::Real(v) if v.is_finite() => duckdb::types::Value::Double(*v),
                        DataValue::Real(_) => return Err("Real values must be finite".into()),
                        DataValue::Text(v) | DataValue::Date(v) | DataValue::Timestamp(v) => {
                            duckdb::types::Value::Text(v.clone())
                        }
                        DataValue::Blob(v) => duckdb::types::Value::Blob(
                            STANDARD
                                .decode(v)
                                .map_err(|_| "Blob values must be valid base64")?,
                        ),
                        DataValue::Boolean(v) => duckdb::types::Value::Boolean(*v),
                    });
                    format!(
                        "{col} {} ?",
                        match f.operator {
                            FilterOperator::Eq => "=",
                            FilterOperator::Ne => "<>",
                            FilterOperator::Lt => "<",
                            FilterOperator::Lte => "<=",
                            FilterOperator::Gt => ">",
                            _ => ">=",
                        }
                    )
                }
            };
            predicates.push(predicate)
        }
        let wh = if predicates.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", predicates.join(" AND "))
        };
        let from = format!("data.{}", q(table));
        let total = self
            .connection
            .query_row(
                &format!("SELECT count(*) FROM {from}{wh}"),
                duckdb::params_from_iter(binds.iter()),
                |r| r.get::<_, u64>(0),
            )
            .map_err(|e| e.to_string())?;
        let mut identity = meta
            .columns
            .iter()
            .filter(|c| c.primary_key_position > 0)
            .map(|c| c.name.clone())
            .collect::<Vec<_>>();
        if identity.is_empty() && !meta.without_rowid {
            identity.push("rowid".into())
        }
        if identity.is_empty() {
            return Err("Object has no stable row identity".into());
        }
        let select = meta
            .columns
            .iter()
            .map(|c| q(&c.name))
            .chain((identity == ["rowid"]).then(|| "rowid".into()))
            .collect::<Vec<_>>()
            .join(",");
        let order = sorts
            .iter()
            .map(|s| {
                format!(
                    "{} {}",
                    q(&s.column),
                    if s.descending { "DESC" } else { "ASC" }
                )
            })
            .chain(identity.iter().map(|c| format!("{} ASC", q(c))))
            .collect::<Vec<_>>()
            .join(",");
        let mut all = binds;
        all.push(duckdb::types::Value::BigInt(limit as i64));
        all.push(duckdb::types::Value::BigInt(offset as i64));
        let mut stmt = self
            .connection
            .prepare(&format!(
                "SELECT {select} FROM {from}{wh} ORDER BY {order} LIMIT ? OFFSET ?"
            ))
            .map_err(|e| e.to_string())?;
        let count = meta.columns.len() + usize::from(identity == ["rowid"]);
        let raw = stmt
            .query_map(duckdb::params_from_iter(all.iter()), |r| {
                Ok((0..count)
                    .map(|i| duck_value(r.get::<_, duckdb::types::Value>(i).unwrap()))
                    .collect::<Vec<_>>())
            })
            .map_err(|e| e.to_string())?;
        let mut rows = vec![];
        let mut identities = vec![];
        for row in raw {
            let mut row = row.map_err(|e| e.to_string())?;
            if identity == ["rowid"] {
                identities.push(vec![row.pop().unwrap()])
            } else {
                identities.push(
                    identity
                        .iter()
                        .map(|name| {
                            row[meta.columns.iter().position(|c| &c.name == name).unwrap()].clone()
                        })
                        .collect(),
                )
            }
            rows.push(row)
        }
        Ok(Page {
            columns: meta.columns,
            rows,
            identities,
            total,
            offset,
            limit,
        })
    }
}

fn open(path: &Path, write: bool) -> Result<Connection, String> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let c = Connection::open_with_flags(path, flags).map_err(|e| e.to_string())?;
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
    Ok(c)
}
fn names(c: &Connection) -> Result<HashSet<String>, String> {
    let mut s=c.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").map_err(|e|e.to_string())?;
    let it = s.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
    it.collect::<Result<_, _>>().map_err(|e| e.to_string())
}
fn ensure_table(c: &Connection, name: &str) -> Result<(), String> {
    if names(c)?.contains(name) {
        Ok(())
    } else {
        Err(format!("Table or view {name:?} does not exist"))
    }
}
pub fn objects(path: &Path) -> Result<Vec<DbObject>, String> {
    let c = open(path, false)?;
    let mut s=c.prepare("SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY lower(name)").map_err(|e|e.to_string())?;
    let rows = s
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for x in rows {
        let (name, object_type) = x.map_err(|e| e.to_string())?;
        let row_count = c
            .query_row(&format!("SELECT count(*) FROM {}", q(&name)), [], |r| {
                r.get::<_, u64>(0)
            })
            .ok();
        out.push(DbObject {
            name,
            object_type,
            row_count,
        })
    }
    Ok(out)
}
pub fn schema(path: &Path, table: &str) -> Result<TableSchema, String> {
    let c = open(path, false)?;
    ensure_table(&c, table)?;
    let sql: Option<String> = c
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name=?1",
            [table],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut s = c
        .prepare(&format!("PRAGMA table_xinfo({})", q(table)))
        .map_err(|e| e.to_string())?;
    let columns = s
        .query_map([], |r| {
            Ok(Column {
                name: r.get(1)?,
                declared_type: r.get::<_, String>(2).unwrap_or_default(),
                nullable: r.get::<_, i64>(3)? == 0,
                default_value: r.get(4)?,
                primary_key_position: r.get::<_, i64>(5)? as u32,
                generated: r.get::<_, i64>(6).unwrap_or(0) != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut f = c
        .prepare(&format!("PRAGMA foreign_key_list({})", q(table)))
        .map_err(|e| e.to_string())?;
    let raw = f
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut foreign_keys: Vec<ForeignKey> = vec![];
    for row in raw {
        let (id, _seq, target, from, to, on_update, on_delete) = row.map_err(|e| e.to_string())?;
        if let Some(x) = foreign_keys.iter_mut().find(|x| x.id == id) {
            x.from_columns.push(from);
            x.target_columns.push(to)
        } else {
            foreign_keys.push(ForeignKey {
                id,
                from_columns: vec![from],
                target_table: target,
                target_columns: vec![to],
                on_update,
                on_delete,
            })
        }
    }
    Ok(TableSchema {
        name: table.into(),
        columns,
        foreign_keys,
        without_rowid: sql
            .unwrap_or_default()
            .to_uppercase()
            .contains("WITHOUT ROWID"),
    })
}
pub fn page(
    path: &Path,
    table: &str,
    offset: u64,
    limit: u64,
    sorts: &[Sort],
    filters: &[Filter],
) -> Result<Page, String> {
    if limit == 0 || limit > 1000 {
        return Err("Page size must be between 1 and 1000".into());
    }
    let c = open(path, false)?;
    let meta = schema(path, table)?;
    let cols: HashSet<_> = meta.columns.iter().map(|x| x.name.as_str()).collect();
    for x in sorts
        .iter()
        .map(|x| x.column.as_str())
        .chain(filters.iter().map(|x| x.column.as_str()))
    {
        if !cols.contains(x) {
            return Err(format!("Unknown column {x:?}"));
        }
    }
    let mut binds: Vec<SqlValue> = vec![];
    let mut predicates = vec![];
    for f in filters {
        let col = q(&f.column);
        let p = match f.operator {
            FilterOperator::IsNull => format!("{col} IS NULL"),
            FilterOperator::IsNotNull => format!("{col} IS NOT NULL"),
            FilterOperator::Eq
            | FilterOperator::Ne
            | FilterOperator::Lt
            | FilterOperator::Lte
            | FilterOperator::Gt
            | FilterOperator::Gte => {
                binds.push(f.value.as_ref().ok_or("Filter value is required")?.sql()?);
                format!(
                    "{col} {} ?",
                    match f.operator {
                        FilterOperator::Eq => "=",
                        FilterOperator::Ne => "<>",
                        FilterOperator::Lt => "<",
                        FilterOperator::Lte => "<=",
                        FilterOperator::Gt => ">",
                        _ => ">=",
                    }
                )
            }
            FilterOperator::Contains | FilterOperator::StartsWith => {
                let raw = match f.value.as_ref() {
                    Some(DataValue::Text(x)) => x,
                    _ => return Err("Text filter value is required".into()),
                };
                binds.push(SqlValue::Text(
                    if matches!(f.operator, FilterOperator::Contains) {
                        format!("%{raw}%")
                    } else {
                        format!("{raw}%")
                    },
                ));
                format!("{col} LIKE ? ESCAPE '\\'")
            }
        };
        predicates.push(p)
    }
    let wh = if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", predicates.join(" AND "))
    };
    let total = c
        .query_row(
            &format!("SELECT count(*) FROM {}{wh}", q(table)),
            params_from_iter(binds.iter()),
            |r| r.get::<_, u64>(0),
        )
        .map_err(|e| e.to_string())?;
    let pk: Vec<_> = meta
        .columns
        .iter()
        .filter(|x| x.primary_key_position > 0)
        .map(|x| x.name.clone())
        .collect();
    let identity = if pk.is_empty() && !meta.without_rowid {
        vec!["rowid".into()]
    } else {
        pk
    };
    let select = meta
        .columns
        .iter()
        .map(|x| q(&x.name))
        .chain((identity.first().map(|x| x == "rowid").unwrap_or(false)).then(|| "rowid".into()))
        .collect::<Vec<_>>()
        .join(",");
    let order = if sorts.is_empty() {
        format!(
            " ORDER BY {}",
            identity.iter().map(|x| q(x)).collect::<Vec<_>>().join(",")
        )
    } else {
        format!(
            " ORDER BY {}",
            sorts
                .iter()
                .map(|x| format!(
                    "{} {}",
                    q(&x.column),
                    if x.descending { "DESC" } else { "ASC" }
                ))
                .chain(identity.iter().map(|x| format!("{} ASC", q(x))))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let sql = format!(
        "SELECT {select} FROM {}{wh}{order} LIMIT ? OFFSET ?",
        q(table)
    );
    let mut all = binds;
    all.push(SqlValue::Integer(limit.min(1000) as i64));
    all.push(SqlValue::Integer(offset as i64));
    let mut s = c.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = s
        .query_map(params_from_iter(all.iter()), |r| {
            Ok((0..r.as_ref().column_count())
                .map(|i| value(r.get_ref(i).unwrap()))
                .collect::<Vec<_>>())
        })
        .map_err(|e| e.to_string())?;
    let mut data = vec![];
    let mut identities = vec![];
    for row in rows {
        let mut row = row.map_err(|e| e.to_string())?;
        if identity == ["rowid"] {
            identities.push(vec![row.pop().unwrap()])
        } else {
            identities.push(
                identity
                    .iter()
                    .map(|name| {
                        row[meta.columns.iter().position(|x| &x.name == name).unwrap()].clone()
                    })
                    .collect(),
            )
        }
        data.push(row)
    }
    Ok(Page {
        columns: meta.columns,
        rows: data,
        identities,
        total,
        offset,
        limit: limit.min(1000),
    })
}
pub fn query(path: &Path, sql: &str) -> Result<QueryResult, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() || trimmed.contains(';') && trimmed.trim_end_matches(';').contains(';') {
        return Err("Exactly one query statement is required".into());
    }
    let first = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if !matches!(first.as_str(), "SELECT" | "WITH" | "VALUES" | "EXPLAIN") {
        return Err("Only read-only queries are allowed".into());
    }
    let c = open(path, false)?;
    c.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|e| e.to_string())?;
    let mut s = c.prepare(trimmed).map_err(|e| e.to_string())?;
    if !s.readonly() {
        return Err("Only read-only queries are allowed".into());
    }
    let columns = s.column_names().iter().map(|x| x.to_string()).collect();
    let rows = s
        .query_map([], |r| {
            Ok((0..r.as_ref().column_count())
                .map(|i| value(r.get_ref(i).unwrap()))
                .collect())
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(QueryResult { columns, rows })
}
fn mutation(
    path: &Path,
    table: &str,
    values: &[NamedValue],
    identity: &[DataValue],
    delete: bool,
) -> Result<u64, String> {
    let mut c = open(path, true)?;
    ensure_table(&c, table)?;
    let meta = schema(path, table)?;
    let known: HashSet<_> = meta.columns.iter().map(|x| x.name.as_str()).collect();
    if values.iter().any(|v| {
        !known.contains(v.column.as_str())
            || meta
                .columns
                .iter()
                .any(|x| x.name == v.column && x.generated)
    }) {
        return Err("Unknown or generated column".into());
    }
    let keys: Vec<_> = meta
        .columns
        .iter()
        .filter(|x| x.primary_key_position > 0)
        .map(|x| x.name.clone())
        .collect();
    let keys = if keys.is_empty() && !meta.without_rowid {
        vec!["rowid".into()]
    } else {
        keys
    };
    if keys.len() != identity.len() {
        return Err("Row identity does not match the primary key".into());
    }
    let wh = keys
        .iter()
        .map(|x| format!("{} IS ?", q(x)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let (sql, binds) = if delete {
        (
            format!("DELETE FROM {} WHERE {wh}", q(table)),
            identity
                .iter()
                .map(DataValue::sql)
                .collect::<Result<Vec<_>, _>>()?,
        )
    } else {
        if values.is_empty() {
            return Err("No values to update".into());
        }
        let mut b = values
            .iter()
            .map(|x| x.value.sql())
            .collect::<Result<Vec<_>, _>>()?;
        b.extend(
            identity
                .iter()
                .map(DataValue::sql)
                .collect::<Result<Vec<_>, _>>()?,
        );
        (
            format!(
                "UPDATE {} SET {} WHERE {wh}",
                q(table),
                values
                    .iter()
                    .map(|x| format!("{}=?", q(&x.column)))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            b,
        )
    };
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let n = tx
        .execute(&sql, params_from_iter(binds.iter()))
        .map_err(|e| e.to_string())?;
    if n != 1 {
        return Err(format!("Expected one row, changed {n}"));
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n as u64)
}
pub fn insert(path: &Path, table: &str, values: &[NamedValue]) -> Result<Vec<DataValue>, String> {
    let mut c = open(path, true)?;
    ensure_table(&c, table)?;
    let meta = schema(path, table)?;
    let valid: HashSet<_> = meta
        .columns
        .iter()
        .filter(|x| !x.generated)
        .map(|x| x.name.as_str())
        .collect();
    if values.iter().any(|x| !valid.contains(x.column.as_str())) {
        return Err("Unknown or generated column".into());
    }
    let keys: Vec<String> = meta
        .columns
        .iter()
        .filter(|x| x.primary_key_position > 0)
        .map(|x| x.name.clone())
        .collect();
    let returning = if keys.is_empty() && !meta.without_rowid {
        "rowid".into()
    } else if keys.is_empty() {
        return Err("WITHOUT ROWID tables require a primary key".into());
    } else {
        keys.iter().map(|x| q(x)).collect::<Vec<_>>().join(",")
    };
    let base = if values.is_empty() {
        format!("INSERT INTO {} DEFAULT VALUES", q(table))
    } else {
        format!(
            "INSERT INTO {} ({}) VALUES ({})",
            q(table),
            values
                .iter()
                .map(|x| q(&x.column))
                .collect::<Vec<_>>()
                .join(","),
            vec!["?"; values.len()].join(",")
        )
    };
    let sql = format!("{base} RETURNING {returning}");
    let binds = values
        .iter()
        .map(|x| x.value.sql())
        .collect::<Result<Vec<_>, _>>()?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let id = tx
        .query_row(&sql, params_from_iter(binds.iter()), |r| {
            Ok((0..r.as_ref().column_count())
                .map(|i| value(r.get_ref(i).unwrap()))
                .collect())
        })
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
pub fn update(
    path: &Path,
    table: &str,
    values: &[NamedValue],
    identity: &[DataValue],
) -> Result<u64, String> {
    mutation(path, table, values, identity, false)
}
pub fn delete(path: &Path, table: &str, identity: &[DataValue]) -> Result<u64, String> {
    mutation(path, table, &[], identity, true)
}
pub fn execute_ddl(path: &Path, sql: &str) -> Result<(), String> {
    let upper = sql.trim_start().to_ascii_uppercase();
    if !(upper.starts_with("CREATE TABLE ") || upper.starts_with("ALTER TABLE "))
        || sql.contains(';') && sql.trim_end_matches(';').contains(';')
    {
        return Err("Only one CREATE TABLE or ALTER TABLE statement is allowed".into());
    }
    let mut c = open(path, true)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(sql).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn safe_expression(value: &str) -> Result<&str, String> {
    let bad = [';'];
    if value.trim().is_empty()
        || bad.iter().any(|x| value.contains(*x))
        || value.contains("--")
        || value.contains("/*")
    {
        Err("Unsafe or empty SQL expression".into())
    } else {
        Ok(value)
    }
}
fn column_sql(c: &CreateColumn) -> Result<String, String> {
    if c.name.trim().is_empty() {
        return Err("Column name is required".into());
    }
    let affinity = c.declared_type.trim().to_ascii_uppercase();
    if !matches!(
        affinity.as_str(),
        "INTEGER" | "REAL" | "TEXT" | "BLOB" | "NUMERIC" | ""
    ) {
        return Err("Unsupported SQLite affinity".into());
    }
    let mut out = format!("{} {}", q(&c.name), affinity);
    if !c.nullable {
        out.push_str(" NOT NULL")
    }
    if c.unique {
        out.push_str(" UNIQUE")
    }
    if let Some(v) = &c.default_expression {
        out.push_str(" DEFAULT ");
        out.push_str(safe_expression(v)?)
    }
    if let Some(v) = &c.generated_expression {
        out.push_str(" GENERATED ALWAYS AS (");
        out.push_str(safe_expression(v)?);
        out.push(')')
    }
    Ok(out)
}
pub fn create_table(path: &Path, spec: &CreateTable) -> Result<(), String> {
    if spec.name.trim().is_empty() || spec.columns.is_empty() {
        return Err("A table name and at least one column are required".into());
    }
    let mut seen = HashSet::new();
    if spec
        .columns
        .iter()
        .any(|c| !seen.insert(c.name.to_ascii_lowercase()))
    {
        return Err("Column names must be unique".into());
    }
    let mut defs = spec
        .columns
        .iter()
        .map(column_sql)
        .collect::<Result<Vec<_>, _>>()?;
    let mut pk = spec
        .columns
        .iter()
        .filter(|c| c.primary_key_position > 0)
        .collect::<Vec<_>>();
    pk.sort_by_key(|c| c.primary_key_position);
    if !pk.is_empty() {
        defs.push(format!(
            "PRIMARY KEY ({})",
            pk.iter().map(|c| q(&c.name)).collect::<Vec<_>>().join(",")
        ))
    }
    for f in &spec.foreign_keys {
        if f.columns.is_empty()
            || f.columns.len() != f.target_columns.len()
            || f.columns
                .iter()
                .any(|x| !seen.contains(&x.to_ascii_lowercase()))
        {
            return Err("Invalid foreign key".into());
        }
        let action = |v: &Option<String>| -> Result<String, String> {
            let x = v.as_deref().unwrap_or("NO ACTION").to_ascii_uppercase();
            if matches!(
                x.as_str(),
                "NO ACTION" | "RESTRICT" | "SET NULL" | "SET DEFAULT" | "CASCADE"
            ) {
                Ok(x)
            } else {
                Err("Invalid foreign-key action".into())
            }
        };
        defs.push(format!(
            "FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
            f.columns.iter().map(|x| q(x)).collect::<Vec<_>>().join(","),
            q(&f.target_table),
            f.target_columns
                .iter()
                .map(|x| q(x))
                .collect::<Vec<_>>()
                .join(","),
            action(&f.on_update)?,
            action(&f.on_delete)?
        ))
    }
    for check in &spec.checks {
        defs.push(format!("CHECK ({})", safe_expression(check)?))
    }
    let sql = format!(
        "CREATE TABLE {} ({}){}",
        q(&spec.name),
        defs.join(","),
        if spec.without_rowid {
            " WITHOUT ROWID"
        } else {
            ""
        }
    );
    execute_ddl(path, &sql)
}
pub fn alter_table(path: &Path, table: &str, op: &AlterTable) -> Result<(), String> {
    let c = open(path, false)?;
    ensure_table(&c, table)?;
    let sql = match op {
        AlterTable::RenameTable { new_name } => {
            format!("ALTER TABLE {} RENAME TO {}", q(table), q(new_name))
        }
        AlterTable::RenameColumn { column, new_name } => format!(
            "ALTER TABLE {} RENAME COLUMN {} TO {}",
            q(table),
            q(column),
            q(new_name)
        ),
        AlterTable::AddColumn { column } => format!(
            "ALTER TABLE {} ADD COLUMN {}",
            q(table),
            column_sql(column)?
        ),
        AlterTable::DropColumn { column } => {
            format!("ALTER TABLE {} DROP COLUMN {}", q(table), q(column))
        }
    };
    execute_ddl(path, &sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::{
        collections::BTreeSet,
        sync::{Arc, Mutex},
    };
    use uuid::Uuid;
    fn db() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("ixtable-data-test-{}.db", Uuid::new_v4()));
        Connection::open(&p).unwrap().execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parent(a TEXT,b INTEGER,payload BLOB,computed TEXT GENERATED ALWAYS AS (a || b) STORED,PRIMARY KEY(a,b)); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_a TEXT,parent_b INTEGER,FOREIGN KEY(parent_a,parent_b) REFERENCES parent(a,b));").unwrap();
        p
    }
    #[test]
    fn crud_composite_keys_blobs_and_generated_columns() {
        let p = db();
        let identity = insert(
            &p,
            "parent",
            &[
                NamedValue {
                    column: "a".into(),
                    value: DataValue::Text("x".into()),
                },
                NamedValue {
                    column: "b".into(),
                    value: DataValue::Integer(2),
                },
                NamedValue {
                    column: "payload".into(),
                    value: DataValue::Blob(STANDARD.encode([0, 255])),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            identity,
            vec![DataValue::Text("x".into()), DataValue::Integer(2)]
        );
        update(
            &p,
            "parent",
            &[NamedValue {
                column: "payload".into(),
                value: DataValue::Null,
            }],
            &identity,
        )
        .unwrap();
        let got = page(&p, "parent", 0, 20, &[], &[]).unwrap();
        assert_eq!(got.total, 1);
        assert_eq!(got.rows[0][2], DataValue::Null);
        assert_eq!(got.rows[0][3], DataValue::Text("x2".into()));
        assert!(update(
            &p,
            "parent",
            &[NamedValue {
                column: "computed".into(),
                value: DataValue::Text("bad".into())
            }],
            &identity
        )
        .is_err());
        delete(&p, "parent", &identity).unwrap();
        assert_eq!(objects(&p).unwrap()[1].row_count, Some(0));
        let _ = std::fs::remove_file(p);
    }
    #[test]
    fn readonly_sql_and_foreign_keys_are_enforced() {
        let p = db();
        assert!(query(&p, "DELETE FROM parent").is_err());
        assert!(query(&p, "SELECT 1; SELECT 2").is_err());
        let bad = insert(
            &p,
            "child",
            &[
                NamedValue {
                    column: "parent_a".into(),
                    value: DataValue::Text("missing".into()),
                },
                NamedValue {
                    column: "parent_b".into(),
                    value: DataValue::Integer(1),
                },
            ],
        );
        assert!(bad.is_err());
        assert_eq!(
            query(&p, "SELECT count(*) AS n FROM child").unwrap().rows[0][0],
            DataValue::Integer(0)
        );
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn duckdb_reader_is_session_serializable_and_keeps_full_width_values() {
        // A document session owns one runtime behind its session mutex. This test
        // deliberately moves that runtime to another thread: a path-based reader
        // accidentally introduced in its place would not satisfy this contract.
        let runtime = Arc::new(Mutex::new(ReadRuntime::isolated_for_test().unwrap()));
        let worker = Arc::clone(&runtime);
        let result=std::thread::spawn(move||{
   let guard=worker.lock().unwrap();
   guard.connection().query_row(
    "SELECT CAST(9223372036854775807 AS BIGINT), CAST(-9223372036854775808 AS BIGINT), CAST('00FF' AS BLOB)",[],
    |row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,Vec<u8>>(2)?))
   ).unwrap()
  }).join().unwrap();
        assert_eq!(result.0, i64::MAX);
        assert_eq!(result.1, i64::MIN);
        assert_eq!(result.2, b"00FF");
    }

    #[test]
    fn duckdb_reader_rejects_extension_autoload() {
        let runtime = ReadRuntime::isolated_for_test().unwrap();
        let error = runtime
            .connection()
            .execute_batch("LOAD definitely_not_an_installed_extension")
            .unwrap_err()
            .to_string();
        assert!(error.to_ascii_lowercase().contains("extension"));
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn bundled_signed_extension_attaches_offline_and_refreshes_after_sqlite_commit() {
        let workspace =
            std::env::temp_dir().join(format!("ixtable-duckdb-attach-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let db_path = workspace.join("data.db");
        Connection::open(&db_path).unwrap().execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY,label TEXT); INSERT INTO item VALUES(1,'before');").unwrap();
        let extension = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/duckdb/macos-arm64/sqlite_scanner.duckdb_extension");
        let mut runtime = ReadRuntime::new(&workspace, &extension).unwrap();
        assert_eq!(runtime.objects().unwrap()[0].row_count, Some(1));
        let first = runtime.page("item", 0, 10, &[], &[]).unwrap();
        assert_eq!(first.total, 1);
        assert_eq!(first.identities[0], vec![DataValue::Integer(1)]);
        assert_eq!(
            runtime
                .query("SELECT label FROM item ORDER BY id")
                .unwrap()
                .rows[0][0],
            DataValue::Text("before".into())
        );
        for unsafe_sql in [
            "DELETE FROM item",
            "SELECT * FROM read_csv('/tmp/private.csv')",
            "ATTACH '/tmp/other.db' AS other",
            "WITH changed AS (DELETE FROM item RETURNING *) SELECT * FROM changed",
            "SELECT 1; SELECT 2",
        ] {
            assert!(
                runtime.query(unsafe_sql).is_err(),
                "unsafe SQL was accepted: {unsafe_sql}"
            )
        }
        Connection::open(&db_path)
            .unwrap()
            .execute("INSERT INTO item VALUES(2,'after')", [])
            .unwrap();
        runtime.refresh().unwrap();
        assert_eq!(runtime.objects().unwrap()[0].row_count, Some(2));
        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn sqlite_writes_return_database_generated_identity_and_defaults() {
        let p = std::env::temp_dir().join(format!("ixtable-default-test-{}.db", Uuid::new_v4()));
        Connection::open(&p).unwrap().execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL DEFAULT 'new');").unwrap();
        let identity = insert(&p, "item", &[]).unwrap();
        assert_eq!(identity.len(), 1);
        assert!(matches!(identity[0],DataValue::Integer(v) if v>0));
        let got = page(&p, "item", 0, 10, &[], &[]).unwrap();
        assert_eq!(got.rows[0][1], DataValue::Text("new".into()));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn sqlite_validation_and_constraint_failures_leave_no_partial_state() {
        let p = db();
        let invalid_blob = insert(
            &p,
            "parent",
            &[
                NamedValue {
                    column: "a".into(),
                    value: DataValue::Text("x".into()),
                },
                NamedValue {
                    column: "b".into(),
                    value: DataValue::Integer(1),
                },
                NamedValue {
                    column: "payload".into(),
                    value: DataValue::Blob("not base64!".into()),
                },
            ],
        );
        assert!(invalid_blob.is_err());
        assert_eq!(page(&p, "parent", 0, 10, &[], &[]).unwrap().total, 0);
        assert!(insert(
            &p,
            "child",
            &[
                NamedValue {
                    column: "parent_a".into(),
                    value: DataValue::Text("missing".into())
                },
                NamedValue {
                    column: "parent_b".into(),
                    value: DataValue::Integer(1)
                }
            ]
        )
        .is_err());
        assert_eq!(page(&p, "child", 0, 10, &[], &[]).unwrap().total, 0);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn paging_validates_bounds_columns_and_stabilizes_composite_identity() {
        let p = db();
        for (a, b) in [("b", 2), ("a", 2), ("a", 1)] {
            insert(
                &p,
                "parent",
                &[
                    NamedValue {
                        column: "a".into(),
                        value: DataValue::Text(a.into()),
                    },
                    NamedValue {
                        column: "b".into(),
                        value: DataValue::Integer(b),
                    },
                ],
            )
            .unwrap();
        }
        assert!(page(&p, "parent", 0, 0, &[], &[]).is_err());
        assert!(page(&p, "parent", 0, 1001, &[], &[]).is_err());
        assert!(page(
            &p,
            "parent",
            0,
            10,
            &[Sort {
                column: "missing".into(),
                descending: false
            }],
            &[]
        )
        .is_err());
        let got = page(
            &p,
            "parent",
            0,
            10,
            &[Sort {
                column: "a".into(),
                descending: false,
            }],
            &[],
        )
        .unwrap();
        assert_eq!(
            got.identities,
            vec![
                vec![DataValue::Text("a".into()), DataValue::Integer(1)],
                vec![DataValue::Text("a".into()), DataValue::Integer(2)],
                vec![DataValue::Text("b".into()), DataValue::Integer(2)]
            ]
        );
        let _ = std::fs::remove_file(p);
    }

    proptest! {
     #![proptest_config(ProptestConfig { cases: 64, max_shrink_iters: 2_048, ..ProptestConfig::default() })]

     /// Values crossing the command boundary must survive a complete
     /// rusqlite write/read cycle without narrowing, lossy text conversion, or
     /// blob reinterpretation.
     #[test]
     fn prop_sqlite_scalar_round_trip(
      integer in any::<i64>(),
      text in any::<String>(),
      blob in prop::collection::vec(any::<u8>(),0..256),
      real in any::<f64>().prop_filter("finite SQLite real",|v|v.is_finite())
     ) {
      let p=std::env::temp_dir().join(format!("ixtable-prop-values-{}.db",Uuid::new_v4()));
      Connection::open(&p).unwrap().execute_batch("CREATE TABLE values_under_test(id INTEGER PRIMARY KEY, text_value TEXT, blob_value BLOB, real_value REAL);").unwrap();
      let identity=insert(&p,"values_under_test",&[
       NamedValue{column:"id".into(),value:DataValue::Integer(integer)},
       NamedValue{column:"text_value".into(),value:DataValue::Text(text.clone())},
       NamedValue{column:"blob_value".into(),value:DataValue::Blob(STANDARD.encode(&blob))},
       NamedValue{column:"real_value".into(),value:DataValue::Real(real)},
      ]).unwrap();
      prop_assert_eq!(identity,vec![DataValue::Integer(integer)]);
      let got=page(&p,"values_under_test",0,1,&[],&[]).unwrap();
      prop_assert_eq!(&got.rows[0][0],&DataValue::Integer(integer));
      prop_assert_eq!(&got.rows[0][1],&DataValue::Text(text));
      prop_assert_eq!(&got.rows[0][2],&DataValue::Blob(STANDARD.encode(blob)));
      prop_assert_eq!(&got.rows[0][3],&DataValue::Real(real));
      let _=std::fs::remove_file(p);
     }

     /// DuckDB must preserve the complete identity integer domain used by the
     /// SQLite writer; otherwise the reader could return identities that cannot
     /// address the row that was written.
     #[test]
     fn prop_duckdb_preserves_sqlite_identity_domain(integer in any::<i64>()) {
      let runtime=ReadRuntime::isolated_for_test().unwrap();
      let sql=format!("SELECT CAST({integer} AS BIGINT)");
      let observed=runtime.connection().query_row(&sql,[],|row|row.get::<_,i64>(0)).unwrap();
      prop_assert_eq!(observed,integer);
     }

     /// Every discovered identifier is quoted by the backend. Quotes,
     /// whitespace, punctuation, and SQL-looking names must remain data rather
     /// than becoming executable syntax.
     #[test]
     fn prop_quoted_identifiers_are_safe(
      table in "[^\\x00]{1,24}",
      column in "[^\\x00]{1,24}"
     ) {
      prop_assume!(!table.trim().is_empty()&&!column.trim().is_empty());
      let p=std::env::temp_dir().join(format!("ixtable-prop-ident-{}.db",Uuid::new_v4()));
      Connection::open(&p).unwrap().execute_batch("CREATE TABLE sentinel(value INTEGER); INSERT INTO sentinel VALUES(1);").unwrap();
      let spec=CreateTable{name:table.clone(),columns:vec![CreateColumn{name:column.clone(),declared_type:"TEXT".into(),nullable:true,primary_key_position:0,unique:false,default_expression:None,generated_expression:None}],foreign_keys:vec![],checks:vec![],without_rowid:false};
      match create_table(&p,&spec) {
       Ok(())=>{
        insert(&p,&table,&[NamedValue{column:column.clone(),value:DataValue::Text("payload".into())}]).unwrap();
        let got=page(&p,&table,0,10,&[],&[]).unwrap();
        prop_assert_eq!(&got.rows[0][0],&DataValue::Text("payload".into()));
       },
       // Arbitrary names may collide with SQLite's case-insensitive sentinel;
       // rejection is safe, execution as additional SQL is not.
       Err(_)=>{}
      }
      let sentinel: i64=Connection::open(&p).unwrap().query_row("SELECT value FROM sentinel",[],|r|r.get(0)).unwrap();
      prop_assert_eq!(sentinel,1);
      let _=std::fs::remove_file(p);
     }

     /// User sorting may contain ties. Appended composite identity columns must
     /// make page order total, repeatable, and independent of insertion order.
     #[test]
     fn prop_composite_identity_stabilizes_pagination(
      input in prop::collection::vec(("[a-z]{1,5}",-1000i64..1000),0..80),
      descending in any::<bool>()
     ) {
      let unique=input.into_iter().collect::<BTreeSet<_>>();
      let p=db();
      for (a,b) in unique.iter().rev(){insert(&p,"parent",&[NamedValue{column:"a".into(),value:DataValue::Text(a.clone())},NamedValue{column:"b".into(),value:DataValue::Integer(*b)}]).unwrap();}
      let sorts=[Sort{column:"a".into(),descending}];
      let first=page(&p,"parent",0,100,&sorts,&[]).unwrap();
      let second=page(&p,"parent",0,100,&sorts,&[]).unwrap();
      prop_assert_eq!(&first.identities,&second.identities);
      let observed=first.identities.iter().map(|id|match (&id[0],&id[1]){(DataValue::Text(a),DataValue::Integer(b))=>(a.clone(),*b),_=>unreachable!()}).collect::<Vec<_>>();
      let mut expected=unique.into_iter().collect::<Vec<_>>();
      expected.sort_by(|left,right|{let primary=if descending{right.0.cmp(&left.0)}else{left.0.cmp(&right.0)};primary.then_with(||left.1.cmp(&right.1))});
      prop_assert_eq!(observed,expected);
      let _=std::fs::remove_file(p);
     }

     /// A stale or malformed identity can never change a different record.
     #[test]
     fn prop_stale_identity_never_mutates_rows(original in any::<i64>(),stale in any::<i64>(),replacement in any::<i64>()) {
      prop_assume!(original!=stale);
      let p=std::env::temp_dir().join(format!("ixtable-prop-stale-{}.db",Uuid::new_v4()));
      Connection::open(&p).unwrap().execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);").unwrap();
      insert(&p,"item",&[NamedValue{column:"id".into(),value:DataValue::Integer(original)},NamedValue{column:"value".into(),value:DataValue::Integer(original)}]).unwrap();
      let stale_result=update(&p,"item",&[NamedValue{column:"value".into(),value:DataValue::Integer(replacement)}],&[DataValue::Integer(stale)]);
      prop_assert!(stale_result.is_err());
      let got=page(&p,"item",0,10,&[],&[]).unwrap();
      prop_assert_eq!(&got.rows[0][1],&DataValue::Integer(original));
      let _=std::fs::remove_file(p);
     }
    }
}
