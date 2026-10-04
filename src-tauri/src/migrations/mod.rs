//! Declared SQL migrations (PRD §24): immutable ids, explicit order,
//! dependency validation, transactional execution with health checks, tracked
//! in `_ixtable_migrations` (applied state) and `_ixtable_migration_log` (every
//! run, with its log and error).
//!
//! Migrations target the embedded SQLite RecordStore only. PostgreSQL schema
//! migrations are out of MVP scope: developers manage an external database's
//! schema themselves, so documents with a PostgreSQL datasource cannot run them.
pub mod commands;
pub mod split;

use crate::archive::{check_named_ids, DocumentConfig, Issue};
use crate::data::sqltext::transaction_control_error;
use crate::recordstore::{sqlite::SqliteRecordStore, Bookkeeping, RecordStore, StoreError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: u32,
    /// `sqlite`. Older documents may say `any` (read as `sqlite`) or `postgres`
    /// (a validation error: PostgreSQL migrations are not supported).
    #[serde(default = "sqlite")]
    pub target_store: String,
    #[serde(default)]
    pub up: String,
    #[serde(default)]
    pub down: Option<String>,
    #[serde(default)]
    pub reversible: bool,
    #[serde(default)]
    pub depends_on: Vec<String>,
}
fn sqlite() -> String {
    "sqlite".into()
}

/// Why a migration targeting PostgreSQL is rejected.
pub const POSTGRES_UNSUPPORTED: &str =
    "PostgreSQL migrations are not supported in this version; manage external database schema yourself";
/// Why migrations do not run on a document whose datasource is PostgreSQL.
pub const POSTGRES_DOCUMENT: &str = "Migrations apply to the embedded SQLite store only and are disabled for this document because it uses PostgreSQL.";
impl Default for Migration {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            order: 0,
            target_store: sqlite(),
            up: String::new(),
            down: None,
            reversible: false,
            depends_on: vec![],
        }
    }
}
impl Migration {
    pub fn checksum(&self) -> String {
        format!("{:x}", Sha256::digest(self.up.as_bytes()))
    }
    /// Declares a supported target: `sqlite`, or its legacy spelling `any`.
    pub fn supported(&self) -> bool {
        matches!(self.target_store.as_str(), "sqlite" | "any")
    }
    /// Runs on `store`: only the embedded SQLite store runs migrations.
    pub fn targets(&self, store: &str) -> bool {
        store == "sqlite" && self.supported()
    }
}

/// The outcome of running one migration (or a dry run of several).
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationLog {
    pub migration_id: String,
    pub name: String,
    pub direction: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: String,
    pub log: Vec<String>,
    pub health: Vec<String>,
    pub error: Option<String>,
    pub recovery: Option<String>,
}

pub const STATE_TABLE: &str = "_ixtable_migrations";
const TRACKING_DDL: &str = "CREATE TABLE IF NOT EXISTS _ixtable_migrations(id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); \
CREATE TABLE IF NOT EXISTS _ixtable_migration_log(migration_id TEXT NOT NULL, name TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL, checksum TEXT NOT NULL, at TEXT NOT NULL, log TEXT, error TEXT, started_at TEXT, finished_at TEXT, health TEXT)";
/// Columns older log tables lack: real start/finish times and the health-check outcome.
const LOG_EXTRA_COLUMNS: [&str; 3] = ["started_at", "finished_at", "health"];
const LOG_FINISH: &str = "UPDATE _ixtable_migration_log SET finished_at = ?, health = ? WHERE migration_id = ? AND direction = ? AND at = ? AND status = ?";
const LOG_INSERT: &str = "INSERT INTO _ixtable_migration_log(migration_id,name,direction,status,checksum,at,log,error,started_at,finished_at,health) VALUES (?,?,?,?,?,?,?,?,?,?,?)";

pub fn validate(config: &DocumentConfig) -> Vec<Issue> {
    let mut issues = check_named_ids(
        "migration",
        config
            .migrations
            .iter()
            .map(|m| (m.id.as_str(), m.name.as_str())),
    );
    let mut orders = HashSet::new();
    for m in &config.migrations {
        let err = |msg: String| Issue::error("migration", &m.id, msg);
        if m.up.trim().is_empty() {
            issues.push(err(format!("{} has no up SQL", m.name)));
        }
        for (direction, sql) in [("up", Some(&m.up)), ("down", m.down.as_ref())] {
            if let Some(message) = sql.and_then(|sql| transaction_control_error(sql)) {
                issues.push(err(format!("{} ({direction}): {message}", m.name)));
            }
        }
        if m.reversible && m.down.as_deref().is_none_or(|d| d.trim().is_empty()) {
            issues.push(err(format!(
                "{} is marked reversible but has no down SQL",
                m.name
            )));
        }
        match m.target_store.as_str() {
            "sqlite" | "any" => {}
            "postgres" => issues.push(err(format!("{}: {POSTGRES_UNSUPPORTED}", m.name))),
            other => issues.push(err(format!("{} targets unknown store {other}", m.name))),
        }
        if !orders.insert(m.order) {
            issues.push(err(format!(
                "{} shares order {} with another migration",
                m.name, m.order
            )));
        }
        for dep in &m.depends_on {
            match config.migrations.iter().find(|x| &x.id == dep) {
                None => issues.push(err(format!(
                    "{} depends on unknown migration {dep}",
                    m.name
                ))),
                Some(d) if d.order >= m.order => issues.push(err(format!(
                    "{} must be ordered after its dependency {}",
                    m.name, d.name
                ))),
                Some(_) => {}
            }
        }
    }
    issues
}

