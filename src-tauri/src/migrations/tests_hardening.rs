use super::*;

fn m(id: &str, order: u32, up: &str) -> Migration {
    Migration {
        id: id.into(),
        name: format!("M {id}"),
        order,
        up: up.into(),
        ..Default::default()
    }
}

fn temp_db() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ixtable-migrations-{}.db", uuid::Uuid::new_v4()));
    rusqlite::Connection::open(&path).unwrap();
    path
}

fn count(path: &Path, sql: &str) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

#[test]
fn runtime_path_rejects_broken_dependencies_before_running_sql() {
    let path = temp_db();
    let list = vec![
        m("a", 1, "CREATE TABLE a(x)"),
        Migration {
            depends_on: vec!["ghost".into()],
            ..m("b", 2, "CREATE TABLE b(x)")
        },
    ];
    let err = apply_sqlite(&path, &list).unwrap_err();
    assert!(err.contains("depends on unknown migration ghost"), "{err}");
    let tables = count(
        &path,
        "SELECT count(*) FROM sqlite_master WHERE name IN ('a','b')",
    );
    assert_eq!(tables, 0, "no SQL ran, not even the valid first migration");
    // A dependency ordered after its dependent is also unmet.
    let reversed = vec![
        Migration {
            depends_on: vec!["z".into()],
            ..m("y", 1, "CREATE TABLE y(x)")
        },
        m("z", 2, "CREATE TABLE z(x)"),
    ];
    assert!(apply_sqlite(&path, &reversed)
        .unwrap_err()
        .contains("not ordered before"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn runtime_path_rejects_an_edited_applied_migration() {
    let path = temp_db();
    apply_sqlite(&path, &[m("a", 1, "CREATE TABLE a(x)")]).unwrap();
    let edited = vec![
        m("a", 1, "CREATE TABLE a(y)"),
        m("b", 2, "CREATE TABLE b(x)"),
    ];
    let err = apply_sqlite(&path, &edited).unwrap_err();
    assert!(err.contains("changed after it was applied"), "{err}");
    assert_eq!(
        count(&path, "SELECT count(*) FROM sqlite_master WHERE name = 'b'"),
        0
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn statement_split_follows_sqlite_rules() {
    let sql = "CREATE TABLE t(x TEXT); -- a; comment\nINSERT INTO t VALUES ('a;b');\n\
CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET x = 'y;'; DELETE FROM t WHERE x = 'z'; END;\n\
/* c; */ SELECT 1";
    let parts = split::statements(sql);
    assert_eq!(parts.len(), 4, "{parts:?}");
    assert!(parts[1].contains("'a;b'"));
    assert!(parts[2].starts_with("CREATE TRIGGER") && parts[2].ends_with("END;"));
    assert!(parts[3].ends_with("SELECT 1;"));
    assert!(split::statements("  ;; ").is_empty());
}

#[test]
fn history_records_real_times_and_health_outcome() {
    let path = temp_db();
    let list = vec![m("a", 1, "CREATE TABLE a(id INTEGER PRIMARY KEY); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 20000) INSERT INTO a SELECT i FROM n;")];
    let logs = apply_sqlite(&path, &list).unwrap();
    assert!(logs[0].finished_at > logs[0].started_at);
    let mut store = SqliteRecordStore::new(&path);
    let h = history(&mut store).unwrap();
    assert_eq!(h.len(), 1);
    assert!(h[0].started_at < h[0].finished_at, "{:?}", h[0]);
    assert!(
        h[0].health.contains(&"integrity_check: ok".to_string()),
        "{:?}",
        h[0].health
    );
    // A failed health check is stored too.
    let bad = m("bad", 2, "PRAGMA defer_foreign_keys = ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(p INTEGER REFERENCES p(id)); INSERT INTO c VALUES (9);");
    let mut all = list.clone();
    all.push(bad);
    assert!(apply_sqlite(&path, &all).is_err());
    let h = history(&mut store).unwrap();
    let failed = h.iter().find(|l| l.status == "failed").unwrap();
    assert!(
        failed.health[0].starts_with("failed: ") && failed.health[0].contains("health check"),
        "{failed:?}"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn history_reads_logs_written_before_the_new_columns() {
    let path = temp_db();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE _ixtable_migrations(id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); \
             CREATE TABLE _ixtable_migration_log(migration_id TEXT NOT NULL, name TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL, checksum TEXT NOT NULL, at TEXT NOT NULL, log TEXT, error TEXT); \
             INSERT INTO _ixtable_migration_log VALUES ('o','Old','up','applied','x','2020-01-01T00:00:00Z','up: Old','');",
        )
        .unwrap();
    let mut store = SqliteRecordStore::new(&path);
    let h = history(&mut store).unwrap();
    assert_eq!(h[0].started_at, "2020-01-01T00:00:00Z");
    assert!(h[0].health.is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn recovery_text_names_the_assets_tab() {
    let text = recovery(&m("a", 1, "x"), "boom", Some("cp1"));
    assert!(text.contains("Settings › Assets › Checkpoints"), "{text}");
    assert!(!text.contains("Problems/Recovery"));
}
