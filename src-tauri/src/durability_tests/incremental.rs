//! Incremental saves through the manager: a save copies the data payload and assets
//! from the session's archive when they did not change, and packs them again when a
//! commit (through any connection) or an external edit makes the copy unsafe.
use super::{count_rows, fresh_manager};
use crate::manager::DocumentManager;
use std::fs;
use std::path::PathBuf;

const W: &str = "incremental";

/// A saved document with one table, three rows, and one asset; the session stays open.
fn saved(tag: &str) -> (PathBuf, DocumentManager, PathBuf) {
    let (base, m) = fresh_manager(tag);
    m.new_session(W).unwrap();
    let db = m.database_path(W).unwrap();
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO item(label) VALUES ('a'),('b'),('c');")
        .unwrap();
    m.mark_data_dirty(W).unwrap();
    let asset = base.join("asset.bin");
    fs::write(&asset, vec![7u8; 300_000]).unwrap();
    m.import_asset(W, &asset, Some("application/octet-stream"))
        .unwrap();
    let path = base.join("doc.ixt");
    m.save(W, Some(path.clone())).unwrap();
    (base, m, path)
}

/// Payload owners the next snapshot write of the session would copy.
fn reused_by_next_write(m: &DocumentManager, base: &std::path::Path) -> Vec<String> {
    let snap = m.with_session(W, |s| Ok(m.snapshot(s))).unwrap();
    let dest = base.join(format!("probe-{}.ixt", uuid::Uuid::new_v4()));
    let report = m.write_snapshot(&snap, &dest).unwrap();
    crate::archive_io::verify(&dest).unwrap();
    fs::remove_file(dest).unwrap();
    report.reused
}

fn rename(m: &DocumentManager, name: &str) {
    let mut config = m.config(W).unwrap();
    config.name = name.into();
    m.update_config(W, config).unwrap();
}

#[test]
fn a_definition_edit_reuses_data_and_assets_after_save_and_after_open() {
    let (base, m, path) = saved("incremental-definition");
    rename(&m, "After save");
    assert_eq!(reused_by_next_write(&m, &base).len(), 2);
    m.save(W, None).unwrap();
    m.close(W, true).unwrap();

    m.open(W, &path).unwrap();
    rename(&m, "After open");
    assert_eq!(reused_by_next_write(&m, &base).len(), 2);
    m.save(W, None).unwrap();
    m.close(W, true).unwrap();
    m.open(W, &path).unwrap();
    assert_eq!(m.config(W).unwrap().name, "After open");
    assert_eq!(count_rows(&m, W, "item"), 3);
    m.close(W, true).unwrap();
    let _ = fs::remove_dir_all(base);
}

#[test]
fn any_commit_to_data_db_packs_the_data_again() {
    let (base, m, path) = saved("incremental-commit");
    let db = m.database_path(W).unwrap();
    // A commit nobody announced (no mark_data_dirty) is still detected.
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute("UPDATE item SET label = 'z' WHERE id = 1", [])
        .unwrap();
    let reused = reused_by_next_write(&m, &base);
    assert_eq!(reused.len(), 1);
    assert!(reused[0].starts_with("attachment:"));
    m.mark_data_dirty(W).unwrap();
    m.save(W, None).unwrap();
    m.close(W, true).unwrap();
    m.open(W, &path).unwrap();
    let rows = m
        .read_query(W, "SELECT label FROM item WHERE id = 1")
        .unwrap();
    assert_eq!(rows.rows[0][0], crate::data::DataValue::Text("z".into()));
    m.close(W, true).unwrap();
    let _ = fs::remove_dir_all(base);
}

#[test]
fn an_external_change_reuses_nothing() {
    let (base, m, path) = saved("incremental-external");
    rename(&m, "Edited");
    // Touched by another program: same size, new modification time.
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60))
        .unwrap();
    assert!(reused_by_next_write(&m, &base).is_empty());
    assert_eq!(m.save(W, None).unwrap_err().code, "EXTERNAL_CONFLICT");
    m.close(W, true).unwrap();
    let _ = fs::remove_dir_all(base);
}

#[test]
fn save_as_reuses_from_the_current_file_and_then_from_the_new_one() {
    let (base, m, _) = saved("incremental-save-as");
    let copy = base.join("copy.ixt");
    m.save(W, Some(copy.clone())).unwrap();
    rename(&m, "Copy");
    assert_eq!(reused_by_next_write(&m, &base).len(), 2);
    let state = m.state(W).unwrap();
    assert_eq!(state.path.as_deref(), Some(copy.to_string_lossy().as_ref()));
    m.close(W, true).unwrap();
    let _ = fs::remove_dir_all(base);
}
