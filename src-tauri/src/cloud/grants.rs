//! Datasource credentials released by ixtable Cloud key grants (PRD §21.3).
//!
//! A decrypted credential lives only in this map, keyed by the cloud session
//! (window) that requested it and the datasource target it was sealed for,
//! until its grant expires (24 h) or is cleared on revocation, sign-out, or
//! close. It is never written to disk or logs. The record store asks
//! [`granted_login`] before the local secret store, and only for a datasource
//! whose `grant_scope` names that cloud session: Studio and manual installs
//! never see a grant.
use crate::recordstore::{secrets::datasource_target, DatasourceConfig};
use chrono::{DateTime, Utc};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

struct Granted {
    /// Per-user username from the envelope; `None` uses the datasource's user.
    user: Option<String>,
    password: String,
    expires_at: DateTime<Utc>,
}

static GRANTS: LazyLock<Mutex<HashMap<String, Granted>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn grants() -> std::sync::MutexGuard<'static, HashMap<String, Granted>> {
    GRANTS.lock().unwrap_or_else(|e| e.into_inner())
}

fn key(scope: &str, target: &str) -> String {
    format!("{scope}\n{target}")
}

/// The map key of a datasource's grant; `None` outside a cloud session.
fn ds_key(ds: &DatasourceConfig) -> Option<String> {
    let scope = ds.grant_scope.as_deref().filter(|s| !s.is_empty())?;
    Some(key(scope, &datasource_target(ds)))
}

/// Holds a credential for `target` in cloud session `scope` until `expires_at`.
pub fn put(
    scope: &str,
    target: &str,
    user: Option<String>,
    password: String,
    expires_at: DateTime<Utc>,
) {
    grants().insert(
        key(scope, target),
        Granted {
            user,
            password,
            expires_at,
        },
    );
}

/// Forgets the credential of a datasource target in cloud session `scope`.
pub fn clear(scope: &str, target: &str) {
    if let Some(mut g) = grants().remove(&key(scope, target)) {
        // Best effort: overwrite before the allocation is released.
        wipe(&mut g.password);
    }
}

/// Forgets the credential a datasource's cloud session holds (session close).
pub fn release(ds: &DatasourceConfig) {
    if let Some(mut g) = ds_key(ds).and_then(|k| grants().remove(&k)) {
        wipe(&mut g.password);
    }
}

pub fn clear_all() {
    for (_, mut g) in grants().drain() {
        wipe(&mut g.password);
    }
}

fn wipe(s: &mut String) {
    // SAFETY: NUL bytes keep the string valid UTF-8.
    unsafe { s.as_bytes_mut() }.fill(0);
}

/// The granted password for this datasource, when one is held and unexpired.
pub fn granted_password(ds: &DatasourceConfig) -> Option<String> {
    granted_login(ds).map(|(_, password)| password)
}

/// The granted (username, password) for this datasource, when its cloud
/// session holds an unexpired grant. The username is set only for a per-user
/// credential that names its own database user.
pub fn granted_login(ds: &DatasourceConfig) -> Option<(Option<String>, String)> {
    let target = ds_key(ds)?;
    let mut map = grants();
    match map.get(&target) {
        Some(g) if g.expires_at > Utc::now() => Some((g.user.clone(), g.password.clone())),
        Some(_) => {
            if let Some(mut g) = map.remove(&target) {
                wipe(&mut g.password);
            }
            None
        }
        None => None,
    }
}

/// Expiry of the grant held for a datasource.
pub fn expires_at(ds: &DatasourceConfig) -> Option<DateTime<Utc>> {
    grants().get(&ds_key(ds)?).map(|g| g.expires_at)
}
