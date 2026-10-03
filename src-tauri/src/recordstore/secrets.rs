//! Local secret store for datasource credentials (PRD §27.2). Secrets are
//! sealed with ChaCha20-Poly1305 under a random 256-bit key kept in
//! `<state>/secrets/secret.key` (0600); the archive only stores a reference.
use super::DatasourceConfig;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    ChaCha20Poly1305, Key, Nonce,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub struct SecretStore {
    dir: PathBuf,
}

fn state_dir() -> PathBuf {
    crate::paths::state_dir().join("data")
}

use crate::manager::AppError;
use serde::{Deserialize, Serialize};
use std::{io::ErrorKind, sync::Mutex};

/// Serializes every read-modify-write of the store within this process.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// A secret-store failure with a stable error code.
#[derive(Debug, Clone, PartialEq)]
pub struct SecretError {
    pub code: &'static str,
    pub message: String,
}
impl SecretError {
    fn io(message: impl Into<String>) -> Self {
        Self {
            code: "IO_ERROR",
            message: message.into(),
        }
    }
    fn mismatch() -> Self {
        Self {
            code: "CREDENTIAL_TARGET_MISMATCH",
            message: "The stored password was saved for a different server, database, or user than this datasource now names. Re-enter the password in Datasource settings.".into(),
        }
    }
}
impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl From<String> for SecretError {
    fn from(message: String) -> Self {
        Self::io(message)
    }
}
impl From<SecretError> for AppError {
    fn from(e: SecretError) -> Self {
        AppError::new(e.code, e.message)
    }
}
impl From<SecretError> for super::StoreError {
    fn from(e: SecretError) -> Self {
        super::StoreError::new(e.code, e.message)
    }
}

/// One stored secret. `target` names what the secret may be released to and
/// is authenticated as AEAD associated data, so it cannot be edited.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum Entry {
    Bound { target: String, sealed: String },
    /// Pre-binding format (associated data = id only).
    Legacy(String),
}

/// Writes through a unique temp file + rename so a crash never leaves a
/// half-written file and concurrent writers never share a temp path.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("secret");
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = open_private(&tmp, false)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}

fn open_private(path: &Path, create_new: bool) -> std::io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true);
    if create_new {
        o.create_new(true);
    } else {
        o.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

fn associated_data(id: &str, target: Option<&str>) -> Vec<u8> {
    match target {
        Some(t) => format!("{id}\n{t}").into_bytes(),
        None => id.as_bytes().to_vec(),
    }
}

impl SecretStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, String> {
        let dir = dir.into();
        crate::paths::ensure_private_dir(&dir).map_err(|e| e.to_string())?;
        Ok(Self { dir })
    }
    pub fn default_location() -> Result<Self, String> {
        Self::open(state_dir().join("secrets"))
    }
    /// Loads the machine key. A key is generated only when none exists
    /// (`NotFound`, created with `create_new`); any other read error fails
    /// so stored credentials are never orphaned by a transient error.
    fn cipher(&self) -> Result<ChaCha20Poly1305, String> {
        let path = self.dir.join("secret.key");
        let key = match fs::read(&path) {
            Ok(bytes) if bytes.len() == 32 => {
                crate::paths::check_private_file(&path)?;
                bytes
            }
            Ok(_) => return Err("The local secret key is corrupt".into()),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                use std::io::Write;
                let key = ChaCha20Poly1305::generate_key(&mut OsRng).to_vec();
                match open_private(&path, true) {
                    Ok(mut f) => {
                        f.write_all(&key)
                            .and_then(|_| f.sync_all())
                            .map_err(|e| e.to_string())?;
                        key
                    }
                    // Another process created it first: use theirs.
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => return self.cipher(),
                    Err(e) => return Err(format!("Could not create the local secret key: {e}")),
                }
            }
            Err(e) => return Err(format!("Could not read the local secret key: {e}")),
        };
        Ok(ChaCha20Poly1305::new(Key::from_slice(&key)))
    }
    fn entries(&self) -> Result<BTreeMap<String, Entry>, String> {
        match fs::read(self.dir.join("secrets.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("Could not read the local secret store: {e}")),
        }
    }
    fn save(&self, entries: &BTreeMap<String, Entry>) -> Result<(), String> {
        write_private(
            &self.dir.join("secrets.json"),
            &serde_json::to_vec(entries).map_err(|e| e.to_string())?,
        )
    }
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Stores a secret with no release target.
    pub fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.put_for(id, secret, "")
    }
    /// Stores a secret that is only released to `target`.
    pub fn put_for(&self, id: &str, secret: &str, target: &str) -> Result<(), String> {
        let _guard = Self::lock();
        let cipher = self.cipher()?;
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let aad = associated_data(id, Some(target));
        let sealed = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: secret.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(|_| "Could not seal the secret".to_string())?;
        let mut entries = self.entries()?;
        entries.insert(
            id.into(),
            Entry::Bound {
                target: target.into(),
                sealed: STANDARD.encode([nonce.as_slice(), &sealed].concat()),
            },
        );
        self.save(&entries)
    }
    /// Reads a secret stored with no release target.
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        self.get_for(id, "").map_err(|e| e.message)
    }
    /// Reads a secret, refusing (CREDENTIAL_TARGET_MISMATCH) when it was
    /// stored for a different target or before targets were recorded.
    pub fn get_for(&self, id: &str, target: &str) -> Result<Option<String>, SecretError> {
        let _guard = Self::lock();
        let Some(entry) = self.entries()?.remove(id) else {
            return Ok(None);
        };
        let (encoded, aad) = match entry {
            Entry::Bound { target: t, sealed } if t == target => {
                (sealed, associated_data(id, Some(target)))
            }
            Entry::Legacy(sealed) if target.is_empty() => (sealed, associated_data(id, None)),
            _ => return Err(SecretError::mismatch()),
        };
        let raw = STANDARD
            .decode(encoded)
            .map_err(|e| SecretError::io(e.to_string()))?;
        if raw.len() < 12 {
            return Err(SecretError::io("A stored secret is corrupt"));
        }
        let (nonce, sealed) = raw.split_at(12);
        let plain = self
            .cipher()?
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: sealed,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                SecretError::io("A stored secret could not be opened with this machine's key")
            })?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|e| SecretError::io(e.to_string()))
    }
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _guard = Self::lock();
        let mut entries = self.entries()?;
        if entries.remove(id).is_some() {
            self.save(&entries)?;
        }
        Ok(())
    }
}

