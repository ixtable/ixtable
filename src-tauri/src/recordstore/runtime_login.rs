//! Database logins entered in Runtime (PRD §9.3, §27.2). A manually shared
//! runtime bundle carries no PostgreSQL password, so the recipient enters a
//! username and password. Runtime verifies them by connecting, then keeps them
//! in the local secret store under the installation (never in the archive).
//! Cloud installations get credentials from key grants instead.
use super::secrets::{self, LoginSource};
use super::DatasourceConfig;
use crate::data::{redact, ReadTarget};
use crate::manager::AppError;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLoginStatus {
    /// True for a manually installed runtime bundle on PostgreSQL.
    pub applies: bool,
    pub attached: bool,
    pub source: LoginSource,
    /// Username the connection uses (never the password).
    pub user: String,
    pub host: String,
    pub database: String,
    /// Runtime should ask for a login: none is stored, or the server refused it.
    pub needs_login: bool,
    /// `missing` or `rejected` when `needs_login`.
    pub reason: Option<String>,
    /// Redacted connection error.
    pub error: Option<String>,
}

/// True when a connection error means the server refused the login.
pub fn is_auth_failure(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    [
        "password authentication failed",
        "no password supplied",
        "authentication failed",
        "pg_hba.conf",
        "28p01",
        "28000",
    ]
    .iter()
    .any(|s| m.contains(s))
        || (m.contains("role \"") && m.contains("does not exist"))
}

/// The datasource of a manually installed runtime bundle on PostgreSQL.
fn runtime_datasource(window: &str) -> Result<Option<DatasourceConfig>, AppError> {
    let m = crate::manager()?;
    if !m.state(window)?.runtime_only || crate::cloud::install::session_dir(window).is_ok() {
        return Ok(None);
    }
    let ds = m.config(window)?.datasource;
    Ok(Some(ds).filter(|ds| ds.is_postgres() && ds.installation.is_some()))
}

fn status(window: &str) -> Result<RuntimeLoginStatus, AppError> {
    let Some(ds) = runtime_datasource(window)? else {
        return Ok(RuntimeLoginStatus {
            applies: false,
            attached: true,
            source: LoginSource::None,
            user: String::new(),
            host: String::new(),
            database: String::new(),
            needs_login: false,
            reason: None,
            error: None,
        });
    };
    let (attached, mut error) = crate::manager()?.with_session(window, |s| {
        let postgres = matches!(s.reader.target(), ReadTarget::Postgres { .. });
        let error = s.reader.attach_error().map(redact);
        Ok((postgres && error.is_none(), error))
    })?;
    let login = secrets::datasource_login(&ds);
    let (user, source) = match &login {
        Ok(l) if l.password.is_some() => (l.user.clone(), l.source),
        _ => (ds.user.clone(), LoginSource::None),
    };
    // A lookup failure (e.g. INSECURE_TRANSPORT) is reported, not asked for.
    if let Err(e) = &login {
        error = Some(redact(&e.message));
    }
    let reason = if attached || login.is_err() {
        None
    } else if source == LoginSource::None {
        Some("missing")
    } else if error.as_deref().is_some_and(is_auth_failure) {
        Some("rejected")
    } else {
        None
    };
    Ok(RuntimeLoginStatus {
        applies: true,
        attached,
        source,
        user,
        host: ds.host,
        database: ds.database,
        needs_login: reason.is_some(),
        reason: reason.map(str::to_string),
        error: if attached { None } else { error },
    })
}

fn reattach(window: &str) -> Result<RuntimeLoginStatus, AppError> {
    super::commands::connect_datasource(window.to_string())?;
    status(window)
}

fn require_runtime(window: &str) -> Result<DatasourceConfig, AppError> {
    runtime_datasource(window)?.ok_or_else(|| {
        AppError::new(
            "NOT_RUNTIME",
            "Database logins are entered only in an installed runtime bundle that uses PostgreSQL",
        )
    })
}

/// Whether the open runtime bundle needs a database login, and which one it uses.
#[tauri::command]
pub fn runtime_datasource_login_status(
    window_label: String,
) -> Result<RuntimeLoginStatus, AppError> {
    status(&window_label)
}

/// Verifies a username and password by connecting, then stores them for this
/// installation and re-attaches the reader. A refused login is not stored.
#[tauri::command]
pub fn set_runtime_datasource_login(
    window_label: String,
    user: String,
    password: String,
) -> Result<RuntimeLoginStatus, AppError> {
    let ds = require_runtime(&window_label)?;
    let user = user.trim().to_string();
    secrets::validate_login_user(&user)?;
    if password.is_empty() {
        return Err(AppError::new("VALIDATION", "Enter the database password"));
    }
    secrets::ensure_transport(&ds)?;
    let mut probe = ds.clone();
    probe.user = user.clone();
    super::blocking(|| crate::postgres::probe(&probe, Some(&password)))
        .map_err(|e| AppError::new(e.code, redact(&e.message)))?;
    secrets::store_installation_login(&ds, &user, &password)?;
    crate::logging::info(
        "recordstore",
        &format!("runtime database login saved for user {user}"),
    );
    reattach(&window_label)
}

/// Forgets this installation's stored login and re-attaches the reader.
#[tauri::command]
pub fn clear_runtime_datasource_login(
    window_label: String,
) -> Result<RuntimeLoginStatus, AppError> {
    let ds = require_runtime(&window_label)?;
    secrets::clear_installation_login(&ds)?;
    crate::logging::info("recordstore", "runtime database login cleared");
    reattach(&window_label)
}

#[cfg(test)]
mod tests {
    include!("runtime_login_tests.rs");
}
