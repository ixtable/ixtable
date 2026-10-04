use super::*;
use crate::validation::Severity;

fn m(id: &str, order: u32, up: &str) -> Migration {
    Migration {
        id: id.into(),
        name: format!("M {id}"),
        order,
        up: up.into(),
        ..Default::default()
    }
}

#[test]
fn validation_enforces_order_dependencies_and_reversibility() {
    let mut config = DocumentConfig::default();
    config.migrations = vec![
        Migration {
            reversible: true,
            ..m("a", 1, "CREATE TABLE a(x)")
        },
        Migration {
            depends_on: vec!["c".into(), "missing".into()],
            ..m("b", 2, "")
        },
        m("c", 2, "SELECT 1"),
        Migration {
            target_store: "oracle".into(),
            ..m("d", 3, "SELECT 1")
        },
        Migration {
            target_store: "postgres".into(),
            ..m("e", 4, "SELECT 1")
        },
        Migration {
            target_store: "any".into(),
            ..m("f", 5, "SELECT 1")
        },
    ];
    let issues = validate(&config);
    let errors: Vec<&str> = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| i.message.as_str())
        .collect();
    assert!(errors
        .iter()
        .any(|e| e.contains("reversible but has no down")));
    assert!(errors.iter().any(|e| e.contains("has no up SQL")));
    assert!(errors.iter().any(|e| e.contains("shares order 2")));
    assert!(errors
        .iter()
        .any(|e| e.contains("unknown migration missing")));
    assert!(errors
        .iter()
        .any(|e| e.contains("must be ordered after its dependency")));
    assert!(errors.iter().any(|e| e.contains("unknown store oracle")));
    assert!(
        issues.iter().any(|i| i.object_id == "e"
            && i.severity == Severity::Error
            && i.message == format!("M e: {POSTGRES_UNSUPPORTED}")),
        "{issues:?}"
    );
    assert!(
        !issues.iter().any(|i| i.object_id == "f"),
        "legacy `any` still reads as the SQLite store"
    );
}

#[test]
fn new_migrations_target_sqlite() {
    let parsed: Migration =
        serde_json::from_str(r#"{"id":"a","name":"A","up":"SELECT 1"}"#).unwrap();
    assert_eq!(parsed.target_store, "sqlite");
    assert_eq!(Migration::default().target_store, "sqlite");
}

#[test]
fn apply_sqlite_runs_pending_in_order_once_and_stops_on_failure() {
    let path = std::env::temp_dir().join(format!("ixtable-migrations-{}.db", uuid::Uuid::new_v4()));
    rusqlite::Connection::open(&path).unwrap();
    let list = vec![
        m("second", 2, "INSERT INTO t VALUES (2);"),
        m("first", 1, "CREATE TABLE t(x INTEGER NOT NULL);"),
        Migration {
            target_store: "postgres".into(),
            ..m("pg", 3, "CREATE EXTENSION nope")
        },
    ];
    assert_eq!(
        pending(&path, &list)
            .unwrap()
            .iter()
            .map(|m| m.id.clone())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    let logs = apply_sqlite(&path, &list).unwrap();
    assert_eq!(logs.len(), 2);
    assert!(logs
        .iter()
        .all(|l| l.status == "applied" && l.health.contains(&"integrity_check: ok".to_string())));
    assert!(
        apply_sqlite(&path, &list).unwrap().is_empty(),
        "applied migrations never run twice"
    );
    let mut more = list.clone();
    more.push(m(
        "bad",
        4,
        "INSERT INTO t VALUES (3); INSERT INTO t VALUES (NULL);",
    ));
    let err = apply_sqlite(&path, &more).unwrap_err();
    assert!(err.contains("bad"));
    let count: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "the failed migration rolled back as a whole");
    let mut store = SqliteRecordStore::new(&path);
    let statuses: Vec<String> = history(&mut store)
        .unwrap()
        .into_iter()
        .map(|l| l.status)
        .collect();
    assert_eq!(statuses, vec!["applied", "applied", "failed"]);
    let _ = std::fs::remove_file(path);
}

#[test]
fn checksums_identify_changed_up_sql() {
    let a = m("a", 1, "CREATE TABLE a(x)");
    let b = Migration {
        up: "CREATE TABLE a(y)".into(),
        ..a.clone()
    };
    assert_ne!(a.checksum(), b.checksum());
    assert!(a.targets("sqlite") && !a.targets("postgres"));
    let legacy = Migration {
        target_store: "any".into(),
        ..a.clone()
    };
    assert!(legacy.targets("sqlite") && !legacy.targets("postgres"));
}

#[test]
fn transaction_control_statements_are_rejected() {
    let mut config = DocumentConfig::default();
    config.migrations = vec![
        m("a", 1, "BEGIN; CREATE TABLE a(x); COMMIT;"),
        Migration {
            reversible: true,
            down: Some("SAVEPOINT s; DROP TABLE b; RELEASE s".into()),
            ..m("b", 2, "CREATE TABLE b(note TEXT DEFAULT 'commit;')")
        },
        m(
            "c",
            3,
            "CREATE TRIGGER t AFTER INSERT ON b BEGIN UPDATE b SET note = 'x'; END;",
        ),
    ];
    let errors: Vec<String> = validate(&config)
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| format!("{} {}", i.object_id, i.message))
        .collect();
    assert!(
        errors
            .iter()
            .any(|e| e.starts_with("a ") && e.contains("BEGIN is not allowed")),
        "{errors:?}"
    );
    assert!(
        errors
            .iter()
            .any(|e| e.starts_with("b ") && e.contains("(down): SAVEPOINT")),
        "{errors:?}"
    );
    assert!(
        !errors
            .iter()
            .any(|e| e.starts_with("b ") && e.contains("(up)")),
        "{errors:?}"
    );
    assert!(!errors.iter().any(|e| e.starts_with("c ")), "{errors:?}");

    // Execution refuses it too, before anything runs.
    let path = std::env::temp_dir().join(format!("ixtable-migrations-{}.db", uuid::Uuid::new_v4()));
    rusqlite::Connection::open(&path).unwrap();
    let err = apply_sqlite(
        &path,
        &[m("x", 1, "CREATE TABLE z(x); COMMIT; CREATE TABLE y(x)")],
    )
    .unwrap_err();
    assert!(err.contains("COMMIT is not allowed"), "{err}");
    let tables: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('z','y')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
    let mut store = SqliteRecordStore::new(&path);
    assert_eq!(
        store.run_script("END", &[], true).unwrap_err().code,
        "VALIDATION_ERROR"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn recovery_text_points_to_the_checkpoint() {
    let mig = m("a", 1, "CREATE TABLE a(x)");
    let text = recovery(&mig, "boom", Some("cp1"));
    assert!(
        text.contains("restore the pre-migration checkpoint cp1"),
        "{text}"
    );
    assert!(!text.contains("PostgreSQL"), "{text}");
    assert!(!recovery(&mig, "boom", None).contains("checkpoint"));
}

#[test]
fn postgres_documents_cannot_run_migrations() {
    let mut config = DocumentConfig::default();
    assert!(commands::ensure_sqlite(&config).is_ok());
    config.datasource.kind = "postgres".into();
    let err = commands::ensure_sqlite(&config).unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
    assert_eq!(err.message, POSTGRES_DOCUMENT);
}
