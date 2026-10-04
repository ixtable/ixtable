//! `.ixt` file format I/O (PRD §7.1): streaming read/write, format versions, and
//! preservation of tables written by newer ixtable builds.
//!
//! Format history:
//! - **1**: `archive_metadata`, `data_payload`, `document_config`, `attachments`; each
//!   payload is one zstd stream stored in a single `contents` BLOB.
//! - **2**: same tables plus `payload_chunks`. A payload's zstd stream starts in the
//!   original `contents` column (at most [`CHUNK_BYTES`]) and continues in
//!   `payload_chunks(owner, seq)` rows, so no payload needs to sit in memory or hit
//!   SQLite's 1 GB BLOB limit. Small payloads stay single-row, exactly like format 1.
//!   `PRAGMA application_id` is set to `ixtb`.
//!
//! Format 1 archives open unchanged and are rewritten as format 2 on the next save.
//! Newer formats are rejected with a message asking the user to update ixtable.
//!
//! Unknown tables: on save, ordinary tables that ixtable does not know (added by a
//! newer build or a tool) are copied with their rows and indexes from the previous
//! archive of the same document. Views, triggers, and virtual tables are not copied
//! (they may reference or fire on tables whose shape changed), and nothing is copied
//! from an archive that belongs to a different document.
use crate::archive::{ArchiveDocument, ArchiveError, ArchiveMetadata, Attachment, DocumentConfig};
use crate::logging;
use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

mod preserve;
mod size;
mod stream;
mod workspace;
use preserve::preserve_unknown_tables;
#[cfg(test)]
use preserve::{run_preserved_ddl, DdlKind};
pub use size::{size_entries, SizeEntry};
use stream::{read_payload, write_payload};
pub use stream::{HashingReader, HashingWriter};
pub use workspace::{
    asset_content, asset_dir, check_ids, extract_document, extract_to, write_asset_metadata,
    write_config_files, write_session_metadata,
};

pub const FORMAT_VERSION: i64 = 2;
/// Oldest format this build can open (and upgrade on save).
pub const MIN_FORMAT_VERSION: i64 = 1;
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// `PRAGMA application_id` of format ≥ 2 archives: ASCII `ixtb`.
pub const APPLICATION_ID: i32 = 0x6978_7462;
pub const KNOWN_TABLES: [&str; 5] = [
    "archive_metadata",
    "data_payload",
    "document_config",
    "attachments",
    "payload_chunks",
];
pub(crate) const DATA_OWNER: &str = "data";

const SCHEMA: &str = "
CREATE TABLE archive_metadata(format_version INTEGER NOT NULL, document_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, application_version TEXT NOT NULL);
CREATE TABLE data_payload(id INTEGER PRIMARY KEY CHECK(id=1), compression TEXT NOT NULL, checksum TEXT NOT NULL, uncompressed_size INTEGER NOT NULL, contents BLOB NOT NULL);
CREATE TABLE document_config(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE attachments(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, media_type TEXT NOT NULL, checksum TEXT NOT NULL, uncompressed_size INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, compression TEXT NOT NULL, contents BLOB NOT NULL);
CREATE TABLE payload_chunks(owner TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq>=1), contents BLOB NOT NULL, PRIMARY KEY(owner, seq));";

/// Where a payload's uncompressed bytes come from when writing.
pub enum Payload<'a> {
    Bytes(&'a [u8]),
    File(&'a Path),
}
impl Payload<'_> {
    fn reader(&self) -> Result<Box<dyn Read + '_>, ArchiveError> {
        Ok(match self {
            Payload::Bytes(b) => Box::new(*b),
            Payload::File(p) => Box::new(File::open(p)?),
        })
    }
}

pub struct WriteRequest<'a> {
    pub metadata: &'a ArchiveMetadata,
    pub config: &'a DocumentConfig,
    pub data: Payload<'a>,
    pub attachments: Vec<(&'a Attachment, Payload<'a>)>,
    /// Previous archive of the same document whose unknown tables are carried over.
    pub preserve_from: Option<&'a Path>,
}

