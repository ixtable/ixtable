//! `PostgresRecordStore` (PRD §9.3): the PostgreSQL write path. Values are
//! sent as text parameters and cast to each column's catalog type in SQL
//! (`$1::text::numeric(10,2)`), so binding never interpolates values.
mod catalog;
mod crud;
mod ddl;

pub use catalog::table_def_query;
pub(crate) use crud::{apply_op, delete_on, insert_on, update_on};

use crate::data::{q, DataValue, LogicalType, TableDef};
use crate::recordstore::{DatasourceConfig, StoreError};
use postgres::{error::SqlState, Client, GenericClient};
use std::time::Duration;

pub struct PostgresRecordStore {
    pub(crate) client: Client,
    pub schema: String,
}

fn libpq_quote(v: &str) -> String {
    format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
}
/// libpq connection string for DuckDB's postgres_scanner (contains the password).
pub fn conninfo(ds: &DatasourceConfig, password: Option<&str>) -> String {
    let mut parts = vec![
        format!("host={}", libpq_quote(&ds.host)),
        format!("port={}", ds.port),
        format!("dbname={}", libpq_quote(&ds.database)),
        format!("user={}", libpq_quote(&ds.user)),
        format!("sslmode={}", libpq_quote(&ds.sslmode)),
        "connect_timeout=10".to_string(),
    ];
    if let Some(p) = password {
        parts.push(format!("password={}", libpq_quote(p)));
    }
    parts.join(" ")
}

fn tls(ds_sslmode: &str) -> Result<postgres_native_tls::MakeTlsConnector, StoreError> {
    let mut b = native_tls::TlsConnector::builder();
    match ds_sslmode {
        "verify-full" => {}
        "verify-ca" => {
            b.danger_accept_invalid_hostnames(true);
        }
        _ => {
            b.danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true);
        }
    }
    let c = b
        .build()
        .map_err(|e| StoreError::new("CONNECTION", e.to_string()))?;
    Ok(postgres_native_tls::MakeTlsConnector::new(c))
}
fn connect_config(mut cfg: postgres::Config, sslmode: &str) -> Result<Client, StoreError> {
    use postgres::config::SslMode;
    cfg.connect_timeout(Duration::from_secs(10));
    cfg.ssl_mode(match sslmode {
        "disable" => SslMode::Disable,
        "allow" | "prefer" => SslMode::Prefer,
        _ => SslMode::Require,
    });
    let client = if sslmode == "disable" {
        cfg.connect(postgres::NoTls)
    } else {
        cfg.connect(tls(sslmode)?)
    };
    client.map_err(map_error)
}

pub fn map_error(e: postgres::Error) -> StoreError {
    let Some(db) = e.as_db_error() else {
        return StoreError::new("CONNECTION", crate::data::redact(&e.to_string()));
    };
    let detail = db.detail().map(|d| format!(" ({d})")).unwrap_or_default();
    let code = db.code();
    let constraint = db.constraint().unwrap_or("").to_string();
    if *code == SqlState::NOT_NULL_VIOLATION {
        StoreError::constraint(
            "not_null",
            format!("{} is required", db.column().unwrap_or("a column")),
        )
    } else if *code == SqlState::UNIQUE_VIOLATION {
        let kind = if constraint.ends_with("_pkey") {
            "primary_key"
        } else {
            "unique"
        };
        StoreError::constraint(kind, format!("{constraint}{detail}"))
    } else if *code == SqlState::FOREIGN_KEY_VIOLATION
        || *code == SqlState::DEPENDENT_OBJECTS_STILL_EXIST
    {
        StoreError::constraint("foreign_key", format!("{}{detail}", db.message()))
    } else if *code == SqlState::CHECK_VIOLATION {
        StoreError::constraint("check", constraint)
    } else if *code == SqlState::READ_ONLY_SQL_TRANSACTION
        || *code == SqlState::INSUFFICIENT_PRIVILEGE
    {
        StoreError::new("READ_ONLY", db.message())
    } else if *code == SqlState::T_R_SERIALIZATION_FAILURE
        || *code == SqlState::T_R_DEADLOCK_DETECTED
        || *code == SqlState::LOCK_NOT_AVAILABLE
    {
        StoreError::new("BUSY", db.message())
    } else if *code == SqlState::UNDEFINED_TABLE
        || *code == SqlState::UNDEFINED_COLUMN
        || *code == SqlState::UNDEFINED_OBJECT
    {
        StoreError::new("NOT_FOUND", db.message())
    } else if code.code().starts_with("08") {
        StoreError::new("CONNECTION", db.message())
    } else if code.code().starts_with("22") {
        StoreError::validation(db.message())
    } else {
        StoreError::new("DATABASE_ERROR", format!("{}{detail}", db.message()))
    }
}
pub(crate) fn pe(e: postgres::Error) -> StoreError {
    map_error(e)
}

