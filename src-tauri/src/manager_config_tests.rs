// Session config tests (included from manager.rs).
use super::*;
use crate::data::ReadTarget;

fn manager() -> (DocumentManager, PathBuf) {
    let base = std::env::temp_dir().join(format!("ixtable-cfg-{}", Uuid::new_v4()));
    (
        DocumentManager::new(base.join("data"), base.join("cache")).unwrap(),
        base,
    )
}

fn unreachable_postgres(config: &mut DocumentConfig) {
    config.datasource.kind = "postgres".into();
    config.datasource.host = "127.0.0.1".into();
    config.datasource.port = 1;
    config.datasource.database = "nope".into();
    config.datasource.user = "nope".into();
    config.datasource.sslmode = "require".into();
}

/// Leaves a marker table in the reader's in-memory catalog; it survives only as
/// long as the same DuckDB database does.
fn mark_reader(m: &DocumentManager, window: &str) {
    m.with_session(window, |s| {
        s.reader
            .connection()
            .execute_batch("CREATE TABLE memory.main.marker(x INTEGER)")
            .map_err(|e| AppError::new("TEST", e))
    })
    .unwrap();
}
fn reader_marked(m: &DocumentManager, window: &str) -> bool {
    m.with_session(window, |s| {
        Ok(s.reader
            .connection()
            .query_row("SELECT count(*) FROM memory.main.marker", [], |r| {
                r.get::<_, i64>(0)
            })
            .is_ok())
    })
    .unwrap()
}

#[test]
fn config_edits_reattach_only_when_the_datasource_changes() {
    let (m, base) = manager();
    m.new_session("w").unwrap();
    mark_reader(&m, "w");
    let mut config = m.config("w").unwrap();
    config.name = "Renamed".into();
    m.update_config("w", config.clone()).unwrap();
    assert!(reader_marked(&m, "w"), "a plain edit keeps the reader");

    unreachable_postgres(&mut config);
    m.update_config("w", config.clone()).unwrap();
    assert!(
        !reader_marked(&m, "w"),
        "a datasource change swaps the reader"
    );
    m.with_session("w", |s| {
        assert!(matches!(s.reader.target(), ReadTarget::Postgres { .. }));
        assert!(s.reader.attach_error().is_some());
        Ok(())
    })
    .unwrap();
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn config_revision_counts_backend_config_mutations() {
    let (m, base) = manager();
    let start = m.new_session("w").unwrap().config_revision;
    let mut config = m.config("w").unwrap();
    config.name = "One".into();
    assert_eq!(
        m.update_config("w", config).unwrap().config_revision,
        start + 1
    );
    let yaml = m.config_yaml("w").unwrap();
    assert_eq!(
        m.apply_config_yaml("w", &yaml).unwrap().config_revision,
        start + 2
    );
    rusqlite::Connection::open(m.database_path("w").unwrap())
        .unwrap()
        .execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)")
        .unwrap();
    m.mark_data_dirty("w").unwrap();
    // Record writes are not config mutations.
    assert_eq!(m.state("w").unwrap().config_revision, start + 2);
    // A parameterized query is prepared, not run, so it saves without values.
    let saved = m
        .save_query(
            "w",
            None,
            "Recent".into(),
            "SELECT * FROM t WHERE id > $min AND $label IS NOT NULL".into(),
            None,
        )
        .unwrap();
    assert_eq!(saved.saved_queries.len(), 1);
    assert_eq!(m.state("w").unwrap().config_revision, start + 3);
    assert_eq!(
        m.save_query("w", None, "Bad".into(), "DELETE FROM t".into(), None)
            .unwrap_err()
            .code,
        "READ_ONLY"
    );
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn runtime_sessions_read_the_configured_datasource() {
    let (m, base) = manager();
    let installation = base.join("installation");
    fs::create_dir_all(&installation).unwrap();
    rusqlite::Connection::open(installation.join("data.db")).unwrap();
    let mut doc = archive::create_document("Runtime").unwrap();
    unreachable_postgres(&mut doc.config);
    let state = m
        .open_runtime_session(
            "rt",
            &installation,
            doc,
            crate::installation::RuntimeSession {
                bundle_id: "b".into(),
                version: "1.0.0".into(),
                dir: installation.clone(),
            },
        )
        .unwrap();
    m.with_session("rt", |s| {
        assert!(matches!(s.reader.target(), ReadTarget::Postgres { .. }));
        Ok(())
    })
    .unwrap();
    crate::installation::forget_runtime(&state.session_id);
    let _ = std::fs::remove_dir_all(base);
}