#[derive(Debug, Default)]
pub struct WriteReport {
    pub preserved_tables: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ArchiveHeader {
    pub format_version: i64,
    pub metadata: ArchiveMetadata,
}

pub fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// Accepts current and older supported formats; newer ones fail with an update hint.
pub fn check_format(version: i64) -> Result<(), ArchiveError> {
    if version > FORMAT_VERSION {
        return Err(ArchiveError::NewerFormat(version));
    }
    if version < MIN_FORMAT_VERSION {
        return Err(ArchiveError::Unsupported(version));
    }
    Ok(())
}

pub(crate) fn attachment_owner(id: &str) -> String {
    format!("attachment:{id}")
}

fn temp_sibling(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        Uuid::new_v4()
    ))
}

/// Leftover temp files from interrupted writes of `path`; never authoritative.
pub fn stale_temp_files(path: &Path) -> Vec<PathBuf> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let prefix = format!(
        ".{}.",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    fs::read_dir(parent)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().unwrap_or_default().to_string_lossy();
                    name.starts_with(&prefix) && name.ends_with(".tmp")
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Writes a complete archive to a temp sibling, validates it, then atomically renames it
/// over `path`. A failure at any step leaves `path` untouched.
pub fn write(path: &Path, req: WriteRequest<'_>) -> Result<WriteReport, ArchiveError> {
    req.config
        .design
        .validate()
        .map_err(ArchiveError::Invalid)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = temp_sibling(path);
    let _phase = write_phase::enter();
    let result = (|| {
        let mut report = WriteReport::default();
        let mut conn = Connection::open(&tmp)?;
        conn.execute_batch(&format!(
            "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA application_id={APPLICATION_ID};{SCHEMA}"
        ))?;
        if let Some(prev) = req.preserve_from.filter(|p| p.exists()) {
            report.preserved_tables = preserve_unknown_tables(&conn, prev, req.metadata)?;
        }
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO archive_metadata VALUES(?1,?2,?3,?4,?5)",
            params![
                FORMAT_VERSION,
                req.metadata.document_id,
                req.metadata.created_at,
                Utc::now().to_rfc3339(),
                req.metadata.application_version
            ],
        )?;
        let (first, sum, size) = write_payload(&tx, DATA_OWNER, &mut req.data.reader()?)?;
        tx.execute(
            "INSERT INTO data_payload VALUES(1,'zstd',?1,?2,?3)",
            params![sum, size as i64, first],
        )?;
        let json =
            serde_json::to_string(req.config).map_err(|e| ArchiveError::Invalid(e.to_string()))?;
        tx.execute(
            "INSERT INTO document_config VALUES(1,?1,?2)",
            params![req.config.version, json],
        )?;
        for (a, payload) in &req.attachments {
            let owner = attachment_owner(&a.id);
            let (first, sum, size) = write_payload(&tx, &owner, &mut payload.reader()?)?;
            if !a.checksum.is_empty() && a.checksum != sum {
                return Err(ArchiveError::Corrupt(format!(
                    "asset {} ({}) changed on disk: checksum mismatch",
                    a.display_name, a.id
                )));
            }
            tx.execute(
                "INSERT INTO attachments VALUES(?1,?2,?3,?4,?5,?6,?7,'zstd',?8)",
                params![
                    a.id,
                    a.display_name,
                    a.media_type,
                    sum,
                    size as i64,
                    a.created_at,
                    a.updated_at,
                    first
                ],
            )?;
        }
        tx.commit()?;
        drop(conn);
        File::options()
            .read(true)
            .write(true)
            .open(&tmp)?
            .sync_all()?;
        // Validate the complete temporary archive before replacing a valid destination.
        verify(&tmp)?;
        report.bytes = fs::metadata(&tmp)?.len();
        fs::rename(&tmp, path)?;
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(report)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Test-only hook: while an archive write or rename is in progress, the file named
/// by `IXTABLE_TEST_WRITE_MARKER` exists. The forced-termination test uses it to
/// kill a writer mid-write. Compiled out of non-test builds.
mod write_phase {
    pub struct Guard(#[cfg(test)] Option<std::path::PathBuf>);
    #[cfg(test)]
    pub fn enter() -> Guard {
        let marker = std::env::var_os("IXTABLE_TEST_WRITE_MARKER").map(std::path::PathBuf::from);
        if let Some(m) = &marker {
            let _ = std::fs::write(m, b"1");
        }
        Guard(marker)
    }
    #[cfg(not(test))]
    pub fn enter() -> Guard {
        Guard()
    }
    #[cfg(test)]
    impl Drop for Guard {
        fn drop(&mut self) {
            if let Some(m) = &self.0 {
                let _ = std::fs::remove_file(m);
            }
        }
    }
}

pub(crate) fn open_read_only(path: &Path) -> Result<Connection, ArchiveError> {
    if !path.exists() {
        return Err(ArchiveError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            "document not found",
        )));
    }
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}

pub(crate) fn header(conn: &Connection) -> Result<ArchiveHeader, ArchiveError> {
    let (format_version, metadata) = conn.query_row(
        "SELECT format_version,document_id,created_at,updated_at,application_version FROM archive_metadata LIMIT 1",
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                ArchiveMetadata {
                    document_id: r.get(1)?,
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                    application_version: r.get(4)?,
                },
            ))
        },
    )?;
    check_format(format_version)?;
    // The document id names checkpoint directories; never let it act as a path.
    if !crate::paths::is_safe_id(&metadata.document_id) {
        return Err(ArchiveError::Invalid(format!(
            "unsafe document id {:?}",
            metadata.document_id
        )));
    }
    Ok(ArchiveHeader {
        format_version,
        metadata,
    })
}

