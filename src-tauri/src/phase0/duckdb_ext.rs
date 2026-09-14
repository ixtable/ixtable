//! Load the pinned, hashed DuckDB scanners. Autoload stays disabled.
use serde::Deserialize;
use std::{fs, path::PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    artifacts: serde_json::Value,
}

pub fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "macos-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        "unsupported"
    }
}

pub fn extension_path(name: &str) -> Result<PathBuf, String> {
    let target = target_triple();
    if target == "unsupported" {
        return Err("unsupported DuckDB extension target".into());
    }
    let relative = PathBuf::from("resources")
        .join("duckdb")
        .join(target)
        .join(name);
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&relative);
    if !path.is_file() {
        return Err(format!("missing {name} for {target} at {}", path.display()));
    }
    Ok(path)
}

pub fn sqlite_scanner() -> Result<PathBuf, String> {
    extension_path("sqlite_scanner.duckdb_extension")
}

pub fn postgres_scanner() -> Result<PathBuf, String> {
    extension_path("postgres_scanner.duckdb_extension")
}

pub fn manifest_lists_target(extension: &str) -> bool {
    let text = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/duckdb/manifest.json"),
    )
    .expect("manifest");
    let manifest: Manifest = serde_json::from_str(&text).expect("json");
    manifest
        .artifacts
        .get(extension)
        .and_then(|value| value.get(target_triple()))
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn manifest_covers_current_os_for_both_scanners() {
        assert!(manifest_lists_target("sqlite_scanner"), "{}", target_triple());
        assert!(
            manifest_lists_target("postgres_scanner"),
            "{}",
            target_triple()
        );
    }

    #[test]
    fn duckdb_inserts_local_rows() {
        let workspace = std::env::temp_dir().join(format!("ixtable-p0-sqlite-{}", Uuid::new_v4()));
        fs::create_dir_all(&workspace).unwrap();
        let db = workspace.join("data.db");
        let runtime = crate::data::ReadRuntime::open(db, std::path::Path::new("")).unwrap();
        runtime
            .connection()
            .execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY, label VARCHAR);")
            .unwrap();
        runtime
            .insert(
                "item",
                &[
                    crate::data::NamedValue {
                        column: "id".into(),
                        value: crate::data::DataValue::Integer(2),
                    },
                    crate::data::NamedValue {
                        column: "label".into(),
                        value: crate::data::DataValue::Text("after".into()),
                    },
                ],
            )
            .unwrap();
        let after = runtime.query("SELECT label FROM item ORDER BY id").unwrap();
        assert_eq!(
            after.rows[0][0],
            crate::data::DataValue::Text("after".into())
        );
        let _ = fs::remove_dir_all(workspace);
    }
}
