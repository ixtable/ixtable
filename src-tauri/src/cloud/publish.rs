//! Publish checkpoint preflight and archive staging (PRD §7.4, §19, §21.4, §22.2).
//!
//! Publishing is blocked by: validation errors, an archive over 500 MB,
//! entities without a resolved concurrency policy when the app has more than
//! one runtime user or uses PostgreSQL (records shared between users), and a
//! PostgreSQL datasource that allows plaintext without the recorded override.
//! A confirmed non-TLS override and a shared credential are severe warnings
//! that the security summary records and the developer acknowledges.
use super::err;
use crate::archive::DocumentConfig;
use crate::assets::ArchiveSizeReport;
use crate::manager::AppError;
use crate::recordstore::POLICIES;
use crate::validation::{Issue, Severity};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySummary {
    /// `sqlite` or `postgres`.
    pub store: String,
    /// `shared` or `perUser` (PostgreSQL only).
    pub credential_mode: Option<String>,
    pub tls: bool,
    pub sslmode: Option<String>,
    pub insecure_override_confirmed: bool,
    pub insecure_override_confirmed_at: Option<String>,
    /// A shared PostgreSQL credential: every runtime user can extract it.
    pub shared_credential_warning: bool,
    pub entity_policies_resolved: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub size: ArchiveSizeReport,
    pub issues: Vec<Issue>,
    /// Reasons publishing is not possible; empty when it is.
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub security: SecuritySummary,
    pub migrations: Vec<MigrationRef>,
    /// Tables without a resolved concurrency policy.
    pub unresolved_entities: Vec<String>,
    pub version: String,
    pub release_notes: String,
    pub min_runtime_version: Option<String>,
}

/// Tables whose entity settings name no valid concurrency policy.
pub fn unresolved_entities(config: &DocumentConfig, tables: &[String]) -> Vec<String> {
    tables
        .iter()
        .filter(|t| !t.starts_with("_ixtable_"))
        .filter(|t| {
            !config
                .entities
                .iter()
                .any(|e| &e.table == *t && POLICIES.contains(&e.concurrency.as_str()))
        })
        .cloned()
        .collect()
}

pub fn security_summary(config: &DocumentConfig, resolved: bool) -> SecuritySummary {
    let ds = &config.datasource;
    let pg = ds.is_postgres();
    SecuritySummary {
        store: if pg { "postgres" } else { "sqlite" }.into(),
        credential_mode: pg.then(|| ds.credential_mode.clone()),
        tls: !pg || !ds.allows_plaintext(),
        sslmode: pg.then(|| ds.sslmode.clone()),
        insecure_override_confirmed: pg && ds.allows_plaintext() && ds.insecure_transport_confirmed,
        insecure_override_confirmed_at: if pg && ds.allows_plaintext() {
            ds.insecure_transport_confirmed_at.clone()
        } else {
            None
        },
        shared_credential_warning: pg && ds.credential_mode != "perUser",
        entity_policies_resolved: resolved,
    }
}

/// Pure publish assessment (unit-tested).
pub fn assess(
    config: &DocumentConfig,
    tables: &[String],
    size: ArchiveSizeReport,
    issues: Vec<Issue>,
    runtime_users: u32,
) -> Preflight {
    let mut blockers = vec![];
    let mut warnings = vec![];
    let errors = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .count();
    if errors > 0 {
        blockers.push(format!(
            "{errors} validation error(s) must be fixed first (see the Problems tab)"
        ));
    }
    if size.over_cloud_limit {
        blockers.push(format!(
            "The archive is {} MB; ixtable Cloud accepts up to {} MB. Remove large assets or records first.",
            size.total_bytes / 1_000_000,
            size.cloud_limit_bytes / 1_000_000
        ));
    }
    let pg = config.datasource.is_postgres();
    let unresolved = unresolved_entities(config, tables);
    if !unresolved.is_empty() {
        let message = format!(
            "No concurrency policy for: {} (set one in the Entities tab)",
            unresolved.join(", ")
        );
        if runtime_users > 1 || pg {
            blockers.push(message);
        } else {
            warnings.push(message);
        }
    }
    let security = security_summary(config, unresolved.is_empty());
    if pg && config.datasource.allows_plaintext() {
        if config.datasource.insecure_transport_confirmed {
            warnings.push(format!(
                "SEVERE: the PostgreSQL datasource allows connections without TLS (sslmode {}). Credentials and records can be read in transit. This override is recorded in the security summary.",
                config.datasource.sslmode
            ));
        } else {
            blockers.push(format!(
                "The PostgreSQL datasource allows connections without TLS (sslmode {}). Require TLS, or confirm the security override in Datasource settings.",
                config.datasource.sslmode
            ));
        }
    }
    if security.shared_credential_warning {
        warnings.push(
            "Every runtime user receives the same shared database credential, and an authorized user can extract it. ixtable roles do not limit direct database access; use per-user, least-privileged credentials for strong isolation."
                .into(),
        );
    }
    Preflight {
        size,
        issues,
        blockers,
        warnings,
        security,
        migrations: config
            .migrations
            .iter()
            .map(|m| MigrationRef {
                id: m.id.clone(),
                name: m.name.clone(),
            })
            .collect(),
        unresolved_entities: unresolved,
        version: config.release.version.clone(),
        release_notes: config.release.notes.clone(),
        min_runtime_version: config.release.min_runtime_version.clone(),
    }
}

/// Preflight for the window's document.
pub fn preflight(window: &str, runtime_users: u32) -> Result<Preflight, AppError> {
    let m = crate::manager()?;
    let config = m.config(window)?;
    let tables: Vec<String> = m
        .database_objects(window)
        .unwrap_or_default()
        .into_iter()
        .filter(|o| o.object_type == "table")
        .map(|o| o.name)
        .collect();
    let size = m.archive_size_report(window)?;
    let issues = crate::validation::validate_document(window.to_string())?;
    Ok(assess(&config, &tables, size, issues, runtime_users))
}

/// A private copy of the saved archive, removed on drop.
pub struct Staged {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
}
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Copies the window's saved archive aside so later saves cannot change the
/// bytes being uploaded. The document must be saved and clean.
pub fn stage_saved(window: &str) -> Result<Staged, AppError> {
    let m = crate::manager()?;
    let state = m.state(window)?;
    if state.runtime_only {
        return Err(err("READ_ONLY", "Runtime installations cannot publish"));
    }
    let path = state.path.filter(|_| !state.dirty).ok_or_else(|| {
        err(
            "SAVE_REQUIRED",
            "Save the document before publishing or backing it up",
        )
    })?;
    let dir = m
        .recovery_root
        .parent()
        .map(|p| p.join("cloud-upload"))
        .unwrap_or_else(|| std::env::temp_dir().join("ixtable-cloud-upload"));
    crate::paths::ensure_private_dir(&dir).map_err(|e| err("IO_ERROR", e))?;
    let staged = dir.join(format!("{}.ixt", uuid::Uuid::new_v4()));
    std::fs::copy(&path, &staged).map_err(|e| err("IO_ERROR", e))?;
    let mut out = Staged {
        path: staged,
        sha256: String::new(),
        size: 0,
    };
    // The copy must still be a readable archive.
    crate::archive_io::read_header(&out.path)?;
    let (sha256, size) = super::http::hash_file(&out.path)?;
    if size > super::MAX_ARCHIVE_BYTES {
        return Err(err(
            "TOO_LARGE",
            format!(
                "The archive is {} MB; ixtable Cloud accepts up to 500 MB",
                size / 1_000_000
            ),
        ));
    }
    out.sha256 = sha256;
    out.size = size;
    Ok(out)
}
