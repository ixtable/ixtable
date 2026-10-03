//! In-app updates (PRD §6.1, §27.2): the update channel preference, endpoint
//! resolution, and the check / install / relaunch commands around
//! tauri-plugin-updater.
//!
//! Fail-closed: the plugin downloads the package and verifies its minisign
//! signature against `plugins.updater.pubkey` (tauri.conf.json) before it
//! hands bytes to the installer; any decode or verify error aborts the
//! install (`Update::download` in tauri-plugin-updater). Endpoints are
//! https-only. See docs/release/updates.md.
use crate::manager::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;

/// Static release host. `latest.json` per channel is uploaded by the
/// `publish-update-manifest` job in .github/workflows/release.yml.
pub const RELEASE_HOST: &str = "https://releases.ixtable.app";
/// Overrides `RELEASE_HOST` (staging hosts, local QA). Must be https.
pub const BASE_URL_ENV: &str = "IXTABLE_UPDATE_BASE_URL";
pub const CHANNEL_KEY: &str = "updates.channel";
pub const AUTO_CHECK_KEY: &str = "updates.autoCheck";
/// The version the plugin compares against (tauri.conf.json `version`, kept equal by a test).
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

impl UpdateChannel {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stable" => Some(Self::Stable),
            "beta" => Some(Self::Beta),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }
}

/// The channel's manifest URL. The plugin fills `{{target}}`, `{{arch}}` and
/// `{{current_version}}`; a static host ignores the query, a dynamic one can use it.
pub fn endpoint(base: &str, channel: UpdateChannel) -> Result<String, AppError> {
    let base = base.trim().trim_end_matches('/');
    let host = base.strip_prefix("https://").unwrap_or_default();
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(AppError::new(
            "INVALID_UPDATE_ENDPOINT",
            "Update endpoints must use https",
        ));
    }
    Ok(format!(
        "{base}/{}/latest.json?target={{{{target}}}}&arch={{{{arch}}}}&current_version={{{{current_version}}}}",
        channel.as_str()
    ))
}

fn base_url() -> String {
    std::env::var(BASE_URL_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| RELEASE_HOST.to_string())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub current_version: String,
    pub channel: UpdateChannel,
    pub auto_check: bool,
    pub endpoint: String,
}

/// Settings from stored preference values; anything unrecognized falls back to
/// `stable` with auto-check on.
pub fn settings_from(
    channel: Option<&Value>,
    auto_check: Option<&Value>,
    base: &str,
) -> Result<UpdateSettings, AppError> {
    let channel = channel
        .and_then(Value::as_str)
        .and_then(UpdateChannel::parse)
        .unwrap_or_default();
    Ok(UpdateSettings {
        current_version: CURRENT_VERSION.to_string(),
        channel,
        auto_check: auto_check.and_then(Value::as_bool).unwrap_or(true),
        endpoint: endpoint(base, channel)?,
    })
}

fn load_settings() -> Result<UpdateSettings, AppError> {
    let global = &crate::manager()?.global;
    let read = |key: &str| {
        global
            .preference(key)
            .map_err(|e| AppError::new("IO_ERROR", e))
    };
    settings_from(
        read(CHANNEL_KEY)?.as_ref(),
        read(AUTO_CHECK_KEY)?.as_ref(),
        &base_url(),
    )
}

#[tauri::command]
pub fn update_settings(window_label: String) -> Result<UpdateSettings, AppError> {
    let _ = window_label;
    load_settings()
}

