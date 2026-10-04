//! The pinned DuckDB scanner extensions: lookup, verification, and unpacking.
//!
//! App bundles ship each extension as the official
//! `<name>.duckdb_extension.gz`, a non-executable payload, so macOS
//! notarization never sees the extensions' ad-hoc-signed Mach-O. On first use
//! the archive is checked against its pinned compressed SHA-256, unpacked, and
//! checked against the pinned uncompressed SHA-256. The result is written
//! atomically to `<state>/duckdb-extensions/<uncompressed sha>/` (0700) and
//! reused while its hash still matches. Dev checkouts also hold the unpacked
//! file next to the archive and load that directly. Pins come from
//! `resources/duckdb/manifest.json`, compiled in.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

const MANIFEST: &str = include_str!("../../resources/duckdb/manifest.json");

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET: &str = "macos-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET: &str = "macos-x64";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET: &str = "windows-x64";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET: &str = "linux-x64";
#[cfg(not(any(
    all(
        target_os = "macos",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
const TARGET: &str = "unsupported";

/// One pinned extension file for this platform.
#[derive(Debug, Clone)]
pub(crate) struct Pin {
    /// Extension name; DuckDB derives its entry point from the file name.
    pub name: &'static str,
    pub label: &'static str,
    pub compressed: String,
    pub uncompressed: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Scanner {
    Sqlite,
    Postgres,
}

impl Scanner {
    fn env(self) -> &'static str {
        match self {
            Scanner::Sqlite => "IXTABLE_DUCKDB_SQLITE_EXTENSION",
            Scanner::Postgres => "IXTABLE_DUCKDB_POSTGRES_EXTENSION",
        }
    }
}

/// The manifest pins of `scanner` for `target`.
pub(crate) fn pin(scanner: Scanner, target: &str) -> Result<Pin, String> {
    let manifest: serde_json::Value =
        serde_json::from_str(MANIFEST).map_err(|e| format!("DuckDB extension manifest: {e}"))?;
    let (name, label, artifacts) = match scanner {
        Scanner::Sqlite => ("sqlite_scanner", "SQLite", &manifest["artifacts"]),
        Scanner::Postgres => (
            "postgres_scanner",
            "PostgreSQL",
            &manifest["postgresExtension"]["artifacts"],
        ),
    };
    let hash = |key: &str| {
        artifacts[target][key]
            .as_str()
            .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| format!("No pinned DuckDB {label} extension for {target}"))
    };
    Ok(Pin {
        name,
        label,
        compressed: hash("compressedSha256")?,
        uncompressed: hash("uncompressedSha256")?,
    })
}

/// The verified sqlite_scanner for this platform (`IXTABLE_DUCKDB_SQLITE_EXTENSION`
/// overrides the location, not the pin).
pub fn sqlite_extension_path() -> Result<PathBuf, String> {
    locate(Scanner::Sqlite)
}

/// The verified postgres_scanner for this platform
/// (`IXTABLE_DUCKDB_POSTGRES_EXTENSION` overrides the location, not the pin).
pub fn postgres_extension_path() -> Result<PathBuf, String> {
    locate(Scanner::Postgres)
}

fn locate(scanner: Scanner) -> Result<PathBuf, String> {
    let pin = pin(scanner, TARGET)?;
    let over = std::env::var_os(scanner.env())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    resolve(&pin, over, &resource_dirs(), &cache_root())
}

/// Where unpacked extensions live (per user, inside the 0700 state dir).
fn cache_root() -> PathBuf {
    crate::paths::state_dir().join("duckdb-extensions")
}

/// `resources/duckdb/<platform>` in the source tree, next to the executable
/// (dev, Windows), in a macOS bundle's `Contents/Resources`, and in
/// `/usr/lib/ixtable` (Linux deb, rpm, and AppImage).
pub(crate) fn resource_dirs() -> Vec<PathBuf> {
    let relative = PathBuf::from("resources").join("duckdb").join(TARGET);
    let mut dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&relative)];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join(&relative));
            dirs.push(parent.join("../Resources").join(&relative));
            dirs.push(parent.join("../lib/ixtable").join(&relative));
        }
    }
    dirs
}

/// A verified extension file: the override when given, else the first resource
/// dir holding the unpacked file (dev) or its archive (bundles, unpacked into
/// `cache`).
pub(crate) fn resolve(
    pin: &Pin,
    over: Option<PathBuf>,
    dirs: &[PathBuf],
    cache: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = over {
        verify(&read(&path, pin)?, pin)?;
        return Ok(path);
    }
    let file = format!("{}.duckdb_extension", pin.name);
    for dir in dirs {
        let plain = dir.join(&file);
        if plain.is_file() {
            verify(&read(&plain, pin)?, pin)?;
            return Ok(plain);
        }
        let packed = dir.join(format!("{file}.gz"));
        if packed.is_file() {
            return unpack(&packed, pin, cache);
        }
    }
    Err(format!(
        "Missing bundled DuckDB {} extension for {TARGET}",
        pin.label
    ))
}

fn read(path: &Path, pin: &Pin) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("DuckDB {} extension {}: {e}", pin.label, path.display()))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify(bytes: &[u8], pin: &Pin) -> Result<(), String> {
    if bytes.is_empty() {
        return Err(format!("DuckDB {} extension is empty", pin.label));
    }
    let actual = sha256(bytes);
    if actual != pin.uncompressed {
        return Err(format!(
            "DuckDB {} extension checksum mismatch: {actual}",
            pin.label
        ));
    }
    Ok(())
}

fn unpack(packed: &Path, pin: &Pin, cache: &Path) -> Result<PathBuf, String> {
    let dir = cache.join(&pin.uncompressed);
    let target = dir.join(format!("{}.duckdb_extension", pin.name));
    if fs::read(&target).is_ok_and(|b| verify(&b, pin).is_ok()) {
        return Ok(target);
    }
    let archive = read(packed, pin)?;
    let actual = sha256(&archive);
    if actual != pin.compressed {
        return Err(format!(
            "DuckDB {} extension archive checksum mismatch: {actual}",
            pin.label
        ));
    }
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(archive.as_slice())
        .read_to_end(&mut bytes)
        .map_err(|e| format!("DuckDB {} extension archive: {e}", pin.label))?;
    verify(&bytes, pin)?;
    let io = |e: std::io::Error| format!("DuckDB {} extension cache: {e}", pin.label);
    crate::paths::ensure_private_dir(cache).map_err(io)?;
    crate::paths::ensure_private_dir(&dir).map_err(io)?;
    remove_stale_temps(&dir);
    write_atomic(&dir, &target, &bytes, pin).map_err(io)?;
    Ok(target)
}

/// Writes a unique temp file and renames it over `target`, so a reader never sees
/// a partial file and concurrent processes each install identical bytes.
fn write_atomic(dir: &Path, target: &Path, bytes: &[u8], pin: &Pin) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        pin.name,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    let renamed = written.and_then(|()| fs::rename(&tmp, target));
    if renamed.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    // Windows cannot replace a file another process loaded; share it if it verifies.
    renamed.or_else(|e| match fs::read(target) {
        Ok(b) if verify(&b, pin).is_ok() => Ok(()),
        _ => Err(e),
    })
}

/// Drops temp files a crashed unpack left behind (older than an hour).
fn remove_stale_temps(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now() - Duration::from_secs(3600);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| t < cutoff);
        if stale && name.to_string_lossy().ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
}