/// Reads only the metadata row (cheap); fails for unsupported formats.
pub fn read_header(path: &Path) -> Result<ArchiveHeader, ArchiveError> {
    header(&open_read_only(path)?)
}

pub(crate) fn has_chunks(conn: &Connection) -> Result<bool, ArchiveError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payload_chunks'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn read_config(conn: &Connection) -> Result<DocumentConfig, ArchiveError> {
    let json: String = conn.query_row("SELECT json FROM document_config WHERE id=1", [], |r| {
        r.get(0)
    })?;
    let config = serde_json::from_str::<DocumentConfig>(&json)
        .map_err(|e| ArchiveError::Invalid(e.to_string()))?
        .upgrade()?;
    config.design.validate().map_err(ArchiveError::Invalid)?;
    Ok(config)
}

fn attachment_rows(conn: &Connection) -> Result<Vec<Attachment>, ArchiveError> {
    let mut stmt = conn.prepare(
        "SELECT id,display_name,media_type,checksum,uncompressed_size,created_at,updated_at FROM attachments ORDER BY created_at,id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Attachment {
            id: r.get(0)?,
            display_name: r.get(1)?,
            media_type: r.get(2)?,
            checksum: r.get(3)?,
            size: r.get::<_, i64>(4)? as u64,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            contents: vec![],
        })
    })?;
    let rows: Vec<Attachment> = rows.collect::<Result<_, _>>()?;
    // Attachment ids name workspace directories; reject anything but a plain id.
    if let Some(bad) = rows.iter().find(|a| !crate::paths::is_safe_id(&a.id)) {
        return Err(ArchiveError::Invalid(format!(
            "unsafe attachment id {:?}",
            bad.id
        )));
    }
    Ok(rows)
}

/// Visits every payload of an archive: the data payload, then each attachment.
pub(crate) struct Visitor<'a> {
    pub data: &'a mut dyn FnMut() -> Result<Box<dyn Write>, ArchiveError>,
    pub attachment: &'a mut dyn FnMut(&Attachment) -> Result<Box<dyn Write>, ArchiveError>,
}

