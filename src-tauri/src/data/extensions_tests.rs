use super::extensions::{pin, resolve, resource_dirs, Pin, Scanner};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const PAYLOAD: &[u8] = b"\x7fELF fake scanner payload";

fn hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(bytes).unwrap();
    enc.finish().unwrap()
}

/// A temp `resources` dir holding the archive, a cache root, and a matching pin.
fn fixture() -> (PathBuf, PathBuf, PathBuf, Pin) {
    let root = std::env::temp_dir().join(format!("ixtable-ext-{}", uuid::Uuid::new_v4()));
    let res = root.join("resources");
    fs::create_dir_all(&res).unwrap();
    let archive = gzip(PAYLOAD);
    fs::write(res.join("sqlite_scanner.duckdb_extension.gz"), &archive).unwrap();
    let pin = Pin {
        name: "sqlite_scanner",
        label: "SQLite",
        compressed: hex(&archive),
        uncompressed: hex(PAYLOAD),
    };
    (root.clone(), res, root.join("cache"), pin)
}

fn cached(cache: &Path, pin: &Pin) -> PathBuf {
    cache
        .join(&pin.uncompressed)
        .join("sqlite_scanner.duckdb_extension")
}

#[test]
fn archive_is_verified_unpacked_and_reused() {
    let (root, res, cache, pin) = fixture();
    let path = resolve(&pin, None, std::slice::from_ref(&res), &cache).unwrap();
    assert_eq!(path, cached(&cache, &pin));
    assert_eq!(fs::read(&path).unwrap(), PAYLOAD);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&cache), 0o700);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        assert_eq!(mode(&path), 0o600);
    }
    // A verified cache entry is used without reading the archive again.
    fs::write(res.join("sqlite_scanner.duckdb_extension.gz"), b"garbage").unwrap();
    assert_eq!(resolve(&pin, None, &[res], &cache).unwrap(), path);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tampered_archive_is_rejected() {
    let (root, res, cache, pin) = fixture();
    let gz = res.join("sqlite_scanner.duckdb_extension.gz");
    // Different archive bytes: the compressed pin fails before unpacking.
    fs::write(&gz, gzip(b"evil payload")).unwrap();
    let err = resolve(&pin, None, std::slice::from_ref(&res), &cache).unwrap_err();
    assert!(err.contains("archive checksum mismatch"), "{err}");
    assert!(!cached(&cache, &pin).exists());
    // An archive matching the compressed pin must still unpack to the pinned bytes.
    let other = Pin {
        compressed: hex(&fs::read(&gz).unwrap()),
        ..pin.clone()
    };
    let err = resolve(&other, None, &[res], &cache).unwrap_err();
    assert!(err.contains("SQLite extension checksum mismatch"), "{err}");
    assert!(!cached(&cache, &pin).exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tampered_cache_is_replaced() {
    let (root, res, cache, pin) = fixture();
    let path = resolve(&pin, None, std::slice::from_ref(&res), &cache).unwrap();
    fs::write(&path, b"evil payload").unwrap();
    assert_eq!(resolve(&pin, None, &[res], &cache).unwrap(), path);
    assert_eq!(fs::read(&path).unwrap(), PAYLOAD);
    let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn concurrent_unpacks_agree() {
    let (root, res, cache, pin) = fixture();
    let paths: Vec<_> = std::thread::scope(|s| {
        let jobs: Vec<_> = (0..8)
            .map(|_| s.spawn(|| resolve(&pin, None, std::slice::from_ref(&res), &cache)))
            .collect();
        jobs.into_iter()
            .map(|j| j.join().unwrap().unwrap())
            .collect()
    });
    assert!(paths.iter().all(|p| p == &cached(&cache, &pin)));
    assert_eq!(fs::read(&paths[0]).unwrap(), PAYLOAD);
    let entries = fs::read_dir(cache.join(&pin.uncompressed)).unwrap().count();
    assert_eq!(entries, 1, "temp files left behind");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn override_path_is_still_verified() {
    let (root, res, cache, pin) = fixture();
    let good = root.join("custom.duckdb_extension");
    fs::write(&good, PAYLOAD).unwrap();
    assert_eq!(
        resolve(&pin, Some(good.clone()), std::slice::from_ref(&res), &cache).unwrap(),
        good
    );
    assert!(!cache.exists(), "override must not unpack the archive");
    let bad = root.join("bad.duckdb_extension");
    fs::write(&bad, b"evil payload").unwrap();
    let err = resolve(&pin, Some(bad), std::slice::from_ref(&res), &cache).unwrap_err();
    assert!(err.contains("checksum mismatch"), "{err}");
    let err = resolve(&pin, Some(root.join("missing")), &[res], &cache).unwrap_err();
    assert!(err.contains("missing"), "{err}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unpacked_dev_copy_is_preferred_and_verified() {
    let (root, res, cache, pin) = fixture();
    let plain = res.join("sqlite_scanner.duckdb_extension");
    fs::write(&plain, PAYLOAD).unwrap();
    assert_eq!(
        resolve(&pin, None, std::slice::from_ref(&res), &cache).unwrap(),
        plain
    );
    assert!(!cache.exists());
    fs::write(&plain, b"").unwrap();
    let err = resolve(&pin, None, &[res], &cache).unwrap_err();
    assert!(err.contains("is empty"), "{err}");
    let err = resolve(&pin, None, &[root.join("nowhere")], &cache).unwrap_err();
    assert!(
        err.contains("Missing bundled DuckDB SQLite extension"),
        "{err}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn manifest_pins_every_platform() {
    for target in ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"] {
        for scanner in [Scanner::Sqlite, Scanner::Postgres] {
            let p = pin(scanner, target).unwrap();
            assert_ne!(p.compressed, p.uncompressed);
        }
    }
    assert!(pin(Scanner::Sqlite, "plan9-mips").is_err());
    // Spot-check against the previous compiled-in constants.
    assert_eq!(
        pin(Scanner::Postgres, "linux-x64").unwrap().uncompressed,
        "b1ced4cfc6311313e117c2afb3eac76508718778dde0716421503c7dbfb5605c"
    );
    assert_eq!(
        pin(Scanner::Sqlite, "macos-arm64").unwrap().uncompressed,
        "a3548846bd643cb717265a0a11352af2e830a466ca068f4cae2552af658879f2"
    );
}

/// The official archive for this platform unpacks to a file DuckDB loads (skipped
/// when `scripts/prepare-duckdb-artifacts.sh` has not been run).
#[test]
fn bundled_archive_unpacks_and_loads() {
    let Some(target) = resource_dirs().into_iter().next() else {
        return;
    };
    let gz = target.join("sqlite_scanner.duckdb_extension.gz");
    let Ok(pin) = pin(
        Scanner::Sqlite,
        target.file_name().unwrap().to_str().unwrap(),
    ) else {
        return;
    };
    if !gz.is_file() {
        eprintln!("skipped: {} not prepared", gz.display());
        return;
    }
    let root = std::env::temp_dir().join(format!("ixtable-ext-{}", uuid::Uuid::new_v4()));
    let res = root.join("resources");
    fs::create_dir_all(&res).unwrap();
    fs::copy(&gz, res.join("sqlite_scanner.duckdb_extension.gz")).unwrap();
    let path = resolve(&pin, None, &[res], &root.join("cache")).unwrap();
    let config = duckdb::Config::default()
        .enable_autoload_extension(false)
        .unwrap();
    let conn = duckdb::Connection::open_in_memory_with_flags(config).unwrap();
    let ext = path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("LOAD '{ext}'")).unwrap();
    let loaded: bool = conn
        .query_row(
            "SELECT loaded FROM duckdb_extensions() WHERE extension_name = 'sqlite_scanner'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(loaded);
    fs::remove_dir_all(root).unwrap();
}