/// The secret-store key of a datasource's password.
pub fn datasource_secret_id(datasource_id: &str) -> String {
    format!("datasource:{datasource_id}")
}

/// What a datasource password is bound to: datasource id, host, port,
/// database, and user. A document that points a stored password at another
/// server gets CREDENTIAL_TARGET_MISMATCH instead of the password.
pub fn datasource_target(ds: &DatasourceConfig) -> String {
    serde_json::json!(["pg", ds.id, ds.host, ds.port, ds.database, ds.user]).to_string()
}

/// Fails closed (INSECURE_TRANSPORT) when a PostgreSQL datasource allows
/// plaintext and the developer has not confirmed the override (PRD §21.4).
pub fn ensure_transport(ds: &DatasourceConfig) -> Result<(), SecretError> {
    if ds.is_postgres() && ds.allows_plaintext() && !ds.insecure_transport_confirmed {
        return Err(SecretError {
            code: "INSECURE_TRANSPORT",
            message: format!(
                "The datasource uses sslmode {} which allows connections without TLS; confirm the security override in Datasource settings before connecting",
                ds.sslmode
            ),
        });
    }
    Ok(())
}

/// The password referenced by a datasource config, released only to the
/// target it was stored for and only over a confirmed transport.
pub fn datasource_credential(ds: &DatasourceConfig) -> Result<Option<String>, SecretError> {
    let Some(r) = ds.password_ref.as_deref().filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    ensure_transport(ds)?;
    if r != datasource_secret_id(&ds.id) {
        return Err(SecretError::mismatch());
    }
    SecretStore::default_location()?.get_for(r, &datasource_target(ds))
}

/// [`datasource_credential`] with a plain message error.
pub fn datasource_password(ds: &DatasourceConfig) -> Result<Option<String>, String> {
    datasource_credential(ds).map_err(|e| e.message)
}

