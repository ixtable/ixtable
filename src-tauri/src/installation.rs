//! Runtime installations of runtime-only bundles (PRD §9.2, §22.3).
//!
//! Layout under `<state>/installations/<bundleId>/`:
//! - `active/app.ixt`: the current definition archive (read-only at Runtime)
//! - `data.db`: installation-owned records, seeded from the bundle on first open only
//! - `previous/`: recovery checkpoint (`active/`, `data.db`, `bundle.json`) taken before
//!   every update or reset
//! - `bundle.json`: installed version and the pinned signer key (trust on first use)
//!
//! Updates stage the new definition plus a copy of the installation's records, apply
//! pending migrations and health checks to the copy, and only then swap it in. Any
//! failure leaves (or restores) the previous working version.
use crate::archive::{self, DocumentConfig};
use crate::bundle::{self, io_err, SignedBundle};
use crate::installation_checks::{apply_migrations, health_check};
use crate::manager::{AppError, DocumentManager, SessionState};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};
use uuid::Uuid;

const BUNDLE_JSON: &str = "bundle.json";
const ARCHIVE: &str = "app.ixt";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBundle {
    pub bundle_id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub release_notes: String,
    pub signer_public_key: String,
    pub signer_fingerprint: String,
    pub payload_sha256: String,
    pub installed_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub previous_version: Option<String>,
}

