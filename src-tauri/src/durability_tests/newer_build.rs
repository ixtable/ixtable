//! Archives written by a newer ixtable (PRD §26.5, docs/decisions/archive-format.md).
//! `tests/fixtures/archives/newer-build/` holds three variants of the committed
//! `format-2/crm.ixt`, listed with their sha256 and expected outcome in
//! `expectations.json`: a newer archive format and a newer config version, which
//! this build refuses without touching the file, and unknown entries at the current
//! versions (an extra table, index, and view, extra columns in known tables, extra
//! top-level config fields), which open and keep what the record promises on save.
//! Written once by `node scripts/ci/write-archive-fixtures.mjs --newer-build`; like
//! every released fixture, never rewritten.
use super::{count_rows, fixtures::root, fresh_manager};
use crate::archive_io;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Far ahead of any real version, so the refusal fixtures stay newer than this build.
const FUTURE_VERSION: i64 = 99;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Expectation {
    file: String,
    /// `refuse` (an `UNSUPPORTED_VERSION` error) or `open`.
    outcome: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    message: String,
    sha256: String,
}

fn dir() -> PathBuf {
    root().join("newer-build")
}

fn expectations() -> Vec<Expectation> {
    serde_json::from_slice(&fs::read(dir().join("expectations.json")).unwrap()).unwrap()
}

fn expectation(file: &str) -> Expectation {
    expectations()
        .into_iter()
        .find(|e| e.file == file)
        .unwrap_or_else(|| panic!("{file} is not in expectations.json"))
}

fn sha(path: &Path) -> String {
    archive_io::sha256_hex(&fs::read(path).unwrap())
}

/// A working copy of a committed fixture in `base`: tests never touch the original.
fn copy(base: &Path, file: &str) -> PathBuf {
    let path = base.join(file);
    fs::copy(dir().join(file), &path).unwrap();
    path
}

fn strings(conn: &Connection, sql: &str) -> Vec<String> {
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
    rows.map(Result::unwrap).collect()
}

#[test]
fn newer_build_fixtures_match_their_checksums() {
    let listed = expectations();
    let mut files: Vec<String> = listed.iter().map(|e| e.file.clone()).collect();
    for e in &listed {
        assert_eq!(
            sha(&dir().join(&e.file)),
            e.sha256,
            "newer-build/{} changed; released fixtures are never rewritten",
            e.file
        );
    }
    files.push("expectations.json".into());
    files.sort();
    let mut present: Vec<String> = fs::read_dir(dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    present.sort();
    assert_eq!(present, files);
}

/// A newer format or config version fails with `UNSUPPORTED_VERSION` and an update
/// hint, opens no session, and leaves the file byte for byte as it was.
#[test]
fn newer_format_and_config_versions_are_refused_without_touching_the_file() {
    let (base, m) = fresh_manager("newer-build-refuse");
    for file in ["newer-format.ixt", "newer-config.ixt"] {
        let e = expectation(file);
        assert_eq!(e.outcome, "refuse", "{file}");
        let path = copy(&base, file);
        let before = sha(&path);
        let err = m.open(file, &path).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_VERSION", "{file}: {err}");
        assert_eq!(err.message, e.message, "{file}");
        assert!(err.message.contains("Update ixtable"), "{file}: {err}");
        assert!(m.state(file).is_err(), "{file}: no session is opened");
        assert_eq!(sha(&path), before, "{file}: the archive is untouched");
        assert!(archive_io::stale_temp_files(&path).is_empty(), "{file}");
    }
    let header = archive_io::read_header(&dir().join("newer-format.ixt")).unwrap_err();
    assert!(matches!(
        header,
        crate::archive::ArchiveError::NewerFormat(FUTURE_VERSION)
    ));
    let _ = fs::remove_dir_all(base);
}

/// At the current versions, unknown entries open. A save keeps unknown tables (rows
/// and indexes) and unknown top-level config fields; it drops unknown views and extra
/// columns of known tables, as the record says.
#[test]
fn unknown_entries_open_and_survive_a_save_as_recorded() {
    let file = "unknown-entries.ixt";
    assert_eq!(expectation(file).outcome, "open");
    let (base, m) = fresh_manager("newer-build-open");
    let path = copy(&base, file);
    m.open(file, &path).unwrap();
    let config = m.config(file).unwrap();
    assert_eq!(
        config.extra["futureWorkflows"][0]["name"],
        "Escalate stale deals"
    );
    assert_eq!(config.extra["futureTheme"]["accent"], "#0f766e");
    assert!(count_rows(&m, file, "deals") > 0);
    m.mark_data_dirty(file).unwrap();
    m.save(file, None).unwrap();
    m.close(file, true).unwrap();

    archive_io::verify(&path).unwrap();
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        strings(&conn, "SELECT entry FROM future_audit_log ORDER BY id"),
        ["created", "stage changed", "closed won"]
    );
    let schema = |kind: &str| {
        strings(
            &conn,
            &format!("SELECT name FROM sqlite_master WHERE type='{kind}' AND name LIKE 'future%' ORDER BY name"),
        )
    };
    assert_eq!(schema("index"), ["future_audit_log_at"]);
    assert!(schema("view").is_empty(), "views are never copied");
    let columns = |table: &str| {
        strings(
            &conn,
            &format!("SELECT name FROM pragma_table_info('{table}')"),
        )
    };
    assert!(!columns("archive_metadata").contains(&"build_channel".to_string()));
    assert!(!columns("attachments").contains(&"thumbnail".to_string()));
    let json: String = conn
        .query_row("SELECT json FROM document_config", [], |r| r.get(0))
        .unwrap();
    let saved: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(saved["futureWorkflows"], config.extra["futureWorkflows"]);
    assert_eq!(saved["futureTheme"], config.extra["futureTheme"]);
    drop(conn);

    m.open(file, &path).unwrap();
    assert_eq!(m.config(file).unwrap().extra, config.extra);
    m.close(file, true).unwrap();
    let _ = fs::remove_dir_all(base);
}

