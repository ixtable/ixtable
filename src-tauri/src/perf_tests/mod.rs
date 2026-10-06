//! Performance budget harness (PRD §27.3, docs/decisions/performance-budgets.md).
//! Ignored and report-only: `IXTABLE_PERF=1 cargo test --lib perf_tests -- --include-ignored --test-threads=1`
//! writes `reports/perf/rust.json` (or `$IXTABLE_PERF_OUT/rust.json`) and the fixture
//! archive the UI harness (`tests/perf/`) opens. A budget miss is reported, never failed.
use crate::durability_tests::fresh_manager;
use crate::manager::DocumentManager;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

mod fixture;
mod scenarios;

/// Timed samples per scenario (after one untimed warm-up).
pub(crate) const SAMPLES: usize = 7;

pub(crate) fn enabled() -> bool {
    crate::test_env::flag("IXTABLE_PERF")
}

pub(crate) fn out_dir() -> PathBuf {
    let dir = std::env::var_os("IXTABLE_PERF_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("reports")
                .join("perf")
        });
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One measured scenario, written as an entry of `rust.json`.
pub(crate) struct Measurement {
    pub id: &'static str,
    pub target: &'static str,
    pub budget_ms: Option<f64>,
    pub samples: Vec<Duration>,
    pub note: String,
}
impl Measurement {
    pub fn json(&self) -> Value {
        let mut ms: Vec<f64> = self
            .samples
            .iter()
            .map(|d| (d.as_secs_f64() * 1000.0 * 10.0).round() / 10.0)
            .collect();
        let samples = ms.clone();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pick = |q: f64| ms[((ms.len() as f64 - 1.0) * q).round() as usize];
        json!({
            "id": self.id,
            "target": self.target,
            "budgetMs": self.budget_ms,
            "medianMs": pick(0.5),
            "p95Ms": pick(0.95),
            "samplesMs": samples,
            "note": self.note,
        })
    }
}

static RESULTS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// Records a measurement and rewrites `rust.json` with every result so far.
pub(crate) fn record(m: Measurement) {
    let entry = m.json();
    eprintln!("perf {entry}");
    let mut all = RESULTS.lock().unwrap_or_else(|e| e.into_inner());
    all.retain(|e| e["id"] != entry["id"]);
    all.push(entry);
    let report = json!({
        "suite": "rust",
        "fixture": fixture::DESCRIPTION,
        "results": *all,
    });
    std::fs::write(
        out_dir().join("rust.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}

/// Runs `f` once untimed, then `SAMPLES` times timed.
pub(crate) fn sample(mut f: impl FnMut() -> Duration) -> Vec<Duration> {
    f();
    (0..SAMPLES).map(|_| f()).collect()
}

pub(crate) fn time(f: impl FnOnce()) -> Duration {
    let t0 = Instant::now();
    f();
    t0.elapsed()
}

/// A manager with the fixture document saved at a fresh path.
pub(crate) fn fixture_manager(tag: &str) -> (PathBuf, DocumentManager, PathBuf) {
    let (base, m) = fresh_manager(tag);
    let path = base.join("perf-fixture.ixt");
    fixture::build(&m, "perf", &path);
    m.close("perf", true).unwrap();
    (base, m, path)
}

#[test]
#[ignore = "timing harness; needs IXTABLE_PERF=1 and --include-ignored"]
fn write_fixture_for_the_ui_harness() {
    if !enabled() {
        return;
    }
    let (base, m, path) = fixture_manager("perf-fixture");
    let dest = out_dir().join("perf-fixture.ixt");
    std::fs::copy(&path, &dest).unwrap();
    crate::archive_io::verify(&dest).unwrap();
    drop(m);
    let _ = std::fs::remove_dir_all(base);
}