/// Stores a datasource password bound to the datasource's current target.
pub fn store_datasource_password(ds: &DatasourceConfig, password: &str) -> Result<String, String> {
    let id = datasource_secret_id(&ds.id);
    SecretStore::default_location()?.put_for(&id, password, &datasource_target(ds))?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_store() -> (PathBuf, SecretStore) {
        let dir = std::env::temp_dir().join(format!("ixtable-secrets-{}", uuid::Uuid::new_v4()));
        let store = SecretStore::open(&dir).unwrap();
        (dir, store)
    }
    #[test]
    fn secrets_are_sealed_bound_to_their_id_and_private() {
        let (dir, store) = temp_store();
        store.put("datasource:a", "pässword").unwrap();
        assert_eq!(
            store.get("datasource:a").unwrap().as_deref(),
            Some("pässword")
        );
        let file = fs::read_to_string(dir.join("secrets.json")).unwrap();
        assert!(!file.contains("pässword"));
        let mut entries = store.entries().unwrap();
        let sealed = entries.remove("datasource:a").unwrap();
        entries.insert("datasource:b".into(), sealed);
        store.save(&entries).unwrap();
        assert!(
            store.get("datasource:b").is_err(),
            "AAD binds the secret to its id"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in ["secret.key", "secrets.json"] {
                let mode = fs::metadata(dir.join(f)).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{f}");
            }
        }
        store.delete("datasource:b").unwrap();
        assert_eq!(store.get("datasource:b").unwrap(), None);
        let _ = fs::remove_dir_all(dir);
    }

    fn pg(host: &str) -> DatasourceConfig {
        DatasourceConfig {
            kind: "postgres".into(),
            id: "ds1".into(),
            host: host.into(),
            database: "app".into(),
            user: "app".into(),
            password_ref: Some(datasource_secret_id("ds1")),
            ..Default::default()
        }
    }

    #[test]
    fn a_password_is_only_released_to_the_server_it_was_stored_for() {
        let (dir, store) = temp_store();
        let id = datasource_secret_id("ds1");
        let good = pg("db.example.com");
        store
            .put_for(&id, "s3cret", &datasource_target(&good))
            .unwrap();
        assert_eq!(
            store.get_for(&id, &datasource_target(&good)).unwrap().as_deref(),
            Some("s3cret")
        );
        // A crafted document reusing the reference against another server.
        for evil in [
            pg("evil.example.com"),
            DatasourceConfig { port: 6543, ..good.clone() },
            DatasourceConfig { database: "other".into(), ..good.clone() },
            DatasourceConfig { user: "postgres".into(), ..good.clone() },
            DatasourceConfig { id: "ds2".into(), ..good.clone() },
        ] {
            let err = store.get_for(&id, &datasource_target(&evil)).unwrap_err();
            assert_eq!(err.code, "CREDENTIAL_TARGET_MISMATCH");
            assert!(err.message.contains("Re-enter the password"));
        }
        // Editing the recorded target in secrets.json breaks the AEAD tag.
        let mut entries = store.entries().unwrap();
        if let Some(Entry::Bound { target, .. }) = entries.get_mut(&id) {
            *target = datasource_target(&pg("evil.example.com"));
        }
        store.save(&entries).unwrap();
        let err = store
            .get_for(&id, &datasource_target(&pg("evil.example.com")))
            .unwrap_err();
        assert_eq!(err.code, "IO_ERROR");
        // Unbound legacy entries are never released to a datasource.
        let mut entries = store.entries().unwrap();
        entries.insert(id.clone(), Entry::Legacy("AAAAAAAAAAAAAAAA".into()));
        store.save(&entries).unwrap();
        assert_eq!(
            store.get_for(&id, &datasource_target(&good)).unwrap_err().code,
            "CREDENTIAL_TARGET_MISMATCH"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn credentials_fail_closed_over_unconfirmed_plaintext_or_a_foreign_reference() {
        let mut ds = pg("db.example.com");
        ds.sslmode = "disable".into();
        assert_eq!(
            datasource_credential(&ds).unwrap_err().code,
            "INSECURE_TRANSPORT"
        );
        assert_eq!(ensure_transport(&ds).unwrap_err().code, "INSECURE_TRANSPORT");
        ds.insecure_transport_confirmed = true;
        assert!(ensure_transport(&ds).is_ok());
        ds.sslmode = "prefer".into();
        ds.insecure_transport_confirmed = false;
        assert!(ensure_transport(&ds).is_err());
        let mut other = pg("db.example.com");
        other.password_ref = Some(datasource_secret_id("someone-else"));
        assert_eq!(
            datasource_credential(&other).unwrap_err().code,
            "CREDENTIAL_TARGET_MISMATCH"
        );
    }

    #[test]
    fn read_errors_never_regenerate_the_key() {
        let (dir, store) = temp_store();
        store.put("k", "v").unwrap();
        // A key path that exists but cannot be read as a file.
        fs::rename(dir.join("secret.key"), dir.join("key.bak")).unwrap();
        fs::create_dir(dir.join("secret.key")).unwrap();
        assert!(store.get("k").is_err());
        assert!(store.put("k2", "v").is_err());
        assert!(dir.join("secret.key").is_dir(), "not replaced");
        fs::remove_dir(dir.join("secret.key")).unwrap();
        fs::rename(dir.join("key.bak"), dir.join("secret.key")).unwrap();
        assert_eq!(store.get("k").unwrap().as_deref(), Some("v"));
        // An unreadable store file is an error, not an empty store.
        let json = dir.join("secrets.json");
        fs::remove_file(&json).unwrap();
        fs::create_dir(&json).unwrap();
        assert!(store.put("k3", "v").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_puts_keep_every_secret() {
        let (dir, store) = temp_store();
        let store = std::sync::Arc::new(store);
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let s = store.clone();
                std::thread::spawn(move || s.put(&format!("k{i}"), &format!("v{i}")).unwrap())
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        for i in 0..16 {
            assert_eq!(store.get(&format!("k{i}")).unwrap(), Some(format!("v{i}")));
        }
        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(dir);
    }
}