/// Creates the tracking tables and adds log columns that older documents lack.
fn ensure_tracking(store: &mut dyn RecordStore) -> Result<(), StoreError> {
    store.execute_internal(TRACKING_DDL, &[])?;
    for column in LOG_EXTRA_COLUMNS {
        let probe = format!("SELECT {column} FROM _ixtable_migration_log LIMIT 1");
        if store.query_internal(&probe).is_err() {
            store.execute_internal(
                &format!("ALTER TABLE _ixtable_migration_log ADD COLUMN {column} TEXT"),
                &[],
            )?;
        }
    }
    Ok(())
}

/// Checks that `pending` can run against what is `done`, before any SQL runs:
/// applied migrations must be unchanged (immutability) and every `depends_on`
/// must be applied already or ordered earlier in `pending`.
pub fn preflight(
    done: &[(String, Option<String>)],
    migrations: &[Migration],
    pending: &[Migration],
) -> Result<(), String> {
    if let Some(m) = migrations.iter().find(|m| {
        done.iter()
            .any(|d| d.0 == m.id && d.1.as_ref().is_some_and(|c| c != &m.checksum()))
    }) {
        return Err(format!("{} changed after it was applied; migrations are immutable, so add a new migration instead", m.name));
    }
    let mut ready: HashSet<&str> = done.iter().map(|d| d.0.as_str()).collect();
    for m in pending {
        if let Some(dep) = m.depends_on.iter().find(|d| !ready.contains(d.as_str())) {
            let known = migrations.iter().find(|x| &x.id == dep);
            return Err(match known {
                None => format!("{} depends on unknown migration {dep}", m.name),
                Some(d) => format!(
                    "{} depends on {}, which is not applied and not ordered before it",
                    m.name, d.name
                ),
            });
        }
        ready.insert(m.id.as_str());
    }
    Ok(())
}

/// Applied migration ids (with the checksum of the run that applied them).
pub fn applied(store: &mut dyn RecordStore) -> Result<Vec<(String, Option<String>)>, StoreError> {
    ensure_tracking(store)?;
    let rows = store.query_internal(&format!("SELECT s.id, (SELECT l.checksum FROM _ixtable_migration_log l WHERE l.migration_id = s.id AND l.direction = 'up' AND l.status = 'applied' ORDER BY l.at DESC LIMIT 1) FROM {STATE_TABLE} s ORDER BY s.applied_at"))?;
    Ok(rows
        .into_iter()
        .filter_map(|mut r| {
            let checksum = r.pop().flatten();
            r.pop().flatten().map(|id| (id, checksum))
        })
        .collect())
}

/// Every recorded run, oldest first.
pub fn history(store: &mut dyn RecordStore) -> Result<Vec<MigrationLog>, StoreError> {
    ensure_tracking(store)?;
    let rows = store.query_internal("SELECT migration_id,name,direction,status,at,log,error,started_at,finished_at,health FROM _ixtable_migration_log ORDER BY at")?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let get = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
            MigrationLog {
                migration_id: get(0),
                name: get(1),
                direction: get(2),
                status: get(3),
                started_at: Some(get(7))
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| get(4)),
                finished_at: Some(get(8))
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| get(4)),
                log: get(5)
                    .lines()
                    .map(String::from)
                    .filter(|l| !l.is_empty())
                    .collect(),
                health: get(9)
                    .lines()
                    .map(String::from)
                    .filter(|l| !l.is_empty())
                    .collect(),
                error: r.get(6).cloned().flatten(),
                recovery: None,
            }
        })
        .collect())
}

/// Supported migrations that are not applied yet, in order. Callers only pass the
/// embedded SQLite store (commands refuse PostgreSQL documents).
pub fn pending_in(
    store: &mut dyn RecordStore,
    migrations: &[Migration],
) -> Result<Vec<Migration>, StoreError> {
    let done: HashSet<String> = applied(store)?.into_iter().map(|x| x.0).collect();
    let mut out: Vec<Migration> = migrations
        .iter()
        .filter(|m| m.supported() && !done.contains(&m.id))
        .cloned()
        .collect();
    out.sort_by_key(|m| m.order);
    Ok(out)
}