/// Connects without keeping the client and reports (server version, TLS in use).
pub fn probe(ds: &DatasourceConfig, password: Option<&str>) -> Result<(String, bool), StoreError> {
    let mut store = PostgresRecordStore::connect(ds, password)?;
    let row = store
        .client
        .query_one(
            "SELECT current_setting('server_version'), COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)",
            &[],
        )
        .map_err(pe)?;
    Ok((row.get(0), row.get(1)))
}

/// Text parameter for a value (`None` is SQL NULL).
pub(crate) fn text_param(v: &DataValue) -> Option<String> {
    match v {
        DataValue::Null => None,
        DataValue::Blob(b) => Some(b.clone()),
        other => other.as_text(),
    }
}
/// SQL that casts text parameter `$i` to a column's type.
pub(crate) fn param_sql(i: usize, declared: &str, t: &LogicalType) -> String {
    match t {
        LogicalType::Blob => format!("decode(${i}::text,'base64')"),
        _ => format!("${i}::text::{declared}"),
    }
}
/// SQL that reads a column as text.
pub(crate) fn text_sql(column: &str, t: &LogicalType) -> String {
    match t {
        LogicalType::Blob => format!("translate(encode({},'base64'),E'\\n','')", q(column)),
        _ => format!("{}::text", q(column)),
    }
}
pub(crate) fn from_text(t: &LogicalType, s: Option<String>) -> DataValue {
    let Some(s) = s else { return DataValue::Null };
    match t {
        LogicalType::Integer => s
            .parse()
            .map(DataValue::Integer)
            .unwrap_or(DataValue::Text(s)),
        LogicalType::Real => s.parse().map(DataValue::Real).unwrap_or(DataValue::Text(s)),
        LogicalType::Blob => DataValue::Blob(s),
        _ => t.coerce_read(DataValue::Text(s)),
    }
}

pub(crate) fn load_def(
    c: &mut impl GenericClient,
    schema: &str,
    table: &str,
) -> Result<TableDef, StoreError> {
    let row = c
        .query_opt(&table_def_query(schema, table), &[])
        .map_err(pe)?;
    let json: String = match row {
        Some(r) => r.get(0),
        None => {
            let view = c
                .query_opt("SELECT 1 FROM information_schema.views WHERE table_schema=$1 AND table_name=$2", &[&schema, &table])
                .map_err(pe)?;
            return Err(match view {
                Some(_) => StoreError::new("READ_ONLY", format!("{table:?} is a read-only view")),
                None => StoreError::new(
                    "NOT_FOUND",
                    format!("Table or view {table:?} does not exist"),
                ),
            });
        }
    };
    let mut def: TableDef = serde_json::from_str(&json)
        .map_err(|e| StoreError::new("DATABASE_ERROR", e.to_string()))?;
    for c in &mut def.columns {
        c.logical_type = LogicalType::from_postgres(&c.declared_type);
    }
    Ok(def)
}

impl PostgresRecordStore {
    pub fn connect(ds: &DatasourceConfig, password: Option<&str>) -> Result<Self, StoreError> {
        let mut cfg = postgres::Config::new();
        cfg.host(&ds.host)
            .port(ds.port)
            .dbname(&ds.database)
            .user(&ds.user);
        if let Some(p) = password {
            cfg.password(p);
        }
        Self::with_client(connect_config(cfg, &ds.sslmode)?, &ds.schema)
    }
    /// Connects from a `postgres://` URL (tests and tooling).
    pub fn from_url(url: &str, schema: &str) -> Result<Self, StoreError> {
        let cfg: postgres::Config = url
            .parse()
            .map_err(|e: postgres::Error| StoreError::new("CONNECTION", e.to_string()))?;
        let sslmode = if url.contains("sslmode=require") {
            "require"
        } else {
            "disable"
        };
        Self::with_client(connect_config(cfg, sslmode)?, schema)
    }
    fn with_client(mut client: Client, schema: &str) -> Result<Self, StoreError> {
        client
            .batch_execute(&format!("SET search_path TO {}", q(schema)))
            .map_err(pe)?;
        Ok(Self {
            client,
            schema: schema.into(),
        })
    }
}