/// Stores the channel and/or the auto-check preference. Switching channels drops
/// a pending update found on the other channel.
#[tauri::command]
pub fn set_update_settings(
    window_label: String,
    channel: Option<String>,
    auto_check: Option<bool>,
) -> Result<UpdateSettings, AppError> {
    let _ = window_label;
    let global = &crate::manager()?.global;
    let io = |e: rusqlite::Error| AppError::new("IO_ERROR", e);
    if let Some(name) = channel {
        let parsed = UpdateChannel::parse(&name).ok_or_else(|| {
            AppError::new("INVALID_UPDATE_CHANNEL", format!("Unknown channel {name}"))
        })?;
        global
            .set_preference(CHANNEL_KEY, &Value::from(parsed.as_str()))
            .map_err(io)?;
        lock(&PENDING).take();
    }
    if let Some(enabled) = auto_check {
        global
            .set_preference(AUTO_CHECK_KEY, &Value::from(enabled))
            .map_err(io)?;
    }
    load_settings()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub current_version: String,
    pub channel: UpdateChannel,
    pub date: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    #[default]
    Idle,
    Downloading,
    Installing,
    Installed,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: UpdatePhase,
    pub downloaded: u64,
    pub total: Option<u64>,
}

struct Pending {
    channel: UpdateChannel,
    update: tauri_plugin_updater::Update,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static PROGRESS: Mutex<UpdateProgress> = Mutex::new(UpdateProgress {
    phase: UpdatePhase::Idle,
    downloaded: 0,
    total: None,
});

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Signature failures get their own code so the UI can say the package was rejected.
pub fn error_code(error: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::MissingSignedVersion
        | E::SignedVersionMismatch { .. } => "UPDATE_SIGNATURE_INVALID",
        E::InsecureTransportProtocol => "INVALID_UPDATE_ENDPOINT",
        _ => "UPDATE_FAILED",
    }
}

fn updater_error(error: tauri_plugin_updater::Error) -> AppError {
    AppError::new(error_code(&error), error)
}

/// Asks the selected channel for a newer release. Nothing is downloaded yet.
#[tauri::command]
pub async fn check_for_update(
    window_label: String,
    app: tauri::AppHandle,
) -> Result<Option<AvailableUpdate>, AppError> {
    use tauri_plugin_updater::UpdaterExt;
    let _ = window_label;
    let settings = load_settings()?;
    let url = settings
        .endpoint
        .parse()
        .map_err(|e| AppError::new("INVALID_UPDATE_ENDPOINT", e))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(updater_error)?
        .build()
        .map_err(updater_error)?;
    let found = updater.check().await.map_err(updater_error)?;
    let info = found.as_ref().map(|u| AvailableUpdate {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        channel: settings.channel,
        date: u.date.map(|d| d.to_string()),
        notes: u.body.clone(),
    });
    *lock(&PENDING) = found.map(|update| Pending {
        channel: settings.channel,
        update,
    });
    Ok(info)
}

/// Downloads, verifies and installs the update found by `check_for_update`.
/// The UI saves open work first; on Windows the installer then exits the app.
#[tauri::command]
pub async fn install_update(window_label: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let _ = (window_label, app);
    let pending = lock(&PENDING)
        .take()
        .ok_or_else(|| AppError::new("NO_PENDING_UPDATE", "Check for updates before installing"))?;
    if pending.channel != load_settings()?.channel {
        return Err(AppError::new(
            "NO_PENDING_UPDATE",
            "The update channel changed; check again",
        ));
    }
    *lock(&PROGRESS) = UpdateProgress {
        phase: UpdatePhase::Downloading,
        ..Default::default()
    };
    let result = pending
        .update
        .download_and_install(
            |chunk, total| {
                let mut p = lock(&PROGRESS);
                p.downloaded += chunk as u64;
                p.total = total;
            },
            || lock(&PROGRESS).phase = UpdatePhase::Installing,
        )
        .await;
    lock(&PROGRESS).phase = match result {
        Ok(()) => UpdatePhase::Installed,
        Err(_) => UpdatePhase::Failed,
    };
    result.map_err(updater_error)
}

#[tauri::command]
pub fn update_progress(window_label: String) -> Result<UpdateProgress, AppError> {
    let _ = window_label;
    Ok(lock(&PROGRESS).clone())
}

/// Restarts into the installed version (macOS and Linux; Windows restarts itself).
#[tauri::command]
pub fn relaunch_app(window_label: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let _ = window_label;
    if lock(&PROGRESS).phase != UpdatePhase::Installed {
        return Err(AppError::new("NO_PENDING_UPDATE", "No installed update"));
    }
    app.restart()
}

#[cfg(test)]
mod tests;
