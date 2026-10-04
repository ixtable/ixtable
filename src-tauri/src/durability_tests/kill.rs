//! Forced termination during autosave (PRD §27.1, Phase 1 exit). The parent test
//! re-runs this test binary as a writer that saves and autosaves a growing
//! document in a loop, kills it (`Child::kill`: SIGKILL / TerminateProcess) at
//! varied points, and checks that the archive is always the last good save and
//! that the leftover workspace is recovered or cleanly refused.
use crate::archive_io;
use crate::manager::DocumentManager;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const WRITER_DIR: &str = "IXTABLE_KILL_WRITER_DIR";
const WRITER_TEST: &str = "durability_tests::kill::autosave_writer_child";
/// Milliseconds the writer runs after its first save before it is killed.
const KILL_AFTER_MS: &[u64] = &[0, 15, 40, 90, 160, 260, 400, 650];

fn noise(len: usize, mut seed: u64) -> Vec<u8> {
    (0..len)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        })
        .collect()
}

fn manager(dir: &Path) -> DocumentManager {
    DocumentManager::new(dir.join("data"), dir.join("cache")).unwrap()
}

/// The writer process: never returns on its own while `IXTABLE_KILL_WRITER_DIR` is set.
#[test]
#[ignore = "child process of forced_termination_during_autosave_keeps_the_last_good_archive"]
fn autosave_writer_child() {
    let Ok(dir) = std::env::var(WRITER_DIR).map(PathBuf::from) else {
        return;
    };
    let m = manager(&dir);
    let w = "writer";
    m.new_session(w).unwrap();
    let db = m.database_path(w).unwrap();
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE payload(id INTEGER PRIMARY KEY, body BLOB NOT NULL)")
        .unwrap();
    m.mark_data_dirty(w).unwrap();
    m.save(w, Some(dir.join("doc.ixt"))).unwrap();
    fs::write(dir.join("ready"), b"1").unwrap();
    for i in 0u64..100_000 {
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute("INSERT INTO payload(body) VALUES (randomblob(131072))", [])
            .unwrap();
        m.mark_data_dirty(w).unwrap();
        if i % 4 == 1 {
            let asset = dir.join(format!("asset-{i}.bin"));
            fs::write(&asset, noise(65_536, i + 1)).unwrap();
            m.import_asset(w, &asset, Some("application/octet-stream"))
                .unwrap();
        }
        if i % 2 == 0 {
            m.autosave(w).unwrap();
        } else {
            m.save(w, None).unwrap();
        }
    }
}

/// Spawns the writer, kills it `after` ms past its first save, and returns once it exited.
fn run_and_kill(dir: &Path, after: u64) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([WRITER_TEST, "--exact", "--ignored", "--test-threads=1"])
        .env(WRITER_DIR, dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while !dir.join("ready").exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("the writer exited before its first save: {status}");
        }
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "the writer did not start"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(after));
    let exited_early = child.try_wait().unwrap();
    assert!(
        exited_early.is_none(),
        "the writer stopped on its own: {exited_early:?}"
    );
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn forced_termination_during_autosave_keeps_the_last_good_archive() {
    let mut recovered = 0;
    for (n, after) in KILL_AFTER_MS.iter().enumerate() {
        let dir = std::env::temp_dir().join(format!("ixtable-kill-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        run_and_kill(&dir, *after);
        let path = dir.join("doc.ixt");
        let what = format!("run {n} (killed {after} ms after the first save)");
        // The file at the path is always a complete archive whose checksums verify.
        let saved = archive_io::verify(&path).unwrap_or_else(|e| panic!("{what}: {e}"));
        let header = archive_io::read_header(&path).unwrap();
        assert_eq!(header.format_version, archive_io::FORMAT_VERSION, "{what}");
        let m = manager(&dir);
        m.open("check", &path)
            .unwrap_or_else(|e| panic!("{what}: open: {e}"));
        let rows = super::count_rows(&m, "check", "payload");
        m.close("check", true).unwrap();
        // The killed session's workspace is recovered into the archive, or refused with a reason.
        for record in m.recoverable_sessions().unwrap() {
            assert_eq!(record.document_id, saved.metadata.document_id, "{what}");
            match m.recover_session("recovered", &record.session_id) {
                Ok(state) => {
                    recovered += 1;
                    assert!(!state.conflict, "{what}: {:?}", state.last_error);
                    archive_io::verify(&path).unwrap_or_else(|e| panic!("{what}: {e}"));
                    m.open("check", &path).unwrap();
                    assert!(super::count_rows(&m, "check", "payload") >= rows, "{what}");
                    m.close("check", true).unwrap();
                }
                Err(e) => assert_eq!(e.code, "RECOVERY_FAILED", "{what}: {e}"),
            }
            let _ = m.close("recovered", true);
        }
        drop(m);
        let _ = fs::remove_dir_all(&dir);
    }
    assert!(recovered > 0, "no run left recoverable work to check");
}
