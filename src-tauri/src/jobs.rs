//! Durable local job queue for asynchronous triggers (PRD §17.3).
//!
//! Jobs live in `<state>/data/jobs.db` (next to the global store), keyed by
//! document id, so they survive app restarts. The queue only runs while the app
//! is running: the frontend worker claims jobs, runs the action, and reports the
//! outcome. A claimed job holds a lease; a job whose lease expired (the app
//! crashed or quit mid-run) goes back to `queued` on the next start or claim.
use crate::manager::AppError;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const DEFAULT_LEASE_MS: u64 = 5 * 60 * 1000;
/// Longest retry delay, however many attempts have failed.
const MAX_BACKOFF_MS: u64 = 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub document_id: String,
    pub trigger_id: String,
    pub action_id: String,
    pub payload: Value,
    pub idempotency_key: String,
    pub status: String,
    pub attempts: u32,
    pub max_attempts: u32,
    pub backoff_ms: u64,
    pub next_run_at: String,
    pub lease_until: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobAttempt {
    pub job_id: String,
    pub attempt: u32,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub ok: Option<bool>,
    pub error: Option<String>,
    pub log: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueJob {
    pub trigger_id: String,
    pub action_id: String,
    #[serde(default)]
    pub payload: Value,
    pub idempotency_key: String,
    #[serde(default)]
    pub max_attempts: Option<u32>,
    #[serde(default)]
    pub backoff_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFilter {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

fn ts(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn after(now: DateTime<Utc>, ms: u64) -> String {
    ts(now + Duration::milliseconds(ms.min(i64::MAX as u64) as i64))
}
/// Delay before retry number `attempts` + 1: backoff · 2^(attempts − 1), capped.
pub fn backoff_delay(backoff_ms: u64, attempts: u32) -> u64 {
    let factor = 1u64 << attempts.saturating_sub(1).min(20);
    backoff_ms.saturating_mul(factor).min(MAX_BACKOFF_MS)
}

const COLUMNS: &str = "id,document_id,trigger_id,action_id,payload,idempotency_key,status,attempts,max_attempts,backoff_ms,next_run_at,lease_until,created_at,updated_at,last_error";

fn job(r: &Row) -> rusqlite::Result<Job> {
    let payload: String = r.get(4)?;
    Ok(Job {
        id: r.get(0)?,
        document_id: r.get(1)?,
        trigger_id: r.get(2)?,
        action_id: r.get(3)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        idempotency_key: r.get(5)?,
        status: r.get(6)?,
        attempts: r.get(7)?,
        max_attempts: r.get(8)?,
        backoff_ms: r.get::<_, i64>(9)? as u64,
        next_run_at: r.get(10)?,
        lease_until: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        last_error: r.get(14)?,
    })
}

fn err(e: impl ToString) -> AppError {
    AppError::new("JOB_STORE", e)
}

pub struct JobStore {
    path: PathBuf,
}

impl JobStore {
    /// Opens (creating if needed) the queue database and recovers expired leases.
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let store = Self { path: path.into() };
        store.connection()?.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS jobs(
               id TEXT PRIMARY KEY, document_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
               action_id TEXT NOT NULL, payload TEXT NOT NULL, idempotency_key TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
               attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
               backoff_ms INTEGER NOT NULL, next_run_at TEXT NOT NULL, lease_until TEXT,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT,
               UNIQUE(document_id, idempotency_key));
             CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(document_id, status, next_run_at);
             CREATE TABLE IF NOT EXISTS job_attempts(
               job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, attempt INTEGER NOT NULL,
               started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, error TEXT, log TEXT,
               PRIMARY KEY(job_id, attempt));",
        )
        .map_err(err)?;
        store.recover_expired(Utc::now())?;
        Ok(store)
    }

    fn connection(&self) -> Result<Connection, AppError> {
        let c = Connection::open(&self.path).map_err(err)?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        c.execute_batch("PRAGMA foreign_keys=ON;").map_err(err)?;
        Ok(c)
    }

    fn get(c: &Connection, document_id: &str, id: &str) -> Result<Job, AppError> {
        c.query_row(
            &format!("SELECT {COLUMNS} FROM jobs WHERE id=?1 AND document_id=?2"),
            params![id, document_id],
            job,
        )
        .optional()
        .map_err(err)?
        .ok_or_else(|| AppError::new("NOT_FOUND", format!("Job {id} not found")))
    }

    /// Adds a job, or returns the existing job with the same idempotency key.
    pub fn enqueue(
        &self,
        document_id: &str,
        req: &EnqueueJob,
        now: DateTime<Utc>,
    ) -> Result<Job, AppError> {
        if req.idempotency_key.trim().is_empty() {
            return Err(AppError::new(
                "VALIDATION_ERROR",
                "Idempotency key is empty",
            ));
        }
        let c = self.connection()?;
        let id = uuid::Uuid::new_v4().to_string();
        let at = ts(now);
        c.execute(
            "INSERT INTO jobs(id,document_id,trigger_id,action_id,payload,idempotency_key,status,attempts,max_attempts,backoff_ms,next_run_at,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,'queued',0,?7,?8,?9,?9,?9)
             ON CONFLICT(document_id, idempotency_key) DO NOTHING",
            params![
                id,
                document_id,
                req.trigger_id,
                req.action_id,
                req.payload.to_string(),
                req.idempotency_key,
                req.max_attempts.unwrap_or(3).max(1),
                req.backoff_ms.unwrap_or(1000) as i64,
                at
            ],
        )
        .map_err(err)?;
        c.query_row(
            &format!("SELECT {COLUMNS} FROM jobs WHERE document_id=?1 AND idempotency_key=?2"),
            params![document_id, req.idempotency_key],
            job,
        )
        .map_err(err)
    }

    /// Atomically claims the next due queued job: marks it running, counts the
    /// attempt, and opens an attempt record. Expired leases are recovered first.
    pub fn claim_next(
        &self,
        document_id: &str,
        now: DateTime<Utc>,
        lease_ms: u64,
    ) -> Result<Option<Job>, AppError> {
        self.recover_expired(now)?;
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let next: Option<String> = tx
            .query_row(
                "SELECT id FROM jobs WHERE document_id=?1 AND status='queued' AND next_run_at<=?2
                 ORDER BY next_run_at, created_at LIMIT 1",
                params![document_id, ts(now)],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let Some(id) = next else {
            return Ok(None);
        };
        tx.execute(
            "UPDATE jobs SET status='running', attempts=attempts+1, lease_until=?2, updated_at=?3 WHERE id=?1",
            params![id, after(now, lease_ms), ts(now)],
        )
        .map_err(err)?;
        tx.execute(
            "INSERT OR REPLACE INTO job_attempts(job_id,attempt,started_at) SELECT id,attempts,?2 FROM jobs WHERE id=?1",
            params![id, ts(now)],
        )
        .map_err(err)?;
        let claimed = Self::get(&tx, document_id, &id)?;
        tx.commit().map_err(err)?;
        Ok(Some(claimed))
    }

    fn finish_attempt(
        c: &Connection,
        j: &Job,
        now: DateTime<Utc>,
        ok: bool,
        error: Option<&str>,
        log: &Value,
    ) -> Result<(), AppError> {
        c.execute(
            "UPDATE job_attempts SET finished_at=?3, ok=?4, error=?5, log=?6 WHERE job_id=?1 AND attempt=?2",
            params![j.id, j.attempts, ts(now), ok, error, log.to_string()],
        )
        .map_err(err)?;
        Ok(())
    }

    fn running(c: &Connection, document_id: &str, id: &str) -> Result<Job, AppError> {
        let j = Self::get(c, document_id, id)?;
        if j.status != "running" {
            return Err(AppError::new(
                "INVALID_STATE",
                format!("Job {id} is {}, not running", j.status),
            ));
        }
        Ok(j)
    }

    pub fn complete(
        &self,
        document_id: &str,
        id: &str,
        log: &Value,
        now: DateTime<Utc>,
    ) -> Result<Job, AppError> {
        let c = self.connection()?;
        let j = Self::running(&c, document_id, id)?;
        Self::finish_attempt(&c, &j, now, true, None, log)?;
        c.execute(
            "UPDATE jobs SET status='succeeded', lease_until=NULL, last_error=NULL, updated_at=?2 WHERE id=?1",
            params![id, ts(now)],
        )
        .map_err(err)?;
        Self::get(&c, document_id, id)
    }

    /// Records a failed attempt; schedules a retry with exponential backoff, or
    /// marks the job failed once it has used all its attempts.
    pub fn fail(
        &self,
        document_id: &str,
        id: &str,
        error: &str,
        log: &Value,
        now: DateTime<Utc>,
    ) -> Result<Job, AppError> {
        let c = self.connection()?;
        let j = Self::running(&c, document_id, id)?;
        Self::finish_attempt(&c, &j, now, false, Some(error), log)?;
        if j.attempts >= j.max_attempts {
            c.execute(
                "UPDATE jobs SET status='failed', lease_until=NULL, last_error=?2, updated_at=?3 WHERE id=?1",
                params![id, error, ts(now)],
            )
        } else {
            c.execute(
                "UPDATE jobs SET status='queued', lease_until=NULL, last_error=?2, updated_at=?3, next_run_at=?4 WHERE id=?1",
                params![id, error, ts(now), after(now, backoff_delay(j.backoff_ms, j.attempts))],
            )
        }
        .map_err(err)?;
        Self::get(&c, document_id, id)
    }

    /// Cancels a queued or running job. A running attempt's later result is refused.
    pub fn cancel(&self, document_id: &str, id: &str, now: DateTime<Utc>) -> Result<Job, AppError> {
        let c = self.connection()?;
        let j = Self::get(&c, document_id, id)?;
        if !matches!(j.status.as_str(), "queued" | "running") {
            return Err(AppError::new(
                "INVALID_STATE",
                format!("Job {id} is already {}", j.status),
            ));
        }
        if j.status == "running" {
            Self::finish_attempt(&c, &j, now, false, Some("Cancelled"), &Value::Null)?;
        }
        c.execute(
            "UPDATE jobs SET status='cancelled', lease_until=NULL, updated_at=?2 WHERE id=?1",
            params![id, ts(now)],
        )
        .map_err(err)?;
        Self::get(&c, document_id, id)
    }

    /// Requeues a failed or cancelled job to run now, allowing at least one more attempt.
    pub fn retry(&self, document_id: &str, id: &str, now: DateTime<Utc>) -> Result<Job, AppError> {
        let c = self.connection()?;
        let j = Self::get(&c, document_id, id)?;
        if !matches!(j.status.as_str(), "failed" | "cancelled") {
            return Err(AppError::new(
                "INVALID_STATE",
                format!(
                    "Only failed or cancelled jobs can be retried; job {id} is {}",
                    j.status
                ),
            ));
        }
        c.execute(
            "UPDATE jobs SET status='queued', next_run_at=?2, updated_at=?2, max_attempts=MAX(max_attempts, attempts+1) WHERE id=?1",
            params![id, ts(now)],
        )
        .map_err(err)?;
        Self::get(&c, document_id, id)
    }

    pub fn list(&self, document_id: &str, filter: &JobFilter) -> Result<Vec<Job>, AppError> {
        let c = self.connection()?;
        let mut s = c
            .prepare(&format!(
                "SELECT {COLUMNS} FROM jobs WHERE document_id=?1 AND (?2 IS NULL OR status=?2)
                 ORDER BY created_at DESC, rowid DESC LIMIT ?3"
            ))
            .map_err(err)?;
        let rows = s
            .query_map(
                params![document_id, filter.status, filter.limit.unwrap_or(200)],
                job,
            )
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok(rows)
    }

    pub fn attempts(&self, document_id: &str, id: &str) -> Result<Vec<JobAttempt>, AppError> {
        let c = self.connection()?;
        Self::get(&c, document_id, id)?;
        let mut s = c
            .prepare("SELECT job_id,attempt,started_at,finished_at,ok,error,log FROM job_attempts WHERE job_id=?1 ORDER BY attempt")
            .map_err(err)?;
        let rows = s
            .query_map([id], |r| {
                let log: Option<String> = r.get(6)?;
                Ok(JobAttempt {
                    job_id: r.get(0)?,
                    attempt: r.get(1)?,
                    started_at: r.get(2)?,
                    finished_at: r.get(3)?,
                    ok: r.get(4)?,
                    error: r.get(5)?,
                    log: log
                        .and_then(|l| serde_json::from_str(&l).ok())
                        .unwrap_or(Value::Null),
                })
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok(rows)
    }

    /// Crash recovery: running jobs whose lease expired go back to queued (or to
    /// failed when they have no attempts left). Returns how many were recovered.
    pub fn recover_expired(&self, now: DateTime<Utc>) -> Result<usize, AppError> {
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let at = ts(now);
        let reason = "Lease expired: the app stopped while the job was running";
        tx.execute(
            "UPDATE job_attempts SET finished_at=?1, ok=0, error=?2
             WHERE finished_at IS NULL AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=job_id AND j.attempts=attempt
               AND j.status='running' AND j.lease_until<?1)",
            params![at, reason],
        )
        .map_err(err)?;
        let n = tx
            .execute(
                "UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
                   lease_until=NULL, last_error=?2, next_run_at=?1, updated_at=?1
                 WHERE status='running' AND lease_until<?1",
                params![at, reason],
            )
            .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(n)
    }
}

static STORE: OnceLock<JobStore> = OnceLock::new();

/// The app-wide queue in `<state>/data/jobs.db` (same state dir as the global store).
pub fn store() -> Result<&'static JobStore, AppError> {
    if let Some(s) = STORE.get() {
        return Ok(s);
    }
    let base = std::env::var_os("IXTABLE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("ixtable"));
    let opened = JobStore::open(&base.join("data").join("jobs.db"))?;
    let _ = STORE.set(opened);
    Ok(STORE.get().unwrap())
}

fn document(window: &str) -> Result<String, AppError> {
    Ok(crate::manager()?.state(window)?.document_id)
}

#[tauri::command]
pub fn enqueue_job(window_label: String, job: crate::jobs::EnqueueJob) -> Result<Job, AppError> {
    store()?.enqueue(&document(&window_label)?, &job, Utc::now())
}
#[tauri::command]
pub fn claim_next_job(
    window_label: String,
    lease_ms: Option<u64>,
) -> Result<Option<Job>, AppError> {
    store()?.claim_next(
        &document(&window_label)?,
        Utc::now(),
        lease_ms.unwrap_or(DEFAULT_LEASE_MS),
    )
}
#[tauri::command]
pub fn complete_job(window_label: String, id: String, log: Option<Value>) -> Result<Job, AppError> {
    store()?.complete(
        &document(&window_label)?,
        &id,
        &log.unwrap_or(Value::Null),
        Utc::now(),
    )
}
#[tauri::command]
pub fn fail_job(
    window_label: String,
    id: String,
    error: String,
    log: Option<Value>,
) -> Result<Job, AppError> {
    store()?.fail(
        &document(&window_label)?,
        &id,
        &error,
        &log.unwrap_or(Value::Null),
        Utc::now(),
    )
}
#[tauri::command]
pub fn cancel_job(window_label: String, id: String) -> Result<Job, AppError> {
    store()?.cancel(&document(&window_label)?, &id, Utc::now())
}
#[tauri::command]
pub fn retry_job(window_label: String, id: String) -> Result<Job, AppError> {
    store()?.retry(&document(&window_label)?, &id, Utc::now())
}
#[tauri::command]
pub fn list_jobs(
    window_label: String,
    filter: Option<crate::jobs::JobFilter>,
) -> Result<Vec<Job>, AppError> {
    store()?.list(&document(&window_label)?, &filter.unwrap_or_default())
}
#[tauri::command]
pub fn job_attempts(window_label: String, id: String) -> Result<Vec<JobAttempt>, AppError> {
    store()?.attempts(&document(&window_label)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ixtable-jobs-{}", uuid::Uuid::new_v4()));
        dir.join("jobs.db")
    }
    fn req(key: &str) -> EnqueueJob {
        EnqueueJob {
            trigger_id: "t1".into(),
            action_id: "a1".into(),
            payload: serde_json::json!({"record": {"id": 1}}),
            idempotency_key: key.into(),
            max_attempts: Some(3),
            backoff_ms: Some(1000),
        }
    }
    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn enqueue_is_idempotent_per_document() {
        let s = JobStore::open(&temp()).unwrap();
        let a = s.enqueue("doc", &req("k1"), t0()).unwrap();
        let b = s.enqueue("doc", &req("k1"), t0()).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(s.list("doc", &JobFilter::default()).unwrap().len(), 1);
        let other = s.enqueue("doc2", &req("k1"), t0()).unwrap();
        assert_ne!(other.id, a.id);
        assert!(s.enqueue("doc", &req(" "), t0()).is_err());
    }

    #[test]
    fn claim_is_atomic_and_exclusive() {
        let path = temp();
        let s = JobStore::open(&path).unwrap();
        for i in 0..5 {
            s.enqueue("doc", &req(&format!("k{i}")), t0()).unwrap();
        }
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let s = JobStore { path };
                    let mut mine = vec![];
                    while let Some(j) = s.claim_next("doc", t0(), 60_000).unwrap() {
                        mine.push(j.id);
                    }
                    mine
                })
            })
            .collect();
        let mut all: Vec<String> = handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect();
        assert_eq!(all.len(), 5);
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 5, "a job was claimed twice");
        let running = s
            .list(
                "doc",
                &JobFilter {
                    status: Some("running".into()),
                    limit: None,
                },
            )
            .unwrap();
        assert_eq!(running.len(), 5);
        assert!(running.iter().all(|j| j.attempts == 1));
        assert!(s.claim_next("other-doc", t0(), 1).unwrap().is_none());
    }

    #[test]
    fn failure_retries_with_exponential_backoff_until_failed() {
        let s = JobStore::open(&temp()).unwrap();
        let j = s.enqueue("doc", &req("k"), t0()).unwrap();
        let mut now = t0();
        let mut delays = vec![];
        for attempt in 1..=3 {
            let claimed = s.claim_next("doc", now, 60_000).unwrap().unwrap();
            assert_eq!(claimed.attempts, attempt);
            let failed = s
                .fail(
                    "doc",
                    &j.id,
                    &format!("boom {attempt}"),
                    &serde_json::json!([]),
                    now,
                )
                .unwrap();
            if attempt < 3 {
                assert_eq!(failed.status, "queued");
                let next = DateTime::parse_from_rfc3339(&failed.next_run_at).unwrap();
                delays.push((next.with_timezone(&Utc) - now).num_milliseconds());
                // Not due before the backoff elapses.
                assert!(s.claim_next("doc", now, 60_000).unwrap().is_none());
                now = next.with_timezone(&Utc);
            } else {
                assert_eq!(failed.status, "failed");
                assert_eq!(failed.last_error.as_deref(), Some("boom 3"));
            }
        }
        assert_eq!(delays, vec![1000, 2000]);
        let history = s.attempts("doc", &j.id).unwrap();
        assert_eq!(history.len(), 3);
        assert!(history
            .iter()
            .all(|a| a.ok == Some(false) && a.finished_at.is_some()));
        assert_eq!(backoff_delay(1000, 30), MAX_BACKOFF_MS);
    }

    #[test]
    fn complete_records_success_and_log() {
        let s = JobStore::open(&temp()).unwrap();
        let j = s.enqueue("doc", &req("k"), t0()).unwrap();
        assert!(
            s.complete("doc", &j.id, &Value::Null, t0()).is_err(),
            "not running"
        );
        s.claim_next("doc", t0(), 60_000).unwrap().unwrap();
        let done = s
            .complete("doc", &j.id, &serde_json::json!([{"ok": true}]), t0())
            .unwrap();
        assert_eq!(done.status, "succeeded");
        let history = s.attempts("doc", &j.id).unwrap();
        assert_eq!(history[0].ok, Some(true));
        assert_eq!(history[0].log, serde_json::json!([{"ok": true}]));
    }

    #[test]
    fn cancel_and_retry() {
        let s = JobStore::open(&temp()).unwrap();
        let j = s.enqueue("doc", &req("k"), t0()).unwrap();
        assert_eq!(s.cancel("doc", &j.id, t0()).unwrap().status, "cancelled");
        assert!(s.claim_next("doc", t0(), 60_000).unwrap().is_none());
        assert!(s.cancel("doc", &j.id, t0()).is_err());
        assert_eq!(s.retry("doc", &j.id, t0()).unwrap().status, "queued");
        let running = s.claim_next("doc", t0(), 60_000).unwrap().unwrap();
        assert!(
            s.retry("doc", &j.id, t0()).is_err(),
            "running jobs cannot be retried"
        );
        // Cancelling a running job refuses its later result.
        s.cancel("doc", &running.id, t0()).unwrap();
        assert!(s.complete("doc", &running.id, &Value::Null, t0()).is_err());
        // Retry after exhausting attempts grants one more.
        let k = s
            .enqueue(
                "doc",
                &EnqueueJob {
                    max_attempts: Some(1),
                    ..req("k2")
                },
                t0(),
            )
            .unwrap();
        s.claim_next("doc", t0(), 60_000).unwrap();
        assert_eq!(
            s.fail("doc", &k.id, "x", &Value::Null, t0())
                .unwrap()
                .status,
            "failed"
        );
        let again = s.retry("doc", &k.id, t0()).unwrap();
        assert_eq!((again.status.as_str(), again.max_attempts), ("queued", 2));
        assert!(s.cancel("doc", "missing", t0()).is_err());
    }

    #[test]
    fn expired_leases_recover_after_restart() {
        let path = temp();
        {
            let s = JobStore::open(&path).unwrap();
            s.enqueue("doc", &req("k"), t0()).unwrap();
            s.enqueue("doc", &req("k-last"), t0()).unwrap();
            // Claim with a lease already in the past relative to "now" on restart.
            s.claim_next("doc", t0(), 1000).unwrap().unwrap();
            let last = s.claim_next("doc", t0(), 1000).unwrap().unwrap();
            // Make the second job's attempt its last one.
            Connection::open(&path)
                .unwrap()
                .execute("UPDATE jobs SET max_attempts=1 WHERE id=?1", [&last.id])
                .unwrap();
        }
        // "Restart": a new store on the same file recovers expired leases on open.
        let s = JobStore::open(&path).unwrap();
        let jobs = s.list("doc", &JobFilter::default()).unwrap();
        let by_key = |k: &str| jobs.iter().find(|j| j.idempotency_key == k).unwrap();
        assert_eq!(by_key("k").status, "queued");
        assert_eq!(by_key("k-last").status, "failed");
        assert!(by_key("k")
            .last_error
            .as_deref()
            .unwrap()
            .contains("Lease expired"));
        let history = s.attempts("doc", &by_key("k").id).unwrap();
        assert_eq!(history[0].ok, Some(false));
        // A lease that has not expired is left alone.
        let claimed = s.claim_next("doc", Utc::now(), 60_000).unwrap().unwrap();
        assert_eq!(claimed.attempts, 2);
        assert_eq!(s.recover_expired(Utc::now()).unwrap(), 0);
    }
}
