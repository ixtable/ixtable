//! Durable local state location and path-safety helpers.
//!
//! The state directory holds the global store, recovery workspaces, checkpoints,
//! jobs, logs, signing keys, and datasource secrets. It is resolved once:
//! `IXTABLE_STATE_DIR` when set (tests), else the directory the Tauri app passes
//! to [`init_app_dir`] (its app-local-data dir), else the platform data dir plus
//! `ixtable`. It is never the OS temp dir, which other users can read and the OS
//! may purge, except in unit tests without `IXTABLE_STATE_DIR`, which get a
//! private per-process temp dir instead of the developer's real state.
use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    sync::OnceLock,
};

static STATE: OnceLock<PathBuf> = OnceLock::new();
const ENV: &str = "IXTABLE_STATE_DIR";

/// Called from the Tauri `setup` hook before any command runs. `IXTABLE_STATE_DIR`
/// still wins; the first resolution wins.
pub fn init_app_dir(dir: PathBuf) {
    let chosen = env_dir(|k| std::env::var_os(k)).unwrap_or(dir);
    let _ = STATE.set(prepare(chosen));
}

/// Root of all durable local state (`<state>/data`, `<state>/cache`, `<state>/logs`).
pub fn state_dir() -> PathBuf {
    STATE.get_or_init(|| prepare(default_dir())).clone()
}

#[cfg(not(test))]
fn default_dir() -> PathBuf {
    resolve(|k| std::env::var_os(k))
}
#[cfg(test)]
fn default_dir() -> PathBuf {
    env_dir(|k| std::env::var_os(k)).unwrap_or_else(|| {
        std::env::temp_dir().join(format!("ixtable-test-state-{}", uuid::Uuid::new_v4()))
    })
}

fn prepare(dir: PathBuf) -> PathBuf {
    if let Err(e) = create_private_dir(&dir) {
        eprintln!("ixtable: could not create state dir {}: {e}", dir.display());
    }
    dir
}

fn env_dir(get: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    get(ENV).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `IXTABLE_STATE_DIR`, else the platform's per-user data dir plus `ixtable`.
pub(crate) fn resolve(get: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    if let Some(dir) = env_dir(&get) {
        return dir;
    }
    let nonempty = |k: &str| get(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = nonempty("HOME").or_else(|| nonempty("USERPROFILE"));
    let base = if cfg!(windows) {
        nonempty("LOCALAPPDATA").or_else(|| home.map(|h| h.join("AppData").join("Local")))
    } else if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library").join("Application Support"))
    } else {
        nonempty("XDG_DATA_HOME")
            .filter(|p| p.is_absolute())
            .or_else(|| home.map(|h| h.join(".local").join("share")))
    };
    base.or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ixtable")
}

/// Creates `dir` (and missing parents) readable only by the current user (0700 on unix).
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Like [`create_private_dir`], and tightens an existing leaf dir the current user
/// owns to 0700 (for directories holding keys and secrets).
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    create_private_dir(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() {
            return Err(io::Error::other(format!(
                "{} is not a directory",
                dir.display()
            )));
        }
        if meta.uid() == current_uid() && meta.mode() & 0o077 != 0 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Checks that a key or secret file is safe to trust: a regular file (not a
/// symlink) owned by the current user with no group/other permission bits.
///
/// Windows: not checked. Files under the per-user `%LOCALAPPDATA%` inherit an
/// ACL limited to the user, SYSTEM, and administrators; ixtable does not inspect ACLs.
pub fn check_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !meta.file_type().is_file() {
            return Err(format!("{} is not a regular file", path.display()));
        }
        if meta.uid() != current_uid() {
            return Err(format!(
                "{} is owned by another user; refusing to use it",
                path.display()
            ));
        }
        if meta.mode() & 0o077 != 0 {
            return Err(format!(
                "{} is readable or writable by other users (mode {:o}); restrict it to 0600",
                path.display(),
                meta.mode() & 0o777
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Ids used as single path components (attachment ids, document ids, checkpoint
/// ids): UUIDs or `[A-Za-z0-9_-]{1,64}`. Rejects `.`/`..`, separators, and NULs.
pub fn is_safe_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `parent/<id>` for a validated id. Unsafe ids never escape `parent`: they map
/// to a hashed component instead (callers reject them earlier; this is defense in depth).
pub fn child(parent: &Path, id: &str) -> PathBuf {
    let path = if is_safe_id(id) {
        parent.join(id)
    } else {
        parent.join(format!(
            "_invalid-{}",
            &crate::archive_io::sha256_hex(id.as_bytes())[..32]
        ))
    };
    debug_assert_eq!(path.parent(), Some(parent));
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), OsString::from(v)))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn state_dir_prefers_env_then_platform_dir_never_temp() {
        assert_eq!(
            resolve(env(&[("IXTABLE_STATE_DIR", "/s"), ("HOME", "/h")])),
            PathBuf::from("/s")
        );
        let platform = resolve(env(&[("HOME", "/home/u"), ("LOCALAPPDATA", "C:/L")]));
        #[cfg(target_os = "linux")]
        assert_eq!(platform, PathBuf::from("/home/u/.local/share/ixtable"));
        #[cfg(target_os = "macos")]
        assert_eq!(
            platform,
            PathBuf::from("/home/u/Library/Application Support/ixtable")
        );
        #[cfg(windows)]
        assert_eq!(platform, PathBuf::from("C:/L/ixtable"));
        #[cfg(target_os = "linux")]
        assert_eq!(
            resolve(env(&[("HOME", "/home/u"), ("XDG_DATA_HOME", "/x")])),
            PathBuf::from("/x/ixtable")
        );
        // An empty IXTABLE_STATE_DIR is ignored, and the temp dir is never chosen.
        let empty = resolve(env(&[("IXTABLE_STATE_DIR", ""), ("HOME", "/home/u")]));
        assert!(empty.starts_with("/home/u") || empty.starts_with("C:/L"));
        assert!(!platform.starts_with(std::env::temp_dir()));
    }

    #[test]
    fn unsafe_ids_never_leave_the_parent() {
        assert!(is_safe_id("2f1e0c1a-9b9e-4c3a-8f00-0123456789ab"));
        assert!(is_safe_id("asset_1"));
        for bad in [
            "",
            "..",
            ".",
            "../x",
            "a/b",
            "a\\b",
            "/etc",
            "a\0b",
            &"x".repeat(65),
        ] {
            assert!(!is_safe_id(bad), "{bad:?}");
            let p = child(Path::new("/w/attachments"), bad);
            assert_eq!(p.parent(), Some(Path::new("/w/attachments")), "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn private_files_must_be_owned_and_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ixtable-paths-{}", uuid::Uuid::new_v4()));
        ensure_private_dir(&dir).unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let key = dir.join("k");
        fs::write(&key, b"k").unwrap();
        fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(check_private_file(&key)
            .unwrap_err()
            .contains("other users"));
        fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
        check_private_file(&key).unwrap();
        let link = dir.join("l");
        std::os::unix::fs::symlink(&key, &link).unwrap();
        assert!(check_private_file(&link).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
