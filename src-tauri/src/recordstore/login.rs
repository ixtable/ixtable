//! Datasource logins (PRD §9.3, §21.3): which username and password a
//! connection uses, and logins entered in Runtime, sealed in the local secret
//! store per installation (`runtime-bundles.md`).
use super::secrets::{
    datasource_secret_id, datasource_target, ensure_transport, SecretError, SecretStore,
};
use super::DatasourceConfig;
use serde::{Deserialize, Serialize};

/// Where a datasource login came from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginSource {
    /// An ixtable Cloud key grant (memory only).
    Grant,
    /// Entered in Runtime for this installation.
    Installation,
    /// The developer's local secret store (`password_ref`).
    Studio,
    None,
}

/// The username and password a connection uses. `user` is the datasource's
/// user unless a per-user cloud credential or a Runtime login names another.
#[derive(Debug, Clone)]
pub struct Login {
    pub user: String,
    pub password: Option<String>,
    pub source: LoginSource,
}

#[derive(Serialize, Deserialize)]
struct StoredLogin {
    user: String,
    password: String,
    /// The recipient accepted a transport that does not verify the server.
    #[serde(default)]
    unverified_accepted: bool,
}

/// What a Runtime login is bound to: the datasource target plus its
/// transport (sslmode and the bundle's insecure-transport flag). A bundle
/// update that weakens the transport reads the stored login as none.
pub fn installation_target(ds: &DatasourceConfig) -> String {
    serde_json::json!([
        "pg",
        ds.id,
        ds.host,
        ds.port,
        ds.database,
        ds.user,
        ds.sslmode,
        ds.insecure_transport_confirmed
    ])
    .to_string()
}

/// Refuses (UNVERIFIED_TRANSPORT) a password typed in Runtime for a
/// connection that does not verify the server, unless the recipient accepted
/// that risk. The bundle author's `insecure_transport_confirmed` does not
/// count: the recipient owns the password.
pub fn ensure_recipient_transport(
    ds: &DatasourceConfig,
    accepted: bool,
) -> Result<(), SecretError> {
    ensure_transport(ds)?;
    if ds.verifies_server() || accepted {
        return Ok(());
    }
    Err(SecretError {
        code: "UNVERIFIED_TRANSPORT",
        message: format!(
            "The connection uses sslmode {}, which does not verify the database server, so someone on the network could read the password. Accept the risk in the login dialog, or ask the developer to use verify-full.",
            ds.sslmode
        ),
    })
}

/// The secret-store key of a login entered in Runtime for one installation.
pub fn installation_secret_id(installation: &str, datasource_id: &str) -> String {
    format!("installation:{installation}:datasource:{datasource_id}")
}

/// Rejects a PostgreSQL username that is empty, longer than 63 bytes, or has
/// control characters (VALIDATION).
pub fn validate_login_user(user: &str) -> Result<(), SecretError> {
    if user.trim().is_empty() || user.len() > 63 || user.chars().any(char::is_control) {
        return Err(SecretError {
            code: "VALIDATION",
            message: "Enter a PostgreSQL username of 1 to 63 characters".into(),
        });
    }
    Ok(())
}

fn installation_key(ds: &DatasourceConfig) -> Option<String> {
    if !ds.is_postgres() {
        return None;
    }
    let inst = ds.installation.as_deref().filter(|i| !i.is_empty())?;
    Some(installation_secret_id(inst, &ds.id))
}

/// The Runtime login stored for the datasource's installation. A login saved
/// for another server, database, user, or a stronger transport (an update
/// moved or downgraded the datasource) reads as none, so Runtime asks again.
pub fn installation_login(ds: &DatasourceConfig) -> Result<Option<(String, String)>, SecretError> {
    let Some(id) = installation_key(ds) else {
        return Ok(None);
    };
    let raw = match SecretStore::default_location()?.get_for(&id, &installation_target(ds)) {
        Ok(Some(raw)) => raw,
        Ok(None) => return Ok(None),
        Err(e) if e.code == "CREDENTIAL_TARGET_MISMATCH" => return Ok(None),
        Err(e) => return Err(e),
    };
    let login: StoredLogin = serde_json::from_str(&raw)
        .map_err(|_| SecretError::io("A stored database login is corrupt"))?;
    if !ds.verifies_server() && !login.unverified_accepted {
        return Ok(None);
    }
    Ok(Some((login.user, login.password)))
}

/// Stores a Runtime login for the datasource's installation, bound to the
/// datasource's current target and transport. `accept_unverified` records
/// the recipient's acceptance of a transport that does not verify the server.
pub fn store_installation_login(
    ds: &DatasourceConfig,
    user: &str,
    password: &str,
    accept_unverified: bool,
) -> Result<(), SecretError> {
    validate_login_user(user)?;
    let id = installation_key(ds).ok_or_else(|| SecretError {
        code: "NOT_RUNTIME",
        message: "Database logins are entered only in an installed runtime bundle".into(),
    })?;
    ensure_recipient_transport(ds, accept_unverified)?;
    let raw = serde_json::to_string(&StoredLogin {
        user: user.into(),
        password: password.into(),
        unverified_accepted: !ds.verifies_server(),
    })
    .map_err(|e| SecretError::io(e.to_string()))?;
    Ok(SecretStore::default_location()?.put_for(&id, &raw, &installation_target(ds))?)
}

/// Forgets the Runtime login of the datasource's installation.
pub fn clear_installation_login(ds: &DatasourceConfig) -> Result<(), SecretError> {
    match installation_key(ds) {
        Some(id) => Ok(SecretStore::default_location()?.delete(&id)?),
        None => Ok(()),
    }
}

/// The login a datasource connects with, in order: a key grant held by its
/// cloud session, a login entered in Runtime for its manual installation,
/// then the developer's `password_ref`. A password is released only to the target it was stored
/// for and only over a confirmed transport.
pub fn datasource_login(ds: &DatasourceConfig) -> Result<Login, SecretError> {
    let login = |user: Option<String>, password: String, source| Login {
        user: user.unwrap_or_else(|| ds.user.clone()),
        password: Some(password),
        source,
    };
    if let Some((user, password)) = crate::cloud::grants::granted_login(ds) {
        ensure_transport(ds)?;
        return Ok(login(user, password, LoginSource::Grant));
    }
    if let Some((user, password)) = installation_login(ds)? {
        ensure_transport(ds)?;
        return Ok(login(Some(user), password, LoginSource::Installation));
    }
    let none = Login {
        user: ds.user.clone(),
        password: None,
        source: LoginSource::None,
    };
    let Some(r) = ds.password_ref.as_deref().filter(|r| !r.is_empty()) else {
        return Ok(none);
    };
    ensure_transport(ds)?;
    if r != datasource_secret_id(&ds.id) {
        return Err(SecretError::mismatch());
    }
    Ok(
        match SecretStore::default_location()?.get_for(r, &datasource_target(ds))? {
            Some(password) => login(None, password, LoginSource::Studio),
            None => none,
        },
    )
}

/// The datasource as it connects (user from its login) and the password.
pub fn connection(
    ds: &DatasourceConfig,
) -> Result<(DatasourceConfig, Option<String>), SecretError> {
    let login = datasource_login(ds)?;
    let mut ds = ds.clone();
    ds.user = login.user;
    Ok((ds, login.password))
}
