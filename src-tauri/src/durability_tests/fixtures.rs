//! Archive upgrade fixtures (PRD §26.5). `tests/fixtures/archives/format-<N>/` holds
//! one `.ixt` per golden app, written by the build that introduced format N, plus a
//! `manifest.json` of what each must contain. Every later build must keep opening
//! them. Never rewrite an existing fixture directory: when the format changes, add
//! `format-<N+1>/` with `node scripts/ci/write-archive-fixtures.mjs`.
use super::{count_rows, fresh_manager};
use crate::archive_io::{self, FORMAT_VERSION, MIN_FORMAT_VERSION};
use crate::manager::DocumentManager;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const APPS: &[(&str, &[&str])] = &[
    (
        "crm",
        &[
            "deal_stages",
            "companies",
            "contacts",
            "deals",
            "activities",
        ],
    ),
    (
        "inventory",
        &[
            "suppliers",
            "locations",
            "products",
            "stock_movements",
            "reorder_thresholds",
            "transfers",
        ],
    ),
    (
        "work-orders",
        &[
            "statuses",
            "priorities",
            "assignees",
            "assets",
            "work_orders",
            "tasks",
            "work_order_log",
        ],
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AssetEntry {
    id: String,
    checksum: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FixtureEntry {
    file: String,
    format_version: i64,
    document_id: String,
    forms: Vec<String>,
    queries: Vec<String>,
    reports: Vec<String>,
    dashboards: Vec<String>,
    rows: BTreeMap<String, i64>,
    assets: Vec<AssetEntry>,
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/archives")
}

/// What the open document in `window` holds, in manifest form.
fn describe(
    m: &DocumentManager,
    window: &str,
    file: &str,
    format_version: i64,
    tables: &[&str],
) -> FixtureEntry {
    let c = m.config(window).unwrap();
    let mut assets: Vec<AssetEntry> = m
        .asset_list(window)
        .unwrap()
        .into_iter()
        .map(|a| AssetEntry {
            id: a.id,
            checksum: a.checksum,
            size: a.size,
        })
        .collect();
    assets.sort_by(|a, b| a.id.cmp(&b.id));
    FixtureEntry {
        file: file.into(),
        format_version,
        document_id: m.state(window).unwrap().document_id,
        forms: c.design.forms.iter().map(|f| f.id.clone()).collect(),
        queries: c.saved_queries.iter().map(|q| q.id.clone()).collect(),
        reports: c.reports.iter().map(|r| r.id.clone()).collect(),
        dashboards: c.dashboards.iter().map(|d| d.id.clone()).collect(),
        rows: tables
            .iter()
            .map(|t| (t.to_string(), count_rows(m, window, t)))
            .collect(),
        assets,
    }
}

/// Opens `path` in `window` and checks it against `expected`, asset bytes included.
fn check_open(m: &DocumentManager, window: &str, path: &Path, expected: &FixtureEntry, what: &str) {
    m.open(window, path)
        .unwrap_or_else(|e| panic!("{what}: open: {e}"));
    let tables: Vec<&str> = expected.rows.keys().map(String::as_str).collect();
    let header = archive_io::read_header(path).unwrap();
    let actual = describe(m, window, &expected.file, header.format_version, &tables);
    assert_eq!(&actual, expected, "{what}");
    for a in &expected.assets {
        let bytes = fs::read(m.asset_path(window, &a.id).unwrap()).unwrap();
        assert_eq!(
            archive_io::sha256_hex(&bytes),
            a.checksum,
            "{what}: asset {}",
            a.id
        );
    }
}

/// Every committed fixture opens with this build and holds what its manifest says,
/// then survives a save (an upgrade, for older formats) and a reopen.
#[test]
fn committed_archive_fixtures_open_save_and_reopen() {
    let mut dirs: Vec<PathBuf> = fs::read_dir(root())
        .expect("tests/fixtures/archives exists")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("manifest.json").is_file())
        .collect();
    dirs.sort();
    assert!(!dirs.is_empty(), "no archive fixtures are committed");
    let (base, m) = fresh_manager("fixtures");
    for dir in dirs {
        let manifest: Vec<FixtureEntry> =
            serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.len(), APPS.len(), "{}", dir.display());
        for expected in manifest {
            let what = format!("{}/{}", dir.display(), expected.file);
            let fixture = dir.join(&expected.file);
            assert!(
                (MIN_FORMAT_VERSION..=FORMAT_VERSION).contains(&expected.format_version),
                "{what}: format {} is no longer supported",
                expected.format_version
            );
            archive_io::verify(&fixture).unwrap_or_else(|e| panic!("{what}: verify: {e}"));
            // Work on a copy: saving must never touch the committed fixture.
            let copy = base.join(&expected.file);
            fs::copy(&fixture, &copy).unwrap();
            let window = format!("fixture-{}", expected.file);
            check_open(&m, &window, &copy, &expected, &what);
            m.mark_data_dirty(&window).unwrap();
            m.save(&window, None)
                .unwrap_or_else(|e| panic!("{what}: save: {e}"));
            archive_io::verify(&copy).unwrap();
            let upgraded = FixtureEntry {
                format_version: FORMAT_VERSION,
                ..expected
            };
            check_open(&m, &window, &copy, &upgraded, &format!("{what} (reopened)"));
            m.close(&window, true).unwrap();
            fs::remove_file(&copy).unwrap();
        }
    }
    let _ = fs::remove_dir_all(base);
}

/// Writes `format-<FORMAT_VERSION>/` from the golden templates. Refuses to overwrite.
#[test]
#[ignore = "writes committed fixtures: node scripts/ci/write-archive-fixtures.mjs"]
fn write_archive_fixtures() {
    let dir = root().join(format!("format-{FORMAT_VERSION}"));
    assert!(
        !dir.exists(),
        "{} exists; fixtures of a released format are never rewritten",
        dir.display()
    );
    let (base, m) = fresh_manager("write-fixtures");
    fs::create_dir_all(&dir).unwrap();
    let mut manifest = vec![];
    for (app, tables) in APPS {
        let window = format!("write-{app}");
        crate::templates::create(&m, &window, app).unwrap();
        let file = format!("{app}.ixt");
        m.save(&window, Some(dir.join(&file))).unwrap();
        manifest.push(describe(&m, &window, &file, FORMAT_VERSION, tables));
        m.close(&window, true).unwrap();
    }
    assert!(
        manifest.iter().all(|e| e.rows.values().all(|n| *n > 0)),
        "every fixture table is seeded"
    );
    assert!(
        !manifest[1].assets.is_empty(),
        "the inventory fixture carries an asset"
    );
    fs::write(
        dir.join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
    .unwrap();
    let _ = fs::remove_dir_all(base);
}
