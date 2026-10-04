//! The 500 MB boundary (Phase 1 exit). Opt-in because it writes about 1.5 GB of
//! temporary files: `IXTABLE_HEAVY_TESTS=1 cargo test --lib durability_tests::heavy`.
use super::fresh_manager;
use crate::archive_io;
use crate::assets::CLOUD_LIMIT_BYTES;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

/// Just over the limit once the archive's own tables are added.
const ASSET_BYTES: u64 = CLOUD_LIMIT_BYTES + 1_000_000;

/// Streams incompressible bytes to `path` (zstd would shrink zeros or a sparse file to nothing).
fn write_noise(path: &Path, len: u64) {
    let mut out = BufWriter::new(File::create(path).unwrap());
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut chunk = vec![0u8; 1 << 20];
    let mut left = len;
    while left > 0 {
        for b in chunk.iter_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            *b = seed as u8;
        }
        let n = left.min(chunk.len() as u64) as usize;
        out.write_all(&chunk[..n]).unwrap();
        left -= n as u64;
    }
    out.flush().unwrap();
}

#[test]
fn archive_over_500_mb_saves_reopens_and_is_blocked_from_publishing() {
    if std::env::var("IXTABLE_HEAVY_TESTS").as_deref() != Ok("1") {
        eprintln!("skipped: set IXTABLE_HEAVY_TESTS=1 to run the 500 MB boundary test");
        return;
    }
    let (base, m) = fresh_manager("heavy");
    let w = "heavy";
    m.new_session(w).unwrap();
    let source = base.join("large.bin");
    write_noise(&source, ASSET_BYTES);
    let imported = m
        .import_asset(w, &source, Some("application/octet-stream"))
        .unwrap();
    fs::remove_file(&source).unwrap();
    let path = base.join("large.ixt");
    m.save(w, Some(path.clone())).unwrap();
    let size = fs::metadata(&path).unwrap().len();
    assert!(size > CLOUD_LIMIT_BYTES, "archive is {size} bytes");

    let report = m.archive_size_report(w).unwrap();
    assert_eq!(report.measured, "saved");
    assert_eq!(report.total_bytes, size);
    assert!(report.over_cloud_limit);
    assert_eq!(report.largest[0].section, "assets");
    assert!(report.largest[0].bytes >= ASSET_BYTES);
    let config = m.config(w).unwrap();
    let preflight = crate::cloud::publish::assess(&config, &[], report, vec![], 1);
    assert!(
        preflight
            .blockers
            .iter()
            .any(|b| b.contains("ixtable Cloud accepts up to 500 MB")),
        "{:?}",
        preflight.blockers
    );
    m.close(w, true).unwrap();

    archive_io::verify(&path).unwrap();
    m.open(w, &path).unwrap();
    let asset = m.asset_path(w, &imported.asset.id).unwrap();
    assert_eq!(fs::metadata(asset).unwrap().len(), ASSET_BYTES);
    assert!(m.archive_size_report(w).unwrap().over_cloud_limit);
    m.close(w, true).unwrap();
    let _ = fs::remove_dir_all(base);
}