/// Writes `newer-build/` from the committed `format-2/crm.ixt`. Refuses to overwrite.
#[test]
#[ignore = "writes committed fixtures: node scripts/ci/write-archive-fixtures.mjs --newer-build"]
fn write_newer_build_archive_fixtures() {
    let dir = dir();
    assert!(
        !dir.exists(),
        "{} exists; released fixtures are never rewritten",
        dir.display()
    );
    let doc = archive_io::read_archive(&root().join("format-2/crm.ixt")).unwrap();
    fs::create_dir_all(&dir).unwrap();
    let write = |file: &str, sql: &str| {
        let path = dir.join(file);
        archive_io::write_archive(&path, &doc).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(sql).unwrap();
        path
    };
    let set_config = |path: &Path, edit: &dyn Fn(&mut serde_json::Value)| {
        let conn = Connection::open(path).unwrap();
        let json: String = conn
            .query_row("SELECT json FROM document_config", [], |r| r.get(0))
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        edit(&mut value);
        conn.execute(
            "UPDATE document_config SET version=?1, json=?2",
            params![value["version"].as_i64().unwrap(), value.to_string()],
        )
        .unwrap();
    };

    write(
        "newer-format.ixt",
        &format!(
            "UPDATE archive_metadata SET format_version={FUTURE_VERSION}, application_version='9.0.0';
             CREATE TABLE future_manifest(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO future_manifest VALUES('layout','format {FUTURE_VERSION}');"
        ),
    );
    let newer_config = write(
        "newer-config.ixt",
        "UPDATE archive_metadata SET application_version='9.0.0';",
    );
    set_config(&newer_config, &|v| {
        v["version"] = FUTURE_VERSION.into();
        v["futureWorkflows"] = serde_json::json!([]);
    });
    let unknown = write(
        "unknown-entries.ixt",
        "UPDATE archive_metadata SET application_version='9.0.0';
         ALTER TABLE archive_metadata ADD COLUMN build_channel TEXT NOT NULL DEFAULT 'nightly';
         ALTER TABLE attachments ADD COLUMN thumbnail BLOB;
         CREATE TABLE future_audit_log(id INTEGER PRIMARY KEY, at TEXT NOT NULL, entry TEXT NOT NULL);
         CREATE INDEX future_audit_log_at ON future_audit_log(at);
         INSERT INTO future_audit_log(at, entry) VALUES
           ('2026-01-01T00:00:00Z','created'),('2026-01-02T00:00:00Z','stage changed'),('2026-01-03T00:00:00Z','closed won');
         CREATE VIEW future_recent AS SELECT * FROM future_audit_log ORDER BY at DESC LIMIT 1;",
    );
    set_config(&unknown, &|v| {
        v["futureWorkflows"] = serde_json::json!([
            {"id": "6b1f2a8e-3c4d-4e5f-9a0b-1c2d3e4f5a6b", "name": "Escalate stale deals", "steps": [{"kind": "notify", "after": "P7D"}]}
        ]);
        v["futureTheme"] = serde_json::json!({"accent": "#0f766e", "density": "compact"});
    });

    let refuse = |file: &str, message: String| Expectation {
        file: file.into(),
        outcome: "refuse".into(),
        message,
        sha256: sha(&dir.join(file)),
    };
    let list = vec![
        refuse(
            "newer-config.ixt",
            format!("This document's configuration (version {FUTURE_VERSION}) was created by a newer ixtable. Update ixtable to open it."),
        ),
        refuse(
            "newer-format.ixt",
            format!("This document was created by a newer ixtable (format {FUTURE_VERSION}). Update ixtable to open it."),
        ),
        Expectation {
            file: "unknown-entries.ixt".into(),
            outcome: "open".into(),
            message: String::new(),
            sha256: sha(&unknown),
        },
    ];
    fs::write(
        dir.join("expectations.json"),
        format!("{}\n", serde_json::to_string_pretty(&list).unwrap()),
    )
    .unwrap();
}
