//! Concurrent RecordStore writes and DuckDB reads of one `data.db` (PRD §10.1).
//! Each side links its own SQLite, so only `data::gate` keeps them apart.
use super::{DataValue, NamedValue, ReadRuntime, Sort};
use crate::recordstore::{sqlite::SqliteRecordStore, RecordStore};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

#[test]
fn concurrent_writes_and_reads_never_fail_and_reads_see_committed_writes() {
    let workspace = std::env::temp_dir().join(format!("ixtable-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&workspace).unwrap();
    let db = workspace.join("data.db");
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL);")
        .unwrap();
    const WRITES: u64 = 300;
    let done = Arc::new(AtomicBool::new(false));
    let committed = Arc::new(AtomicU64::new(0));
    let writers: Vec<_> = (0..2)
        .map(|w| {
            let (db, committed) = (db.clone(), committed.clone());
            std::thread::spawn(move || {
                let mut store = SqliteRecordStore::new(&db);
                for i in 0..WRITES / 2 {
                    let value = NamedValue {
                        column: "v".into(),
                        value: DataValue::Text(format!("{w}-{i}-{}", "x".repeat(2000))),
                    };
                    store
                        .insert("t", &[value])
                        .unwrap_or_else(|e| panic!("write {w}/{i}: {e:?}"));
                    committed.fetch_add(1, Ordering::SeqCst);
                }
            })
        })
        .collect();
    let readers: Vec<_> = (0..2)
        .map(|_| {
            let (workspace, done, committed) = (workspace.clone(), done.clone(), committed.clone());
            std::thread::spawn(move || {
                let mut reader = ReadRuntime::for_test(&workspace).unwrap();
                let sort = [Sort {
                    column: "id".into(),
                    descending: true,
                }];
                let mut reads = 0;
                while !done.load(Ordering::SeqCst) || reads < 5 {
                    // Read-your-writes: a refresh after N commits sees at least N rows.
                    let floor = committed.load(Ordering::SeqCst);
                    reader.refresh().unwrap_or_else(|e| panic!("refresh: {e}"));
                    let count = match reader
                        .query("SELECT count(*) FROM t")
                        .unwrap_or_else(|e| panic!("query: {e}"))
                        .rows[0][0]
                    {
                        DataValue::Integer(n) => n as u64,
                        ref other => panic!("count {other:?}"),
                    };
                    assert!(count >= floor, "read {count} rows after {floor} commits");
                    reader
                        .page("t", 0, 20, &sort, &[])
                        .unwrap_or_else(|e| panic!("page: {e}"));
                    reads += 1;
                }
                reads
            })
        })
        .collect();
    for w in writers {
        w.join().unwrap();
    }
    done.store(true, Ordering::SeqCst);
    for r in readers {
        assert!(r.join().unwrap() >= 5);
    }
    let reader = ReadRuntime::for_test(&workspace).unwrap();
    assert_eq!(reader.row_count("t").unwrap(), WRITES);
    std::fs::remove_dir_all(workspace).unwrap();
}

/// The same race through one session: RecordStore writes plus `mark_data_dirty`
/// (the command write path) against every session read path.
#[test]
fn a_session_serves_concurrent_writes_and_reads_with_read_your_writes() {
    use crate::manager::DocumentManager;
    let base = std::env::temp_dir().join(format!("ixtable-race-mgr-{}", uuid::Uuid::new_v4()));
    let m = DocumentManager::new(base.join("data"), base.join("cache")).unwrap();
    m.new_session("w").unwrap();
    let db = m.database_path("w").unwrap();
    SqliteRecordStore::new(&db)
        .execute_internal(
            "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
            &[],
        )
        .unwrap();
    m.mark_data_dirty("w").unwrap();
    const WRITES: i64 = 60;
    let done = AtomicBool::new(false);
    let count = |rows: &[Vec<DataValue>]| match rows[0][0] {
        DataValue::Integer(n) => n,
        ref other => panic!("count {other:?}"),
    };
    std::thread::scope(|scope| {
        let writers: Vec<_> = (0..2)
            .map(|w| {
                let (m, db) = (&m, &db);
                scope.spawn(move || {
                    for i in 0..WRITES / 2 {
                        let value = NamedValue {
                            column: "v".into(),
                            value: DataValue::Text(format!("{w}-{i}-{}", "y".repeat(1500))),
                        };
                        SqliteRecordStore::new(db)
                            .insert("t", &[value])
                            .unwrap_or_else(|e| panic!("write {w}/{i}: {e:?}"));
                        let state = m.mark_data_dirty("w").unwrap();
                        assert!(state.last_error.is_none(), "{:?}", state.last_error);
                        // Read-your-writes: this writer's row is visible right after its refresh.
                        let seen = m
                            .read_query(
                                "w",
                                &format!("SELECT count(*) FROM t WHERE v LIKE '{w}-{i}-%'"),
                            )
                            .unwrap();
                        assert_eq!(count(&seen.rows), 1, "write {w}/{i} not visible");
                    }
                })
            })
            .collect();
        for _ in 0..2 {
            let (m, done) = (&m, &done);
            scope.spawn(move || {
                let sort = [Sort {
                    column: "id".into(),
                    descending: false,
                }];
                while !done.load(Ordering::SeqCst) {
                    m.table_page("w", "t", 0, 10, &sort, &[]).unwrap();
                    m.database_objects("w").unwrap();
                    let c = m.read_connection("w").unwrap();
                    c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0))
                        .unwrap();
                }
            });
        }
        for w in writers {
            w.join().unwrap();
        }
        done.store(true, Ordering::SeqCst);
    });
    assert_eq!(
        count(&m.read_query("w", "SELECT count(*) FROM t").unwrap().rows),
        WRITES
    );
    m.close("w", true).unwrap();
    let _ = std::fs::remove_dir_all(base);
}