pub(crate) fn visit(path: &Path, v: Visitor<'_>) -> Result<ArchiveDocument, ArchiveError> {
    let conn = open_read_only(path)?;
    let ArchiveHeader {
        format_version,
        metadata,
    } = header(&conn)?;
    let chunked = has_chunks(&conn)?;
    // Validated before any payload is written out (ids become workspace paths).
    let attachments = attachment_rows(&conn)?;
    let (sum, size, first): (String, i64, Vec<u8>) = conn.query_row(
        "SELECT checksum,uncompressed_size,contents FROM data_payload WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let mut out = (v.data)()?;
    read_payload(
        &conn,
        chunked,
        DATA_OWNER,
        first,
        (&sum, size),
        &mut out,
        "data.db",
    )?;
    out.flush()?;
    drop(out);
    let config = read_config(&conn)?;
    for a in &attachments {
        let first: Vec<u8> = conn.query_row(
            "SELECT contents FROM attachments WHERE id=?1",
            [&a.id],
            |r| r.get(0),
        )?;
        let mut out = (v.attachment)(a)?;
        let label = format!("attachment {}", a.id);
        let owner = attachment_owner(&a.id);
        let expected = (a.checksum.as_str(), a.size as i64);
        read_payload(&conn, chunked, &owner, first, expected, &mut out, &label)?;
        out.flush()?;
    }
    if format_version < FORMAT_VERSION {
        logging::info(
            "migration",
            &format!(
                "opened archive format {format_version}; it is upgraded to format {FORMAT_VERSION} on the next save"
            ),
        );
    }
    Ok(ArchiveDocument {
        metadata,
        data: vec![],
        config,
        attachments,
    })
}

/// Streams every payload through checksum validation without keeping it.
pub fn verify(path: &Path) -> Result<ArchiveDocument, ArchiveError> {
    visit(
        path,
        Visitor {
            data: &mut || Ok(Box::new(io::sink())),
            attachment: &mut |_| Ok(Box::new(io::sink())),
        },
    )
}

/// Writes a buffer back through a shared cell so `visit` can fill in-memory documents.
struct SharedBuf(std::rc::Rc<std::cell::RefCell<Vec<u8>>>);
impl Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Reads a whole archive into memory. Prefer [`extract_to`] for working sessions.
pub fn read_archive(path: &Path) -> Result<ArchiveDocument, ArchiveError> {
    use std::{cell::RefCell, rc::Rc};
    let data = Rc::new(RefCell::new(Vec::new()));
    let blobs: Rc<RefCell<Vec<(String, Rc<RefCell<Vec<u8>>>)>>> = Rc::default();
    let data_cell = data.clone();
    let blob_list = blobs.clone();
    let mut doc = visit(
        path,
        Visitor {
            data: &mut || Ok(Box::new(SharedBuf(data_cell.clone()))),
            attachment: &mut |a| {
                let cell = Rc::new(RefCell::new(Vec::new()));
                blob_list.borrow_mut().push((a.id.clone(), cell.clone()));
                Ok(Box::new(SharedBuf(cell)))
            },
        },
    )?;
    doc.data = data.take();
    for (id, cell) in blobs.borrow().iter() {
        if let Some(a) = doc.attachments.iter_mut().find(|a| &a.id == id) {
            a.contents = cell.take();
        }
    }
    Ok(doc)
}

/// Writes an in-memory document (used for new documents and tests).
pub fn write_archive(path: &Path, doc: &ArchiveDocument) -> Result<(), ArchiveError> {
    write(
        path,
        WriteRequest {
            metadata: &doc.metadata,
            config: &doc.config,
            data: Payload::Bytes(&doc.data),
            attachments: doc
                .attachments
                .iter()
                .map(|a| (a, Payload::Bytes(&a.contents)))
                .collect(),
            preserve_from: Some(path),
        },
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests;
