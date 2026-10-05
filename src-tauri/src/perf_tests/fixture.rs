//! The fixed fixture every budget is measured on: the CRM golden template with
//! `DEALS` deals, `COMPANIES` extra companies, one `ASSET_BYTES` incompressible asset,
//! and a row filter on the Deals list that keeps 1% of the deals.
use crate::manager::DocumentManager;
use std::path::Path;

pub(crate) const DEALS: i64 = 50_000;
pub(crate) const COMPANIES: i64 = 1_000;
pub(crate) const ASSET_BYTES: usize = 8 * 1024 * 1024;
/// The Deals list form of the CRM template.
pub(crate) const DEALS_FORM: &str = "01a100fd-dedd-7ddb-98e1-141bd197f27f";
/// Keeps deals with amount 99,000 and up: about 500 of 50,000.
pub(crate) const DEALS_FILTER: &str = "record.amount >= 99000";
pub(crate) const DESCRIPTION: &str =
    "CRM template + 50,000 deals, 1,000 extra companies, one 8 MiB asset, Deals list filter keeping 1%";

/// Incompressible bytes (zstd would shrink zeros to nothing).
pub(crate) fn noise(len: usize) -> Vec<u8> {
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    (0..len)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        })
        .collect()
}

/// Creates the fixture in `window` and saves it to `path` (the session stays open).
pub(crate) fn build(m: &DocumentManager, window: &str, path: &Path) {
    crate::templates::create(m, window, "crm").unwrap();
    let db = m.database_path(window).unwrap();
    let mut conn = rusqlite::Connection::open(&db).unwrap();
    let tx = conn.transaction().unwrap();
    {
        let mut company = tx
            .prepare("INSERT INTO companies(name, industry, city) VALUES (?1, ?2, ?3)")
            .unwrap();
        for i in 0..COMPANIES {
            company
                .execute(rusqlite::params![
                    format!("Perf company {i:04}"),
                    ["Retail", "Software", "Logistics", "Health"][(i % 4) as usize],
                    ["Berlin", "Lagos", "Lima", "Osaka", "Perth"][(i % 5) as usize],
                ])
                .unwrap();
        }
        let companies: i64 = tx
            .query_row("SELECT max(id) FROM companies", [], |r| r.get(0))
            .unwrap();
        let mut deal = tx
            .prepare(
                "INSERT INTO deals(company_id, stage_id, title, amount, status, close_date, owner) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .unwrap();
        for i in 0..DEALS {
            deal.execute(rusqlite::params![
                1 + i % companies,
                1 + i % 6,
                format!("Perf deal {i:05}"),
                (i * 7919 % 100_000) as f64,
                ["open", "won", "lost"][(i % 3) as usize],
                format!("2026-{:02}-{:02}", 1 + i % 12, 1 + i % 28),
                ["Ana", "Ben", "Chen", "Dee"][(i % 4) as usize],
            ])
            .unwrap();
        }
    }
    tx.commit().unwrap();
    drop(conn);
    m.mark_data_dirty(window).unwrap();
    let asset = std::env::temp_dir().join(format!("ixtable-perf-{}.bin", uuid::Uuid::new_v4()));
    std::fs::write(&asset, noise(ASSET_BYTES)).unwrap();
    m.import_asset(window, &asset, Some("application/octet-stream"))
        .unwrap();
    let _ = std::fs::remove_file(&asset);
    let mut config = m.config(window).unwrap();
    let form = config
        .design
        .forms
        .iter_mut()
        .find(|f| f.id == DEALS_FORM)
        .expect("CRM Deals form");
    form.filter = Some(DEALS_FILTER.into());
    m.update_config(window, config).unwrap();
    m.save(window, Some(path.to_owned())).unwrap();
}
