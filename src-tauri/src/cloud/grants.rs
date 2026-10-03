//! Datasource credentials released by ixtable Cloud key grants (PRD §21.3).
//!
//! A decrypted credential lives only in this map, keyed by the datasource
//! target it was sealed for, until its grant expires (24 h) or is cleared on
//! revocation, sign-out, or close. It is never written to disk or logs. The
//! record store asks [`granted_password`] before the local secret store.
use crate::recordstore::{secrets::datasource_target, DatasourceConfig};
use chrono::{DateTime, Utc};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

struct Granted {
    password: String,
    expires_at: DateTime<Utc>,
}

static GRANTS: LazyLock<Mutex<HashMap<String, Granted>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn grants() -> std::sync::MutexGuard<'static, HashMap<String, Granted>> {
    GRANTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Holds a credential for `target` until `expires_at`.
pub fn put(target: &str, password: String, expires_at: DateTime<Utc>) {
    grants().insert(
        target.into(),
        Granted {
            password,
            expires_at,
        },
    );
}

/// Forgets the credential of a datasource target.
pub fn clear(target: &str) {
    if let Some(mut g) = grants().remove(target) {
        // Best effort: overwrite before the allocation is released.
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
    let target = datasource_target(ds);
    let mut map = grants();
    match map.get(&target) {
        Some(g) if g.expires_at > Utc::now() => Some(g.password.clone()),
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
    grants().get(&datasource_target(ds)).map(|g| g.expires_at)
}
