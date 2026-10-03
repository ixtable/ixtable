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
    std::env::var_os("IXTABLE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("ixtable"))
        .join("data")
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}
#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

impl SecretStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, String> {
        let dir = dir.into();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self { dir })
    }
    pub fn default_location() -> Result<Self, String> {
        Self::open(state_dir().join("secrets"))
    }
    fn cipher(&self) -> Result<ChaCha20Poly1305, String> {
        let path = self.dir.join("secret.key");
        let key = match fs::read(&path) {
            Ok(bytes) if bytes.len() == 32 => bytes,
            Ok(_) => return Err("The local secret key is corrupt".into()),
            Err(_) => {
                let key = ChaCha20Poly1305::generate_key(&mut OsRng).to_vec();
                write_private(&path, &key)?;
                key
            }
        };
        Ok(ChaCha20Poly1305::new(Key::from_slice(&key)))
    }
    fn entries(&self) -> Result<BTreeMap<String, String>, String> {
        match fs::read(self.dir.join("secrets.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(_) => Ok(BTreeMap::new()),
        }
    }
    fn save(&self, entries: &BTreeMap<String, String>) -> Result<(), String> {
        write_private(
            &self.dir.join("secrets.json"),
            &serde_json::to_vec(entries).map_err(|e| e.to_string())?,
        )
    }
    pub fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        let cipher = self.cipher()?;
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let sealed = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: secret.as_bytes(),
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| "Could not seal the secret".to_string())?;
        let mut entries = self.entries()?;
        entries.insert(
            id.into(),
            STANDARD.encode([nonce.as_slice(), &sealed].concat()),
        );
        self.save(&entries)
    }
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        let Some(encoded) = self.entries()?.remove(id) else {
            return Ok(None);
        };
        let raw = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        if raw.len() < 12 {
            return Err("A stored secret is corrupt".into());
        }
        let (nonce, sealed) = raw.split_at(12);
        let plain = self
            .cipher()?
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: sealed,
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| {
                "A stored secret could not be opened with this machine's key".to_string()
            })?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|e| e.to_string())
    }
    pub fn delete(&self, id: &str) -> Result<(), String> {
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

/// The password referenced by a datasource config, if one was stored.
pub fn datasource_password(ds: &DatasourceConfig) -> Result<Option<String>, String> {
    match ds.password_ref.as_deref() {
        Some(r) if !r.is_empty() => SecretStore::default_location()?.get(r),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_are_sealed_bound_to_their_id_and_private() {
        let dir = std::env::temp_dir().join(format!("ixtable-secrets-{}", uuid::Uuid::new_v4()));
        let store = SecretStore::open(&dir).unwrap();
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
            let mode = fs::metadata(dir.join("secret.key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        store.delete("datasource:b").unwrap();
        assert_eq!(store.get("datasource:b").unwrap(), None);
        let _ = fs::remove_dir_all(dir);
    }
}