/// What opening a bundle would do, for the confirmation UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSummary {
    pub bundle_id: String,
    pub name: String,
    pub version: String,
    pub release_notes: String,
    pub min_runtime_version: Option<String>,
    pub encrypted: bool,
    pub signer_fingerprint: String,
    pub installed_version: Option<String>,
    /// `install`, `open`, `update`, or `downgrade`.
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCount {
    pub name: String,
    pub rows: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreview {
    pub bundle_id: String,
    pub name: String,
    pub version: String,
    pub current: Vec<TableCount>,
    pub bundled: Vec<TableCount>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    Install,
    Open,
    Update,
    Downgrade,
}
impl Action {
    fn label(self) -> &'static str {
        match self {
            Action::Install => "install",
            Action::Open => "open",
            Action::Update => "update",
            Action::Downgrade => "downgrade",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeSession {
    pub bundle_id: String,
    pub version: String,
    pub dir: PathBuf,
}

/// Runtime-only sessions by session id; the manager consults it for `runtimeOnly`.
static RUNTIME: LazyLock<Mutex<HashMap<String, RuntimeSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Serializes installation changes.
static LOCK: Mutex<()> = Mutex::new(());

pub fn runtime_session(session_id: &str) -> Option<RuntimeSession> {
    RUNTIME.lock().unwrap().get(session_id).cloned()
}
pub fn runtime_version(session_id: &str) -> Option<String> {
    runtime_session(session_id).map(|s| s.version)
}
pub fn register_runtime(session_id: &str, session: RuntimeSession) {
    RUNTIME.lock().unwrap().insert(session_id.into(), session);
}
pub fn forget_runtime(session_id: &str) {
    RUNTIME.lock().unwrap().remove(session_id);
}

/// Rejects definition edits (config, DDL) in runtime-only windows with `READ_ONLY`.
pub fn ensure_studio(window: &str) -> Result<(), AppError> {
    match crate::manager()?.state(window) {
        Ok(state) if state.runtime_only => Err(AppError::new(
            "READ_ONLY",
            "This application is a runtime-only bundle; its definition cannot be changed",
        )),
        _ => Ok(()),
    }
}

pub fn installations_root() -> PathBuf {
    bundle::state_dir().join("installations")
}

fn installation_dir(root: &Path, bundle_id: &str) -> Result<PathBuf, AppError> {
    let safe = !bundle_id.is_empty()
        && bundle_id.len() <= 64
        && bundle_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe {
        return Err(AppError::new("BUNDLE_SIGNATURE", "Invalid bundle id"));
    }
    Ok(root.join(bundle_id))
}

pub fn read_installed(dir: &Path) -> Option<InstalledBundle> {
    serde_json::from_slice(&fs::read(dir.join(BUNDLE_JSON)).ok()?).ok()
}

fn write_installed(dir: &Path, info: &InstalledBundle) -> Result<(), AppError> {
    bundle::write_atomic(
        &dir.join(BUNDLE_JSON),
        &serde_json::to_vec_pretty(info).map_err(io_err)?,
    )
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Trust on first use: a bundle id stays bound to the first signer key installed.
pub fn check_signer(
    root: &Path,
    signed: &SignedBundle,
) -> Result<Option<InstalledBundle>, AppError> {
    let dir = installation_dir(root, &signed.header.bundle_id)?;
    let installed = read_installed(&dir);
    if let Some(pin) = &installed {
        if pin.signer_public_key != signed.header.signer_public_key {
            return Err(AppError::new(
                "BUNDLE_SIGNER_MISMATCH",
                format!(
                    "\"{}\" was installed from a bundle signed by {}, but this file is signed by {}. It was not opened.",
                    pin.name,
                    pin.signer_fingerprint,
                    signed.signer_fingerprint()
                ),
            ));
        }
    }
    Ok(installed)
}

pub fn plan(
    signed: &SignedBundle,
    installed: Option<&InstalledBundle>,
) -> Result<Action, AppError> {
    let Some(installed) = installed else {
        return Ok(Action::Install);
    };
    let incoming = bundle::parse_version("Bundle version", &signed.header.version)?;
    let current = bundle::parse_version("Installed version", &installed.version)?;
    Ok(match incoming.cmp(&current) {
        std::cmp::Ordering::Equal => Action::Open,
        std::cmp::Ordering::Greater => Action::Update,
        std::cmp::Ordering::Less => Action::Downgrade,
    })
}

fn info_for(signed: &SignedBundle, previous: Option<&InstalledBundle>) -> InstalledBundle {
    let now = Utc::now().to_rfc3339();
    let h = &signed.header;
    InstalledBundle {
        bundle_id: h.bundle_id.clone(),
        name: h.name.clone(),
        version: h.version.clone(),
        release_notes: h.release_notes.clone(),
        signer_public_key: h.signer_public_key.clone(),
        signer_fingerprint: signed.signer_fingerprint(),
        payload_sha256: h.payload_sha256.clone(),
        installed_at: previous.map_or(now.clone(), |p| p.installed_at.clone()),
        updated_at: now,
        previous_version: previous.map(|p| p.version.clone()),
    }
}

/// Copies `active/`, `data.db`, and `bundle.json` into `previous/`.
pub fn checkpoint(dir: &Path) -> Result<(), AppError> {
    let tmp = dir.join(format!(".previous-{}", Uuid::new_v4()));
    let result = (|| {
        copy_dir(&dir.join("active"), &tmp.join("active"))?;
        fs::copy(dir.join("data.db"), tmp.join("data.db"))?;
        fs::copy(dir.join(BUNDLE_JSON), tmp.join(BUNDLE_JSON))?;
        let previous = dir.join("previous");
        if previous.exists() {
            fs::remove_dir_all(&previous)?;
        }
        fs::rename(&tmp, &previous)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result.map_err(|e| AppError::new("UPDATE_FAILED", format!("Recovery checkpoint failed: {e}")))
}

/// Restores `previous/` over the live installation.
pub fn restore_previous(dir: &Path) -> std::io::Result<()> {
    let previous = dir.join("previous");
    let active = dir.join("active");
    if active.exists() {
        fs::remove_dir_all(&active)?;
    }
    copy_dir(&previous.join("active"), &active)?;
    fs::copy(previous.join("data.db"), dir.join("data.db"))?;
    fs::copy(previous.join(BUNDLE_JSON), dir.join(BUNDLE_JSON))?;
    Ok(())
}

/// Validates staged state: migrations on the staged records, then health checks.
fn prepare(staging: &Path, config: &DocumentConfig) -> Result<(), String> {
    apply_migrations(&staging.join("data.db"), config)?;
    health_check(&staging.join("data.db"), config)
}

fn stage(staging: &Path, archive: &[u8], records: &RecordSource) -> Result<(), AppError> {
    fs::create_dir_all(staging.join("active")).map_err(io_err)?;
    fs::write(staging.join("active").join(ARCHIVE), archive).map_err(io_err)?;
    match records {
        RecordSource::Bytes(bytes) => fs::write(staging.join("data.db"), bytes),
        RecordSource::File(path) => fs::copy(path, staging.join("data.db")).map(|_| ()),
    }
    .map_err(io_err)
}

enum RecordSource<'a> {
    Bytes(&'a [u8]),
    File(PathBuf),
}

/// Installs, updates, or (with `allow_downgrade`) downgrades the installation for a
/// verified bundle. `Action::Open` leaves an up-to-date installation untouched.
pub fn apply_bundle(
    root: &Path,
    signed: &SignedBundle,
    archive_bytes: &[u8],
    allow_downgrade: bool,
) -> Result<(PathBuf, Action), AppError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let installed = check_signer(root, signed)?;
    let dir = installation_dir(root, &signed.header.bundle_id)?;
    let action = plan(signed, installed.as_ref())?;
    if action == Action::Open {
        return Ok((dir, action));
    }
    if action == Action::Downgrade && !allow_downgrade {
        return Err(AppError::new(
            "BUNDLE_DOWNGRADE",
            format!(
                "Version {} is older than the installed version {}.",
                signed.header.version,
                installed.as_ref().map_or("", |i| i.version.as_str())
            ),
        ));
    }
    let doc = bundle::read_archive_bytes(archive_bytes, &root.join(".tmp"))?;
    if doc.metadata.document_id != signed.header.bundle_id {
        return Err(AppError::new(
            "BUNDLE_SIGNATURE",
            "Bundle id does not match its archive",
        ));
    }
    if action == Action::Install {
        install_fresh(root, &dir, signed, archive_bytes, &doc)?;
    } else {
        update_existing(&dir, signed, archive_bytes, &doc.config, installed.as_ref())?;
    }
    crate::logging::info(
        "bundle",
        &format!(
            "{} {} {}",
            action.label(),
            signed.header.name,
            signed.header.version
        ),
    );
    Ok((dir, action))
}

fn install_fresh(
    root: &Path,
    dir: &Path,
    signed: &SignedBundle,
    archive_bytes: &[u8],
    doc: &archive::ArchiveDocument,
) -> Result<(), AppError> {
    let staging = root.join(format!(".staging-{}", Uuid::new_v4()));
    let result = (|| {
        stage(&staging, archive_bytes, &RecordSource::Bytes(&doc.data))?;
        prepare(&staging, &doc.config).map_err(|e| AppError::new("INSTALL_FAILED", e))?;
        write_installed(&staging, &info_for(signed, None))?;
        if dir.exists() {
            // A directory without bundle.json is an interrupted install.
            fs::remove_dir_all(dir).map_err(io_err)?;
        }
        fs::rename(&staging, dir).map_err(io_err)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn update_existing(
    dir: &Path,
    signed: &SignedBundle,
    archive_bytes: &[u8],
    config: &DocumentConfig,
    installed: Option<&InstalledBundle>,
) -> Result<(), AppError> {
    let failed = |e: String| {
        AppError::new(
            "UPDATE_FAILED",
            format!(
                "{e}. Version {} is still active.",
                installed.map_or("", |i| i.version.as_str())
            ),
        )
    };
    checkpoint(dir)?;
    let staging = dir.join(format!(".staging-{}", Uuid::new_v4()));
    let result = (|| {
        stage(
            &staging,
            archive_bytes,
            &RecordSource::File(dir.join("data.db")),
        )?;
        prepare(&staging, config).map_err(&failed)?;
        let retired = dir.join(format!(".retired-{}", Uuid::new_v4()));
        let activate = (|| {
            fs::create_dir_all(&retired)?;
            fs::rename(dir.join("active"), retired.join("active"))?;
            fs::rename(staging.join("active"), dir.join("active"))?;
            fs::rename(dir.join("data.db"), retired.join("data.db"))?;
            fs::rename(staging.join("data.db"), dir.join("data.db"))
        })()
        .map_err(|e| e.to_string())
        .and_then(|_| write_installed(dir, &info_for(signed, installed)).map_err(|e| e.message));
        let _ = fs::remove_dir_all(&retired);
        if let Err(e) = activate {
            restore_previous(dir).map_err(|r| failed(format!("{e}; restore also failed: {r}")))?;
            return Err(failed(format!("Activation failed: {e}")));
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// Replaces installation records with the active bundle's bootstrap data, after a
/// recovery checkpoint. Destructive: callers must have shown `reset_preview`.
pub fn reset_data(dir: &Path) -> Result<(), AppError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let doc = archive::read_archive(&dir.join("active").join(ARCHIVE))?;
    checkpoint(dir)?;
    let staging = dir.join(format!(".reset-{}", Uuid::new_v4()));
    let result = (|| {
        fs::create_dir_all(&staging).map_err(io_err)?;
        fs::write(staging.join("data.db"), &doc.data).map_err(io_err)?;
        prepare(&staging, &doc.config).map_err(|e| AppError::new("RESET_FAILED", e))?;
        fs::rename(staging.join("data.db"), dir.join("data.db")).map_err(io_err)
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

fn table_counts(db: &Path) -> Vec<TableCount> {
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return vec![];
    };
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_ixtable_%' ORDER BY name")
        .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
        .unwrap_or_default();
    names
        .into_iter()
        .map(|name| {
            let sql = format!("SELECT count(*) FROM \"{}\"", name.replace('"', "\"\""));
            let rows = conn.query_row(&sql, [], |r| r.get(0)).unwrap_or(0);
            TableCount { name, rows }
        })
        .collect()
}

pub fn reset_preview(dir: &Path, scratch: &Path) -> Result<ResetPreview, AppError> {
    let info = read_installed(dir).ok_or_else(|| AppError::new("NOT_RUNTIME", "Not installed"))?;
    let doc = archive::read_archive(&dir.join("active").join(ARCHIVE))?;
    fs::create_dir_all(scratch).map_err(io_err)?;
    let tmp = scratch.join(format!(".preview-{}.db", Uuid::new_v4()));
    fs::write(&tmp, &doc.data).map_err(io_err)?;
    let bundled = table_counts(&tmp);
    let _ = fs::remove_file(&tmp);
    let current = table_counts(&dir.join("data.db"));
    let total: i64 = current.iter().map(|t| t.rows).sum();
    let seeded: i64 = bundled.iter().map(|t| t.rows).sum();
    Ok(ResetPreview {
        message: format!(
            "All {total} record(s) in this installation will be replaced by the {seeded} record(s) bundled with {} {}. A recovery copy of the current data is kept in the installation's previous/ folder.",
            info.name, info.version
        ),
        bundle_id: info.bundle_id,
        name: info.name,
        version: info.version,
        current,
        bundled,
    })
}

/// Opens the installation's active definition as a runtime-only session.
pub fn open_session(
    m: &DocumentManager,
    window: &str,
    dir: &Path,
) -> Result<SessionState, AppError> {
    let info = read_installed(dir).ok_or_else(|| AppError::new("NOT_RUNTIME", "Not installed"))?;
    let doc = archive::read_archive(&dir.join("active").join(ARCHIVE))?;
    m.open_runtime_session(
        window,
        dir,
        doc,
        RuntimeSession {
            bundle_id: info.bundle_id,
            version: info.version,
            dir: dir.to_owned(),
        },
    )
}

#[cfg(test)]
mod tests {
    include!("installation/tests.rs");
}
