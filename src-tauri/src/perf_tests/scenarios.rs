//! The Rust-side budgets: open, autosave, write-then-read refresh, and query
//! cancellation. Each test records one entry of `rust.json`.
use super::{enabled, fixture, fixture_manager, record, sample, time, Measurement};
use crate::data::{ReadTarget, Sort};
use std::time::{Duration, Instant};

const W: &str = "perf";

fn first_page(m: &crate::manager::DocumentManager) {
    let sort = [Sort {
        column: "id".into(),
        descending: false,
    }];
    m.table_page(W, "deals", 0, 50, &sort, &[]).unwrap();
}

#[test]
fn application_open_after_warm_start() {
    if !enabled() {
        return;
    }
    let (base, m, path) = fixture_manager("perf-open");
    let samples = sample(|| {
        let elapsed = time(|| {
            m.open(W, &path).unwrap();
            m.database_objects(W).unwrap();
            first_page(&m);
        });
        m.close(W, true).unwrap();
        elapsed
    });
    record(Measurement {
        id: "open-warm",
        target: "Application open after warm start",
        budget_ms: Some(3000.0),
        samples,
        note: "open the .ixt (extract + verify), list objects, read the first 50 deals".into(),
    });
    let _ = std::fs::remove_dir_all(base);
}

fn autosave_after(
    id: &'static str,
    target: &'static str,
    note: &str,
    edit: impl Fn(&crate::manager::DocumentManager, usize),
) {
    let (base, m, path) = fixture_manager(id);
    m.open(W, &path).unwrap();
    let mut i = 0;
    let samples = sample(|| {
        i += 1;
        edit(&m, i);
        let t0 = Instant::now();
        let state = m.autosave(W).unwrap();
        let elapsed = t0.elapsed();
        assert!(
            !state.dirty && state.last_error.is_none(),
            "{id}: autosave did not save"
        );
        elapsed
    });
    record(Measurement {
        id,
        target,
        budget_ms: Some(2000.0),
        samples,
        note: note.into(),
    });
    m.close(W, true).unwrap();
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn autosave_after_a_definition_edit() {
    if !enabled() {
        return;
    }
    autosave_after(
        "autosave-definition",
        "Autosave completion (definition edit)",
        "rename the document, then autosave the whole fixture",
        |m, i| {
            let mut config = m.config(W).unwrap();
            config.name = format!("CRM perf {i}");
            m.update_config(W, config).unwrap();
        },
    );
}

/// One committed record update outside the RecordStore, then the read refresh.
fn update_deal(m: &crate::manager::DocumentManager, i: usize) {
    let db = m.database_path(W).unwrap();
    rusqlite::Connection::open(db)
        .unwrap()
        .execute(
            "UPDATE deals SET title = ?1 WHERE id = ?2",
            rusqlite::params![format!("Edited deal {i}"), i as i64],
        )
        .unwrap();
    m.mark_data_dirty(W).unwrap();
}

#[test]
fn autosave_after_a_record_edit() {
    if !enabled() {
        return;
    }
    autosave_after(
        "autosave-record",
        "Autosave completion (record edit)",
        "update one deal, then autosave the whole fixture",
        update_deal,
    );
}

#[test]
fn sqlite_write_then_read() {
    if !enabled() {
        return;
    }
    let (base, m, path) = fixture_manager("perf-sqlite-write");
    m.open(W, &path).unwrap();
    let mut i = 0;
    let samples = sample(|| {
        i += 1;
        time(|| {
            update_deal(&m, i);
            first_page(&m);
        })
    });
    record(Measurement {
        id: "write-read-sqlite",
        target: "Record write, read refresh, and next read (SQLite)",
        budget_ms: None,
        samples,
        note: "backend part of a field edit; the UI acknowledgement is measured in tests/perf"
            .into(),
    });
    m.close(W, true).unwrap();
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn postgres_write_then_read() {
    if !enabled() {
        return;
    }
    let Some(mut h) = crate::recordstore::conformance::postgres_harness() else {
        return;
    };
    assert!(matches!(h.reader.target(), ReadTarget::Postgres { .. }));
    crate::recordstore::conformance::people(&mut h);
    use crate::recordstore::conformance::{nv, text};
    for n in 0..200 {
        h.store
            .insert("people", &[nv("name", text(&format!("Person {n}")))])
            .unwrap();
    }
    h.reader.refresh().unwrap();
    let sort = [Sort {
        column: "id".into(),
        descending: false,
    }];
    let mut i = 0;
    let samples = sample(|| {
        i += 1;
        time(|| {
            h.store
                .insert("people", &[nv("name", text(&format!("Added {i}")))])
                .unwrap();
            h.reader.refresh().unwrap();
            let page = h.reader.page("people", 0, 50, &sort, &[]).unwrap();
            assert_eq!(page.total, 200 + i as u64);
        })
    });
    record(Measurement {
        id: "write-read-postgres",
        target: "Record write, read refresh, and next read (PostgreSQL)",
        budget_ms: None,
        samples,
        note: "insert through the PostgreSQL RecordStore, refresh the DuckDB reader, read a page"
            .into(),
    });
}

#[test]
fn report_query_cancellation() {
    if !enabled() {
        return;
    }
    let (base, m, path) = fixture_manager("perf-cancel");
    m.open(W, &path).unwrap();
    let m = std::sync::Arc::new(m);
    let mut n = 0;
    let samples = sample(|| {
        n += 1;
        let run_id = format!("perf-cancel-{n}");
        let worker = {
            let (m, run_id) = (m.clone(), run_id.clone());
            std::thread::spawn(move || {
                let conn = m.read_connection(W).unwrap();
                // A report-sized aggregate that runs far longer than the 2 s progress threshold.
                crate::queries::run_on(
                    &conn,
                    W,
                    Some(run_id),
                    "SELECT a.status, sum(a.amount * b.amount) FROM deals a, deals b GROUP BY a.status",
                    &[],
                    &[],
                    false,
                    None,
                )
            })
        };
        std::thread::sleep(Duration::from_millis(2000));
        let t0 = Instant::now();
        assert!(
            crate::queries::cancel(W, Some(&run_id)) >= 1,
            "query finished before cancel"
        );
        let result = worker.join().unwrap();
        let elapsed = t0.elapsed();
        assert_eq!(result.unwrap_err().code, "CANCELLED");
        elapsed
    });
    record(Measurement {
        id: "query-cancel",
        target: "Report/dashboard query cancellation (cancel to stop)",
        budget_ms: None,
        samples,
        note: "a 50,000 x 50,000 join is cancelled 2 s in, when the UI shows progress and Cancel"
            .into(),
    });
    m.close(W, true).unwrap();
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn fixture_matches_its_description() {
    if !enabled() {
        return;
    }
    let (base, m, path) = fixture_manager("perf-check");
    m.open(W, &path).unwrap();
    let deals = crate::durability_tests::count_rows(&m, W, "deals");
    assert!(deals >= fixture::DEALS, "{deals} deals");
    let kept = crate::durability_tests::count_rows(&m, W, "deals WHERE amount >= 99000");
    assert!((450..=550).contains(&kept), "{kept} deals pass the filter");
    m.close(W, true).unwrap();
    let _ = std::fs::remove_dir_all(base);
}
