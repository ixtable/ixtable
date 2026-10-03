//! Format, upgrade, preservation, and interrupted-write tests for `archive_io`.
use super::*;
use crate::archive::{add_attachment, create_document};

const V1_SCHEMA: &str = "PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
 CREATE TABLE archive_metadata(format_version INTEGER NOT NULL, document_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, application_version TEXT NOT NULL);
 CREATE TABLE data_payload(id INTEGER PRIMARY KEY CHECK(id=1), compression TEXT NOT NULL, checksum TEXT NOT NULL, uncompressed_size INTEGER NOT NULL, contents BLOB NOT NULL);
 CREATE TABLE document_config(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, json TEXT NOT NULL);
 CREATE TABLE attachments(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, media_type TEXT NOT NULL, checksum TEXT NOT NULL, uncompressed_size INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, compression TEXT NOT NULL, contents BLOB NOT NULL);";

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ixtable-archive-io-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

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

fn data_db_with_rows() -> Vec<u8> {
    let path = std::env::temp_dir().join(format!("ixtable-v1-data-{}.db", Uuid::new_v4()));
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO item VALUES(1,'kept');")
        .unwrap();
    let bytes = fs::read(&path).unwrap();
    fs::remove_file(path).unwrap();
    bytes
}

/// Writes a format 1 archive exactly as ixtable 0.1 did, plus a table from the "future".
fn write_v1_fixture(path: &Path, doc: &ArchiveDocument) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(V1_SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO archive_metadata VALUES(1,?1,?2,?3,'0.1.0')",
        params![
            doc.metadata.document_id,
            doc.metadata.created_at,
            doc.metadata.updated_at
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO data_payload VALUES(1,'zstd',?1,?2,?3)",
        params![
            sha256_hex(&doc.data),
            doc.data.len() as i64,
            zstd::stream::encode_all(&doc.data[..], 3).unwrap()
        ],
    )
    .unwrap();
    let mut legacy = serde_json::to_value(&doc.config).unwrap();
    legacy["version"] = 2.into();
    conn.execute(
        "INSERT INTO document_config VALUES(1,2,?1)",
        [legacy.to_string()],
    )
    .unwrap();
    for a in &doc.attachments {
        conn.execute(
            "INSERT INTO attachments VALUES(?1,?2,?3,?4,?5,?6,?7,'zstd',?8)",
            params![
                a.id,
                a.display_name,
                a.media_type,
                sha256_hex(&a.contents),
                a.contents.len() as i64,
                a.created_at,
                a.updated_at,
                zstd::stream::encode_all(&a.contents[..], 3).unwrap()
            ],
        )
        .unwrap();
    }
    conn.execute_batch(
        "CREATE TABLE future_notes(id INTEGER PRIMARY KEY, body TEXT, upper_body TEXT GENERATED ALWAYS AS (upper(body)));
         CREATE INDEX future_notes_body ON future_notes(body);
         INSERT INTO future_notes(id, body) VALUES(1,'from a newer build'),(2,'second');
         CREATE VIEW future_view AS SELECT body FROM future_notes;",
    )
    .unwrap();
}

