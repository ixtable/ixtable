//! `ReadRuntime`: the session's DuckDB reader (PRD §10). Every app read —
//! object lists, table inspection, record pages, saved queries — runs here,
//! over the embedded SQLite file or an attached PostgreSQL database. Writes
//! never enter this connection.
use super::logical::LogicalType;
use super::support::{logical_from_duckdb, postgres_extension_path, redact};
use super::{
    ddl::{self, TableDef},
    duck_value, q, read_only_guard, DataValue, DbObject, QueryResult, TableSchema,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

/// What the reader's `data` catalog is attached to.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadTarget {
    /// `<workspace>/data.db` through the bundled sqlite_scanner.
    Sqlite,
    /// A PostgreSQL database through the bundled postgres_scanner.
    Postgres {
        /// libpq connection string (contains the credential; never logged).
        conninfo: String,
        schema: String,
    },
}

/// Session-scoped DuckDB reader. Production callers pass the signed extension
/// copied from the application resources; no extension may be auto-installed.
pub struct ReadRuntime {
    pub workspace: PathBuf,
    pub(super) connection: duckdb::Connection,
    pub(super) target: ReadTarget,
    postgres_loaded: bool,
    /// Set when the configured datasource could not be attached; reads fail with this message (code CONNECTION) instead of silently reading the embedded file.
    attach_error: Option<String>,
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
            target: ReadTarget::Sqlite,
            postgres_loaded: false,
            attach_error: None,
        };
        runtime.refresh()?;
        Ok(runtime)
    }
    pub fn target(&self) -> &ReadTarget {
        &self.target
    }
    pub fn attach_error(&self) -> Option<&str> {
        self.attach_error.as_deref()
    }
    /// Points the reader at another datasource. A failed attach is remembered (see `attach_error`) and also returned.
    pub fn set_target(&mut self, target: ReadTarget) -> Result<(), String> {
        if target == self.target && self.attach_error.is_none() {
            return Ok(());
        }
        self.target = target;
        let result = self.refresh();
        self.attach_error = result.as_ref().err().cloned();
        result
    }
    pub(super) fn schema_name(&self) -> &str {
        match &self.target {
            ReadTarget::Sqlite => "main",
            ReadTarget::Postgres { schema, .. } => schema,
        }
    }
    fn ensure_postgres_extension(&mut self) -> Result<(), String> {
        if self.postgres_loaded {
            return Ok(());
        }
        let path = postgres_extension_path()?;
        let extension = path.to_string_lossy().replace('\'', "''");
        self.connection
            .execute_batch(&format!("LOAD '{extension}'"))
            .map_err(|e| format!("PostgreSQL extension startup: {e}"))?;
        self.postgres_loaded = true;
        Ok(())
    }
    /// Re-attaches the datasource so DuckDB sees committed writes and DDL.
    pub fn refresh(&mut self) -> Result<(), String> {
        let _ = self.connection.execute_batch("USE memory; DETACH data");
        let result = match self.target.clone() {
            ReadTarget::Sqlite => {
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
            ReadTarget::Postgres { conninfo, schema } => {
                self.ensure_postgres_extension()?;
                self.connection
                    .execute_batch(&format!(
                        "ATTACH '{}' AS data (TYPE POSTGRES, READ_ONLY, SCHEMA '{}'); USE data.{}",
                        conninfo.replace('\'', "''"),
                        schema.replace('\'', "''"),
                        q(&schema)
                    ))
                    .map_err(|e| {
                        format!("PostgreSQL connection failed: {}", redact(&e.to_string()))
                    })
            }
        };
        self.attach_error = result.as_ref().err().cloned();
        result
    }
    pub fn connection(&self) -> &duckdb::Connection {
        &self.connection
    }
    fn ready(&self) -> Result<(), String> {
        match &self.attach_error {
            Some(e) => Err(format!("Datasource unavailable: {e}")),
            None => Ok(()),
        }
    }
    /// The attached SQLite file's schema table, read through the sqlite scanner.
    fn sqlite_master(&self) -> String {
        let path = self
            .workspace
            .join("data.db")
            .to_string_lossy()
            .replace('\'', "''");
        format!("sqlite_scan('{path}', 'sqlite_master')")
    }
    pub(super) fn from(&self, table: &str) -> String {
        format!("data.{}.{}", q(self.schema_name()), q(table))
    }

    pub fn objects(&self) -> Result<Vec<DbObject>, String> {
        self.ready()?;
        let mut stmt = self
            .connection
            .prepare(
                "SELECT table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END \
                 FROM information_schema.tables WHERE table_catalog='data' AND table_schema=? \
                 AND table_name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                 AND table_name NOT LIKE '\\_ixtable\\_%' ESCAPE '\\' ORDER BY lower(table_name)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([self.schema_name()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out = vec![];
        for row in rows {
            let (name, object_type) = row.map_err(|e| e.to_string())?;
            let row_count = self
                .connection
                .query_row(
                    &format!("SELECT count(*) FROM {}", self.from(&name)),
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
    /// Counts rows of any table, including internal `_ixtable_` tables.
    pub fn row_count(&self, table: &str) -> Result<u64, String> {
        self.ready()?;
        self.connection
            .query_row(
                &format!("SELECT count(*) FROM {}", self.from(table)),
                [],
                |r| r.get::<_, u64>(0),
            )
            .map_err(|e| e.to_string())
    }
    pub fn query(&self, sql: &str) -> Result<QueryResult, String> {
        self.ready()?;
        let trimmed = read_only_guard(sql)?;
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
    fn table_exists(&self, table: &str) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables \
                 WHERE table_catalog='data' AND table_schema=? AND table_name=?",
                [self.schema_name(), table],
                |r| r.get::<_, String>(0),
            )
            .map(Some)
            .or_else(|e| match e {
                duckdb::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e.to_string()),
            })
    }
    /// The full definition (columns, keys, constraints, indexes) of a table or view.
    pub fn table_def(&self, table: &str) -> Result<TableDef, String> {
        self.ready()?;
        let Some(kind) = self.table_exists(table)? else {
            return Err(format!("Table or view {table:?} does not exist"));
        };
        let parsed = match &self.target {
            ReadTarget::Sqlite if kind == "table" => {
                let master = self.sqlite_master();
                let sql: Option<String> = self
                    .connection
                    .query_row(
                        &format!("SELECT sql FROM {master} WHERE type='table' AND name=?"),
                        [table],
                        |r| r.get(0),
                    )
                    .ok();
                let mut def = sql
                    .as_deref()
                    .map(ddl::parse_sqlite_create_table)
                    .transpose()?;
                if let Some(def) = def.as_mut() {
                    let mut stmt = self
                        .connection
                        .prepare(&format!("SELECT sql FROM {master} WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name"))
                        .map_err(|e| e.to_string())?;
                    let sqls = stmt
                        .query_map([table], |r| r.get::<_, String>(0))
                        .map_err(|e| e.to_string())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?;
                    for sql in sqls {
                        if let Ok(index) = ddl::parse_sqlite_create_index(&sql) {
                            def.indexes.push(index)
                        }
                    }
                }
                def
            }
            ReadTarget::Postgres { schema, .. } if kind == "table" => {
                let sql = crate::postgres::table_def_query(schema, table);
                let json: Option<String> = self
                    .connection
                    .query_row(
                        &format!(
                            "SELECT definition FROM postgres_query('data', '{}')",
                            sql.replace('\'', "''")
                        ),
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                let mut def = json
                    .map(|j| serde_json::from_str::<TableDef>(&j).map_err(|e| e.to_string()))
                    .transpose()?;
                for c in def.iter_mut().flat_map(|d| d.columns.iter_mut()) {
                    c.logical_type = LogicalType::from_postgres(&c.declared_type);
                }
                def
            }
            _ => None,
        };
        match parsed {
            Some(def) => Ok(def),
            None => self.def_from_information_schema(table),
        }
    }
    /// Views (and tables whose DDL cannot be read) are described from DuckDB's information schema; logical types come from DuckDB's column types.
    fn def_from_information_schema(&self, table: &str) -> Result<TableDef, String> {
        let mut stmt = self
            .connection
            .prepare(
                "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns \
                 WHERE table_catalog='data' AND table_schema=? AND table_name=? ORDER BY ordinal_position",
            )
            .map_err(|e| e.to_string())?;
        let columns = stmt
            .query_map([self.schema_name(), table], |r| {
                let data_type: String = r.get(1)?;
                Ok(ddl::ColumnDef {
                    name: r.get(0)?,
                    logical_type: logical_from_duckdb(&data_type),
                    declared_type: data_type,
                    nullable: r.get::<_, String>(2)? == "YES",
                    default_expression: r.get(3)?,
                    generated_expression: None,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut pk = self
            .connection
            .prepare("SELECT k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k USING (constraint_catalog,constraint_schema,constraint_name) WHERE t.table_catalog='data' AND t.table_schema=? AND t.table_name=? AND t.constraint_type='PRIMARY KEY' ORDER BY k.ordinal_position")
            .map_err(|e| e.to_string())?;
        let primary_key = pk
            .query_map([self.schema_name(), table], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(TableDef {
            name: table.into(),
            columns,
            primary_key,
            ..Default::default()
        })
    }
    /// Columns DuckDB can read (SQLite generated columns are not scanned).
    pub(super) fn duckdb_columns(&self, table: &str) -> Result<HashSet<String>, String> {
        let mut stmt = self
            .connection
            .prepare("SELECT column_name FROM information_schema.columns WHERE table_catalog='data' AND table_schema=? AND table_name=?")
            .map_err(|e| e.to_string())?;
        let names = stmt
            .query_map([self.schema_name(), table], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| e.to_string());
        names
    }
    pub fn schema(&self, table: &str) -> Result<TableSchema, String> {
        let def = self.table_def(table)?;
        let object_type = self.table_exists(table)?.unwrap_or_else(|| "table".into());
        Ok(TableSchema::from_def(def, object_type))
    }
    #[cfg(test)]
    pub(crate) fn isolated_for_test() -> Result<Self, String> {
        let config = duckdb::Config::default()
            .enable_autoload_extension(false)
            .map_err(|e| e.to_string())?;
        let connection =
            duckdb::Connection::open_in_memory_with_flags(config).map_err(|e| e.to_string())?;
        Ok(Self {
            workspace: PathBuf::new(),
            connection,
            target: ReadTarget::Sqlite,
            postgres_loaded: false,
            attach_error: None,
        })
    }
    /// A reader over `<workspace>/data.db` using the bundled extension for this platform (or `IXTABLE_DUCKDB_SQLITE_EXTENSION`).
    #[cfg(test)]
    pub(crate) fn for_test(workspace: &Path) -> Result<Self, String> {
        let ext = std::env::var_os("IXTABLE_DUCKDB_SQLITE_EXTENSION")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                super::support::resource_candidates("sqlite_scanner.duckdb_extension")[0].clone()
            });
        Self::new(workspace, &ext)
    }
}

pub(super) fn duck_bind(value: &DataValue) -> Result<duckdb::types::Value, String> {
    use duckdb::types::Value as V;
    Ok(match value {
        DataValue::Null => V::Null,
        DataValue::Integer(v) => V::BigInt(*v),
        DataValue::Real(v) if v.is_finite() => V::Double(*v),
        DataValue::Real(_) => return Err("Real values must be finite".into()),
        DataValue::Boolean(v) => V::Boolean(*v),
        DataValue::Blob(v) => V::Blob(
            STANDARD
                .decode(v)
                .map_err(|_| "Blob values must be valid base64")?,
        ),
        DataValue::Text(v)
        | DataValue::Date(v)
        | DataValue::Timestamp(v)
        | DataValue::Decimal(v)
        | DataValue::Time(v) => V::Text(v.clone()),
    })
}
