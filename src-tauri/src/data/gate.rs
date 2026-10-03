//! In-process read/write gate for an embedded SQLite file (PRD §10.1).
//!
//! rusqlite (the RecordStore write path) and DuckDB's sqlite_scanner (the read
//! path) each link their own copy of SQLite. SQLite coordinates connections with
//! POSIX advisory locks, and those belong to the process, not to the file
//! descriptor: one copy never sees the locks the other copy holds, and closing any
//! descriptor of the file drops every lock the process holds on it. So when a
//! DuckDB read starts while a rusqlite write transaction is open, the scanner finds
//! the writer's rollback journal, sees no RESERVED lock, decides the journal is hot,
//! and (being attached READ_ONLY) fails with SQLITE_READONLY_ROLLBACK, "attempt to
//! write a readonly database". (Where the host exports its SQLite symbols, as a
//! `cargo test` binary does, the extension binds to rusqlite's copy instead; the
//! writer and the scanner's several handles then deadlock on PENDING/SHARED locks
//! until both fail with "database is locked".) SQLite cannot arbitrate here, so
//! this gate does: RecordStore connections and the reader's re-attach after a
//! write (which detaches the catalog that cloned query connections use) are
//! exclusive; DuckDB reads are shared. Waiting writers block new readers, so a
//! stream of reads cannot starve a write.
//!
//! Gates are per file and re-entrant per thread: a thread that already holds the
//! gate of a file passes straight through, so nested reads never wait on a writer
//! queued behind them. Guards are not `Send`.
use std::{
    cell::RefCell,
    collections::HashMap,
    marker::PhantomData,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};

/// How long an operation waits for the file before failing with a busy error.
pub const WAIT: Duration = Duration::from_secs(30);

/// Message of a gate wait that timed out (the RecordStore maps it to `BUSY`).
pub const BUSY_MESSAGE: &str = "The data file is busy with another operation; try again";

#[derive(Default)]
struct State {
    readers: usize,
    writer: bool,
    waiting_writers: usize,
}

#[derive(Default)]
struct Gate {
    state: Mutex<State>,
    changed: Condvar,
}

fn gates() -> &'static Mutex<HashMap<PathBuf, Weak<Gate>>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Weak<Gate>>>> = OnceLock::new();
    GATES.get_or_init(Default::default)
}

thread_local! {
    static HELD: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
}

fn gate_for(db: &Path) -> Arc<Gate> {
    let mut all = gates().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(gate) = all.get(db).and_then(Weak::upgrade) {
        return gate;
    }
    all.retain(|_, g| g.strong_count() > 0);
    let gate = Arc::new(Gate::default());
    all.insert(db.to_owned(), Arc::downgrade(&gate));
    gate
}

/// Held access to a file; released on drop.
pub struct GateGuard {
    held: Option<(Arc<Gate>, bool, PathBuf)>,
    _not_send: PhantomData<*const ()>,
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        let Some((gate, exclusive, path)) = self.held.take() else {
            return;
        };
        {
            let mut s = gate.state.lock().unwrap_or_else(|e| e.into_inner());
            if exclusive {
                s.writer = false;
            } else {
                s.readers -= 1;
            }
        }
        gate.changed.notify_all();
        HELD.with(|h| {
            let mut h = h.borrow_mut();
            if let Some(i) = h.iter().rposition(|p| *p == path) {
                h.remove(i);
            }
        });
    }
}

/// A connection that keeps the gate it was opened under until it is dropped
/// (the connection closes first: fields drop in declaration order).
pub struct Gated<T> {
    inner: T,
    _gate: Option<GateGuard>,
}
impl<T> Gated<T> {
    pub fn new(inner: T, gate: Option<GateGuard>) -> Self {
        Self { inner, _gate: gate }
    }
}
impl<T> std::ops::Deref for Gated<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.inner
    }
}
impl<T> std::ops::DerefMut for Gated<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}

/// Shared access for a DuckDB read of `db`.
pub fn shared(db: &Path) -> Result<GateGuard, String> {
    acquire(db, false, WAIT)
}

/// Exclusive access for a RecordStore connection to `db` (or a reader re-attach).
pub fn exclusive(db: &Path) -> Result<GateGuard, String> {
    acquire(db, true, WAIT)
}

fn acquire(db: &Path, exclusive: bool, wait: Duration) -> Result<GateGuard, String> {
    let pass = GateGuard {
        held: None,
        _not_send: PhantomData,
    };
    if HELD.with(|h| h.borrow().iter().any(|p| p == db)) {
        return Ok(pass);
    }
    let gate = gate_for(db);
    let deadline = Instant::now() + wait;
    let mut s = gate.state.lock().unwrap_or_else(|e| e.into_inner());
    if exclusive {
        s.waiting_writers += 1;
    }
    loop {
        let free = match exclusive {
            true => !s.writer && s.readers == 0,
            false => !s.writer && s.waiting_writers == 0,
        };
        if free {
            break;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            if exclusive {
                s.waiting_writers -= 1;
                drop(s);
                gate.changed.notify_all();
            }
            return Err(BUSY_MESSAGE.into());
        }
        s = gate
            .changed
            .wait_timeout(s, left)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    if exclusive {
        s.waiting_writers -= 1;
        s.writer = true;
    } else {
        s.readers += 1;
    }
    drop(s);
    HELD.with(|h| h.borrow_mut().push(db.to_owned()));
    Ok(GateGuard {
        held: Some((gate.clone(), exclusive, db.to_owned())),
        ..pass
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_db() -> PathBuf {
        std::env::temp_dir().join(format!("ixtable-gate-{}.db", uuid::Uuid::new_v4()))
    }

    #[test]
    fn writers_exclude_readers_and_each_other() {
        let db = temp_db();
        let inside = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let (db, inside) = (db.clone(), inside.clone());
                std::thread::spawn(move || {
                    for _ in 0..200 {
                        let exclusive = i % 2 == 0;
                        let _g = acquire(&db, exclusive, WAIT).unwrap();
                        let n =
                            inside.fetch_add(if exclusive { 1000 } else { 1 }, Ordering::SeqCst);
                        assert!(
                            if exclusive { n == 0 } else { n < 1000 },
                            "a writer overlapped another holder ({n})"
                        );
                        std::thread::yield_now();
                        inside.fetch_sub(if exclusive { 1000 } else { 1 }, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
    }

    #[test]
    fn a_thread_reenters_its_own_gate_and_waits_time_out_as_busy() {
        let db = temp_db();
        let outer = shared(&db).unwrap();
        // A writer queues behind the reader...
        let queued = {
            let db = db.clone();
            std::thread::spawn(move || acquire(&db, true, Duration::from_millis(300)).is_ok())
        };
        std::thread::sleep(Duration::from_millis(50));
        // ...yet the reader's nested read does not wait on it.
        drop(shared(&db).unwrap());
        assert!(
            !queued.join().unwrap(),
            "the writer timed out while the read was held"
        );
        drop(outer);
        let other = temp_db();
        let _w = exclusive(&db).unwrap();
        assert!(
            exclusive(&other).is_ok(),
            "gates of different files are independent"
        );
        let blocked =
            std::thread::spawn(move || acquire(&db, false, Duration::from_millis(50)).err());
        assert_eq!(blocked.join().unwrap().as_deref(), Some(BUSY_MESSAGE));
    }
}
