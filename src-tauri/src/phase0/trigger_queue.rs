//! Durable local async trigger queue. Jobs run only while the desktop process
//! is alive. Crashes return leased work to `pending` after the lease expires.
use rusqlite::{params, Connection};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: String,
    pub idempotency_key: String,
    pub trigger_name: String,
    pub payload: String,
    pub status: String,
    pub attempts: i64,
}

pub fn open(path: &Path) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS trigger_jobs (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            trigger_name TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            max_attempts INTEGER NOT NULL,
            lease_until INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );",
    )?;
    Ok(conn)
}

pub fn enqueue(
    conn: &Connection,
    id: &str,
    idempotency_key: &str,
    trigger_name: &str,
    payload: &str,
    now: i64,
) -> Result<bool, rusqlite::Error> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO trigger_jobs
         (id, idempotency_key, trigger_name, payload, status, attempts, max_attempts, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, 5, ?5, ?5)",
        params![id, idempotency_key, trigger_name, payload, now],
    )?;
    Ok(changed == 1)
}

pub fn claim(conn: &Connection, now: i64, lease_secs: i64) -> Result<Option<Job>, rusqlite::Error> {
    conn.execute(
        "UPDATE trigger_jobs SET status='pending', lease_until=NULL
         WHERE status='running' AND lease_until IS NOT NULL AND lease_until < ?1",
        [now],
    )?;
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM trigger_jobs
             WHERE status='pending'
             ORDER BY created_at, id
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(id) = id else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE trigger_jobs SET status='running', attempts=attempts+1, lease_until=?1, updated_at=?2 WHERE id=?3",
        params![now + lease_secs, now, id],
    )?;
    load(conn, &id).map(Some)
}

pub fn complete(conn: &Connection, id: &str, now: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE trigger_jobs SET status='succeeded', lease_until=NULL, updated_at=?1 WHERE id=?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn fail(conn: &Connection, id: &str, now: i64, error: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE trigger_jobs SET
            status=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            last_error=?1, lease_until=NULL, updated_at=?2
         WHERE id=?3",
        params![error, now, id],
    )?;
    Ok(())
}

pub fn cancel(conn: &Connection, id: &str, now: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE trigger_jobs SET status='cancelled', lease_until=NULL, updated_at=?1 WHERE id=?2 AND status IN ('pending','running')",
        params![now, id],
    )?;
    Ok(())
}

fn load(conn: &Connection, id: &str) -> Result<Job, rusqlite::Error> {
    conn.query_row(
        "SELECT id, idempotency_key, trigger_name, payload, status, attempts FROM trigger_jobs WHERE id=?1",
        [id],
        |row| {
            Ok(Job {
                id: row.get(0)?,
                idempotency_key: row.get(1)?,
                trigger_name: row.get(2)?,
                payload: row.get(3)?,
                status: row.get(4)?,
                attempts: row.get(5)?,
            })
        },
    )
}

trait OptionalExt<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}
impl<T> OptionalExt<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn db() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("ixtable-queue-{}.db", Uuid::new_v4()));
        (open(&path).unwrap(), path)
    }

    #[test]
    fn idempotent_enqueue_claim_complete_and_lease_recovery() {
        let (conn, path) = db();
        assert!(enqueue(&conn, "j1", "idemp-1", "record-updated", "{}", 10).unwrap());
        assert!(!enqueue(&conn, "j2", "idemp-1", "record-updated", "{}", 11).unwrap());
        let job = claim(&conn, 20, 30).unwrap().unwrap();
        assert_eq!(job.id, "j1");
        assert_eq!(job.status, "running");
        assert_eq!(job.attempts, 1);
        assert!(claim(&conn, 21, 30).unwrap().is_none());
        let recovered = claim(&conn, 60, 30).unwrap().unwrap();
        assert_eq!(recovered.id, "j1");
        assert_eq!(recovered.attempts, 2);
        complete(&conn, "j1", 61).unwrap();
        let done = load(&conn, "j1").unwrap();
        assert_eq!(done.status, "succeeded");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn retries_then_fails_and_cancel_stops_pending_work() {
        let (conn, path) = db();
        enqueue(&conn, "j1", "k", "record-created", "{}", 1).unwrap();
        for tick in [2, 40, 80, 120, 160] {
            let job = claim(&conn, tick, 10).unwrap().unwrap();
            fail(&conn, &job.id, tick + 1, "boom").unwrap();
        }
        let failed = load(&conn, "j1").unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.attempts, 5);
        enqueue(&conn, "j3", "k3", "record-created", "{}", 200).unwrap();
        cancel(&conn, "j3", 201).unwrap();
        assert!(claim(&conn, 202, 10).unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }
}
