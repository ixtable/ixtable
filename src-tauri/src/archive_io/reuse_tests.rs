//! Incremental saves: unchanged payloads are copied from the previous archive.
use super::*;
use crate::archive::{add_attachment, create_document};

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ixtable-reuse-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn request<'a>(
    doc: &'a ArchiveDocument,
    data: Payload<'a>,
    reuse_from: Option<&'a Path>,
) -> WriteRequest<'a> {
    WriteRequest {
        metadata: &doc.metadata,
        config: &doc.config,
        data,
        attachments: doc
            .attachments
            .iter()
            .map(|a| (a, Payload::Bytes(&a.contents)))
            .collect(),
        preserve_from: None,
        preserve_copy: false,
        reuse_from,
    }
}

/// A document with a data payload over one chunk and two attachments, saved at `path`.
fn saved_document(path: &Path) -> ArchiveDocument {
    let mut doc = create_document("Reuse").unwrap();
    doc.data = (0..CHUNK_BYTES * 2).map(|i| (i * 7 % 251) as u8).collect();
    for name in ["a.bin", "b.bin"] {
        add_attachment(
            &mut doc,
            name.into(),
            "application/octet-stream".into(),
            name.repeat(50_000).into_bytes(),
        );
    }
    write_archive(path, &doc).unwrap();
    doc
}

#[test]
fn unchanged_payloads_are_copied_and_the_archive_reads_back_the_same() {
    let dir = temp_dir();
    let path = dir.join("doc.ixt");
    let mut doc = saved_document(&path);
    doc.config.name = "Renamed".into();
    doc.attachments[1].display_name = "renamed.bin".into();
    let report = write(&path, request(&doc, Payload::Reuse, Some(&path))).unwrap();
    let mut reused = report.reused.clone();
    reused.sort();
    let mut expected = vec![
        DATA_OWNER.to_string(),
        attachment_owner(&doc.attachments[0].id),
        attachment_owner(&doc.attachments[1].id),
    ];
    expected.sort();
    assert_eq!(reused, expected);
    // A full verify decompresses every payload, the reused ones included.
    verify(&path).unwrap();
    let back = read_archive(&path).unwrap();
    assert_eq!(back.config.name, "Renamed");
    assert_eq!(back.data, doc.data);
    assert_eq!(back.attachments[1].display_name, "renamed.bin");
    for (a, b) in back.attachments.iter().zip(&doc.attachments) {
        assert_eq!(a.contents, b.contents);
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn changed_payloads_are_compressed_again() {
    let dir = temp_dir();
    let path = dir.join("doc.ixt");
    let mut doc = saved_document(&path);
    doc.data[0] ^= 0xff;
    let changed = b"new content".to_vec();
    doc.attachments[0].checksum = sha256_hex(&changed);
    doc.attachments[0].size = changed.len() as u64;
    doc.attachments[0].contents = changed;
    let report = write(&path, request(&doc, Payload::Bytes(&doc.data), Some(&path))).unwrap();
    assert_eq!(
        report.reused,
        vec![attachment_owner(&doc.attachments[1].id)]
    );
    let back = read_archive(&path).unwrap();
    assert_eq!(back.data, doc.data);
    assert_eq!(back.attachments[0].contents, b"new content");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn nothing_is_reused_from_another_document_or_a_missing_archive() {
    let dir = temp_dir();
    let path = dir.join("doc.ixt");
    saved_document(&path);
    let other = saved_document(&dir.join("other.ixt"));
    let dest = dir.join("dest.ixt");
    let report = write(
        &dest,
        request(&other, Payload::Bytes(&other.data), Some(&path)),
    )
    .unwrap();
    assert!(report.reused.is_empty());
    let gone = dir.join("gone.ixt");
    for from in [Some(path.as_path()), Some(gone.as_path()), None] {
        let err = write(&dest, request(&other, Payload::Reuse, from)).unwrap_err();
        assert!(matches!(err, ArchiveError::Corrupt(_)), "{err}");
    }
    // The failed writes left the last good archive and no temp files.
    assert_eq!(read_archive(&dest).unwrap().data, other.data);
    assert!(stale_temp_files(&dest).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn data_stamp_changes_with_every_commit_and_refuses_wal_files() {
    let dir = temp_dir();
    let db = dir.join("data.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE t(x)").unwrap();
    let before = data_stamp(&dir).unwrap();
    assert_eq!(data_stamp(&dir), Some(before.clone()));
    // Same size, same schema: only the change counter tells the commits apart.
    conn.execute("INSERT INTO t VALUES(1)", []).unwrap();
    let after_insert = data_stamp(&dir).unwrap();
    assert_ne!(after_insert, before);
    conn.execute("UPDATE t SET x = 2", []).unwrap();
    assert_ne!(data_stamp(&dir).unwrap(), after_insert);
    conn.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    assert_eq!(data_stamp(&dir), None);
    drop(conn);
    assert_eq!(data_stamp(&dir.join("missing")), None);
    fs::remove_dir_all(dir).unwrap();
}