/// Pending migrations of an embedded SQLite database (contract for runtime installs).
pub fn pending(db_path: &Path, migrations: &[Migration]) -> Result<Vec<Migration>, String> {
    pending_in(&mut SqliteRecordStore::new(db_path), migrations).map_err(|e| e.to_string())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
}
fn recovery(m: &Migration, error: &str, checkpoint: Option<&str>) -> String {
    let mut text = format!(
        "\"{}\" failed and its transaction was rolled back, so the database is unchanged by it. Fix the SQL (or add a new migration) and apply again.",
        m.name
    );
    if error.contains("cannot run inside a transaction") || error.contains("CONCURRENTLY") {
        text.push_str(" Statements that cannot run in a transaction must be run manually against the database by an administrator; ixtable will not run them.");
    }
    if let Some(c) = checkpoint {
        text.push_str(&format!(" If records look wrong, restore the pre-migration checkpoint {c} as a copy (Settings › Assets › Checkpoints)."));
    }
    text
}

/// Runs one migration in one transaction with health checks and records the
/// result. Failures are recorded in `_ixtable_migration_log` too.
pub fn run_one(
    store: &mut dyn RecordStore,
    m: &Migration,
    down: bool,
    checkpoint: Option<&str>,
) -> MigrationLog {
    let started_at = now();
    let log_started = started_at.clone();
    let direction = if down { "down" } else { "up" };
    let sql = if down {
        m.down.clone().unwrap_or_default()
    } else {
        m.up.clone()
    };
    let at = now();
    let state: Bookkeeping = if down {
        (
            format!("DELETE FROM {STATE_TABLE} WHERE id = ?"),
            vec![m.id.clone()],
        )
    } else {
        (
            format!("INSERT INTO {STATE_TABLE}(id,name,applied_at) VALUES (?,?,?)"),
            vec![m.id.clone(), m.name.clone(), at.clone()],
        )
    };
    let mut log = MigrationLog {
        migration_id: m.id.clone(),
        name: m.name.clone(),
        direction: direction.into(),
        started_at,
        ..Default::default()
    };
    let entry = |status: &str, lines: &str, error: &str| -> Bookkeeping {
        (
            LOG_INSERT.into(),
            vec![
                m.id.clone(),
                m.name.clone(),
                direction.into(),
                status.into(),
                m.checksum(),
                at.clone(),
                lines.into(),
                error.into(),
                log_started.clone(),
                String::new(),
                String::new(),
            ],
        )
    };
    let lines = format!("{direction}: {}", m.name);
    let result = match transaction_control_error(&sql) {
        Some(message) => Err(StoreError::new("VALIDATION_ERROR", message)),
        None => Ok(()),
    }
    .and_then(|_| ensure_tracking(store))
    .and_then(|_| {
        store.run_script(
            &sql,
            &[
                state,
                entry(if down { "rolled_back" } else { "applied" }, &lines, ""),
            ],
            false,
        )
    });
    log.finished_at = now();
    match result {
        Ok(report) => {
            log.status = if down { "rolled_back" } else { "applied" }.into();
            log.log = report.log;
            log.health = report.health;
            // The success row is written inside the transaction, so finish time and health follow.
            let _ = store.execute_internal(
                LOG_FINISH,
                &[
                    log.finished_at.clone(),
                    log.health.join("\n"),
                    m.id.clone(),
                    direction.into(),
                    at.clone(),
                    log.status.clone(),
                ],
            );
        }
        Err(e) => {
            // A failed health check rolls the migration back; keep its message as the outcome.
            let health_failed =
                e.message.contains("health check") || e.message.contains("integrity_check");
            if health_failed {
                log.health = vec![format!("failed: {}", e.message)];
            }
            let (sql, mut binds) = entry("failed", &lines, &e.message);
            binds[9] = log.finished_at.clone();
            binds[10] = log.health.join("\n");
            let _ = store.execute_internal(&sql, &binds);
            log.status = "failed".into();
            log.recovery = Some(recovery(m, &e.message, checkpoint));
            log.error = Some(e.message);
        }
    }
    crate::logging::log(
        if log.status == "failed" {
            "error"
        } else {
            "info"
        },
        "migrations",
        &format!("{} {} {}", direction, m.name, log.status),
    );
    log
}

/// Applies pending SQLite migrations in order, one transaction each, and
/// stops at the first failure (contract used by runtime installations).
pub fn apply_sqlite(db_path: &Path, migrations: &[Migration]) -> Result<Vec<MigrationLog>, String> {
    let mut store = SqliteRecordStore::new(db_path);
    let mut logs = vec![];
    let done = applied(&mut store).map_err(|e| e.to_string())?;
    let pending = pending_in(&mut store, migrations).map_err(|e| e.to_string())?;
    // Same checks as Studio, before any SQL runs.
    preflight(&done, migrations, &pending)?;
    for m in pending {
        let log = run_one(&mut store, &m, false, None);
        let failed = log.error.clone();
        logs.push(log);
        if let Some(e) = failed {
            return Err(format!("Migration \"{}\" failed: {e}", m.name));
        }
    }
    Ok(logs)
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_hardening;