#[test]
fn format_one_archive_opens_and_upgrades_on_save_preserving_unknown_tables() {
    let dir = temp_dir();
    let path = dir.join("legacy.ixt");
    let mut doc = create_document("Legacy").unwrap();
    doc.data = data_db_with_rows();
    add_attachment(
        &mut doc,
        "logo.png".into(),
        "image/png".into(),
        b"png bytes".to_vec(),
    );
    write_v1_fixture(&path, &doc);

    assert_eq!(read_header(&path).unwrap().format_version, 1);
    let opened = read_archive(&path).unwrap();
    assert_eq!(opened.data, doc.data);
    assert_eq!(opened.config.version, crate::archive::CONFIG_VERSION);
    assert_eq!(opened.attachments[0].contents, b"png bytes");

    let work = dir.join("work");
    let extracted = extract_to(&path, &work).unwrap();
    assert!(extracted.data.is_empty() && extracted.attachments[0].contents.is_empty());
    assert_eq!(fs::read(work.join("data.db")).unwrap(), doc.data);
    let content = asset_content(&work, &extracted.attachments[0].id);
    assert_eq!(fs::read(&content).unwrap(), b"png bytes");

    let data = work.join("data.db");
    let report = write(
        &path,
        WriteRequest {
            metadata: &extracted.metadata,
            config: &extracted.config,
            data: Payload::File(&data),
            attachments: vec![(&extracted.attachments[0], Payload::File(&content))],
            preserve_from: Some(&path),
        },
    )
    .unwrap();
    assert_eq!(report.preserved_tables, vec!["future_notes".to_string()]);
    assert_eq!(read_header(&path).unwrap().format_version, FORMAT_VERSION);
    let conn = Connection::open(&path).unwrap();
    let app_id: i32 = conn
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .unwrap();
    assert_eq!(app_id, APPLICATION_ID);
    let notes: Vec<(String, String)> = conn
        .prepare("SELECT body, upper_body FROM future_notes ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        notes[0],
        ("from a newer build".into(), "FROM A NEWER BUILD".into())
    );
    let objects: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('future_notes_body','future_view')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(objects, 1, "indexes are kept, views are not");
    drop(conn);
    let reopened = read_archive(&path).unwrap();
    assert_eq!(reopened.data, doc.data);
    assert_eq!(reopened.attachments[0].contents, b"png bytes");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn newer_and_ancient_formats_are_rejected_with_clear_messages() {
    let dir = temp_dir();
    let path = dir.join("future.ixt");
    write_archive(&path, &create_document("Future").unwrap()).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE archive_metadata SET format_version=99", [])
        .unwrap();
    let error = read_archive(&path).unwrap_err();
    assert!(matches!(error, ArchiveError::NewerFormat(99)));
    assert_eq!(
        error.to_string(),
        "This document was created by a newer ixtable (format 99). Update ixtable to open it."
    );
    assert!(matches!(check_format(0), Err(ArchiveError::Unsupported(0))));
    assert!(check_format(1).is_ok() && check_format(FORMAT_VERSION).is_ok());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn large_payloads_stream_through_chunks_and_validate_checksums() {
    let dir = temp_dir();
    let path = dir.join("large.ixt");
    let mut doc = create_document("Large").unwrap();
    let big = noise(CHUNK_BYTES * 2 + 1234, 7);
    add_attachment(
        &mut doc,
        "video.bin".into(),
        "application/octet-stream".into(),
        big.clone(),
    );
    write_archive(&path, &doc).unwrap();
    let conn = Connection::open(&path).unwrap();
    let chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM payload_chunks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(chunks, 2);
    let first: i64 = conn
        .query_row("SELECT length(contents) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(first as usize, CHUNK_BYTES);
    assert_eq!(read_archive(&path).unwrap().attachments[0].contents, big);
    let (total, entries) = size_entries(&path).unwrap();
    assert!(entries
        .iter()
        .any(|e| e.section == "assets" && e.bytes > big.len() as u64));
    assert!(total >= big.len() as u64);

    conn.execute(
        "UPDATE payload_chunks SET contents=zeroblob(length(contents)) WHERE seq=2",
        [],
    )
    .unwrap();
    drop(conn);
    assert!(matches!(verify(&path), Err(ArchiveError::Corrupt(_))));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn interrupted_or_failed_writes_leave_the_last_valid_archive() {
    let dir = temp_dir();
    let path = dir.join("doc.ixt");
    let mut doc = create_document("Valid").unwrap();
    add_attachment(
        &mut doc,
        "a.txt".into(),
        "text/plain".into(),
        b"original".to_vec(),
    );
    write_archive(&path, &doc).unwrap();
    let before = fs::read(&path).unwrap();

    // A crash mid-write leaves a temp sibling, possibly truncated; it is never read.
    let leftover = temp_sibling(&path);
    fs::write(&leftover, &before[..before.len() / 2]).unwrap();
    assert_eq!(stale_temp_files(&path), vec![leftover.clone()]);
    assert_eq!(
        read_archive(&path).unwrap().attachments[0].contents,
        b"original"
    );

    let missing = dir.join("missing-asset");
    let failed = write(
        &path,
        WriteRequest {
            metadata: &doc.metadata,
            config: &doc.config,
            data: Payload::Bytes(&doc.data),
            attachments: vec![(&doc.attachments[0], Payload::File(&missing))],
            preserve_from: Some(&path),
        },
    );
    assert!(failed.is_err());
    let mut tampered = doc.attachments[0].clone();
    tampered.checksum = sha256_hex(b"something else");
    let corrupt = write(
        &path,
        WriteRequest {
            metadata: &doc.metadata,
            config: &doc.config,
            data: Payload::Bytes(&doc.data),
            attachments: vec![(&tampered, Payload::Bytes(b"original"))],
            preserve_from: None,
        },
    );
    assert!(matches!(corrupt, Err(ArchiveError::Corrupt(_))));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(stale_temp_files(&path), vec![leftover]);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unknown_tables_are_not_copied_from_another_document() {
    let dir = temp_dir();
    let other = dir.join("other.ixt");
    let mut foreign = create_document("Other").unwrap();
    foreign.data = data_db_with_rows();
    write_v1_fixture(&other, &foreign);
    let mine = create_document("Mine").unwrap();
    let path = dir.join("mine.ixt");
    let report = write(
        &path,
        WriteRequest {
            metadata: &mine.metadata,
            config: &mine.config,
            data: Payload::Bytes(&mine.data),
            attachments: vec![],
            preserve_from: Some(&other),
        },
    )
    .unwrap();
    assert!(report.preserved_tables.is_empty());
    fs::remove_dir_all(dir).unwrap();
}

/// Rewrites one value of a written archive the way a hostile tool could.
fn tamper(path: &Path, sql: &str) {
    Connection::open(path).unwrap().execute_batch(sql).unwrap();
}

#[test]
fn attachment_ids_that_are_paths_reject_the_archive() {
    let dir = temp_dir();
    let path = dir.join("evil.ixt");
    let mut doc = create_document("Evil").unwrap();
    add_attachment(&mut doc, "a.txt".into(), "text/plain".into(), b"x".to_vec());
    write_archive(&path, &doc).unwrap();
    let victim = dir.join("victim");
    fs::create_dir_all(&victim).unwrap();
    fs::write(victim.join("keep.txt"), b"keep").unwrap();
    tamper(&path, "UPDATE attachments SET id='../../victim'");

    let work = dir.join("work").join("session");
    let err = extract_to(&path, &work).unwrap_err();
    assert!(
        matches!(err, ArchiveError::Invalid(ref m) if m.contains("unsafe attachment id")),
        "{err}"
    );
    assert!(read_archive(&path).is_err());
    assert!(
        !work.join("data.db").exists(),
        "nothing is extracted before the ids are checked"
    );
    assert_eq!(fs::read(victim.join("keep.txt")).unwrap(), b"keep");
    assert_eq!(crate::manager::AppError::from(err).code, "INVALID_ARCHIVE");

    // In-memory documents (bundle installs) are checked too.
    doc.attachments[0].id = "../../victim".into();
    assert!(extract_document(&doc, &dir.join("work2")).is_err());
    assert!(!dir.join("work2").exists());
    // Defense in depth: an unsafe id never resolves outside `attachments/`.
    assert_eq!(
        asset_dir(&work, "../../victim").parent(),
        Some(work.join("attachments").as_path())
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn document_ids_that_are_paths_reject_the_archive() {
    let dir = temp_dir();
    let path = dir.join("evil-doc.ixt");
    write_archive(&path, &create_document("Evil").unwrap()).unwrap();
    tamper(
        &path,
        "UPDATE archive_metadata SET document_id='../../../outside'",
    );
    let err = read_header(&path).unwrap_err();
    assert!(err.to_string().contains("unsafe document id"), "{err}");
    assert!(verify(&path).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn hostile_schema_sql_of_unknown_tables_is_never_executed() {
    let dir = temp_dir();
    let path = dir.join("hostile.ixt");
    let pwned = dir.join("pwned.db");
    let doc = create_document("Hostile").unwrap();
    write_archive(&path, &doc).unwrap();
    // A schema row whose text smuggles a second statement after the CREATE TABLE.
    tamper(
        &path,
        &format!(
            "CREATE TABLE extra(x); INSERT INTO extra VALUES(1);
             PRAGMA writable_schema=ON;
             UPDATE sqlite_master SET sql='CREATE TABLE extra(x); ATTACH DATABASE ''{}'' AS pwn; CREATE TABLE pwn.t(y)' WHERE name='extra';
             PRAGMA writable_schema=OFF;",
            pwned.display()
        ),
    );
    let report = write(
        &path,
        WriteRequest {
            metadata: &doc.metadata,
            config: &doc.config,
            data: Payload::Bytes(&doc.data),
            attachments: vec![],
            preserve_from: Some(&path),
        },
    )
    .unwrap();
    assert!(report.preserved_tables.is_empty());
    assert!(!pwned.exists(), "the smuggled ATTACH never ran");
    read_archive(&path).unwrap();

    // Each statement is checked on its own, under an authorizer.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute("ATTACH DATABASE ':memory:' AS prev", [])
        .unwrap();
    for bad in [
        "CREATE TABLE a(x); DROP TABLE b",
        "CREATE TEMP TABLE a(x)",
        "CREATE TABLE prev.a(x)",
        "CREATE TABLE temp.a(x)",
        "ATTACH DATABASE 'x.db' AS y",
        "PRAGMA writable_schema=ON",
        "CREATE VIEW v AS SELECT 1",
    ] {
        assert!(
            run_preserved_ddl(&conn, bad, DdlKind::Table).is_err(),
            "{bad}"
        );
    }
    assert!(run_preserved_ddl(&conn, "CREATE INDEX i ON a(x)", DdlKind::Table).is_err());
    run_preserved_ddl(
        &conn,
        "  create table ok(x, y AS (upper(x)));  ",
        DdlKind::Table,
    )
    .unwrap();
    run_preserved_ddl(&conn, "CREATE UNIQUE INDEX ok_x ON ok(x)", DdlKind::Index).unwrap();
    assert!(run_preserved_ddl(&conn, "CREATE INDEX prev.i ON ok(x)", DdlKind::Index).is_err());
    // The authorizer is removed afterwards.
    conn.execute_batch("CREATE TEMP TABLE after_check(x)")
        .unwrap();
    fs::remove_dir_all(dir).unwrap();
}
