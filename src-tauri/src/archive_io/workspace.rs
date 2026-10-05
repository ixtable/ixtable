//! Working-session layout: `data.db`, `document.json`, `config.yaml`, `archive.json`,
//! and `attachments/<id>/{content,metadata.json}`.
use super::{visit, Visitor};
use crate::archive::{ArchiveDocument, ArchiveError, ArchiveMetadata, Attachment, DocumentConfig};
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

/// `work/attachments/<id>`. Never leaves `work/attachments`, even for an unsafe id.
pub fn asset_dir(work: &Path, id: &str) -> PathBuf {
    crate::paths::child(&work.join("attachments"), id)
}

/// Rejects ids that cannot be used as a single path component (see [`crate::paths::is_safe_id`]).
pub fn check_ids(doc_id: &str, attachments: &[Attachment]) -> Result<(), ArchiveError> {
    if !crate::paths::is_safe_id(doc_id) {
        return Err(ArchiveError::Invalid(format!(
            "unsafe document id {doc_id:?}"
        )));
    }
    match attachments
        .iter()
        .find(|a| !crate::paths::is_safe_id(&a.id))
    {
        Some(a) => Err(ArchiveError::Invalid(format!(
            "unsafe attachment id {:?}",
            a.id
        ))),
        None => Ok(()),
    }
}
pub fn asset_content(work: &Path, id: &str) -> PathBuf {
    asset_dir(work, id).join("content")
}

/// Replaces `path` atomically: writes a sibling temp file, fsyncs it, renames it
/// over `path`, then fsyncs the directory (where supported). A crash leaves
/// either the old or the new content, never a truncated file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    // Directory fsync makes the rename durable; Windows cannot open directories.
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Writes `document.json` and `config.yaml` for a working session, each atomically.
/// Recovery reads `document.json` and falls back to `config.yaml`.
pub fn write_config_files(work: &Path, config: &DocumentConfig) -> Result<(), ArchiveError> {
    write_atomic(
        &work.join("document.json"),
        &serde_json::to_vec_pretty(config).map_err(|e| ArchiveError::Invalid(e.to_string()))?,
    )?;
    write_atomic(
        &work.join("config.yaml"),
        crate::archive::document_config_yaml(config)?.as_bytes(),
    )?;
    Ok(())
}
pub fn write_asset_metadata(work: &Path, a: &Attachment) -> Result<(), ArchiveError> {
    let dir = asset_dir(work, &a.id);
    fs::create_dir_all(&dir)?;
    write_atomic(
        &dir.join("metadata.json"),
        &serde_json::to_vec_pretty(a).map_err(|e| ArchiveError::Invalid(e.to_string()))?,
    )?;
    Ok(())
}
/// Writes the session's archive metadata (`archive.json`) used by crash recovery.
pub fn write_session_metadata(work: &Path, m: &ArchiveMetadata) -> Result<(), ArchiveError> {
    write_atomic(
        &work.join("archive.json"),
        &serde_json::to_vec_pretty(m).map_err(|e| ArchiveError::Invalid(e.to_string()))?,
    )?;
    Ok(())
}

/// Streams an archive into a working-session directory: `data.db`, `document.json`,
/// `config.yaml`, `archive.json`, and `attachments/<id>/{content,metadata.json}`.
/// The returned document carries metadata only (`data` and `contents` stay empty).
pub fn extract_to(path: &Path, work: &Path) -> Result<ArchiveDocument, ArchiveError> {
    fs::create_dir_all(work)?;
    let data_path = work.join("data.db");
    let doc = visit(
        path,
        Visitor {
            data: &mut || Ok(Box::new(io::BufWriter::new(File::create(&data_path)?))),
            attachment: &mut |a| {
                fs::create_dir_all(asset_dir(work, &a.id))?;
                Ok(Box::new(io::BufWriter::new(File::create(asset_content(
                    work, &a.id,
                ))?)))
            },
            skip: &[],
        },
    )?;
    write_config_files(work, &doc.config)?;
    write_session_metadata(work, &doc.metadata)?;
    for a in &doc.attachments {
        write_asset_metadata(work, a)?;
    }
    Ok(doc)
}

/// Lays out an in-memory document as a working session (new documents).
pub fn extract_document(doc: &ArchiveDocument, work: &Path) -> Result<(), ArchiveError> {
    check_ids(&doc.metadata.document_id, &doc.attachments)?;
    fs::create_dir_all(work)?;
    fs::write(work.join("data.db"), &doc.data)?;
    write_config_files(work, &doc.config)?;
    write_session_metadata(work, &doc.metadata)?;
    for a in &doc.attachments {
        write_asset_metadata(work, a)?;
        fs::write(asset_content(work, &a.id), &a.contents)?;
    }
    Ok(())
}

/// Identifies one committed state of a workspace `data.db` without reading its pages:
/// SQLite's file change counter and schema cookie (bumped by every commit in rollback
/// journal mode), the file size, and the modification time. Equal stamps mean no
/// commit in between, so the data payload saved at that stamp can be reused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataStamp {
    header: [u8; 16],
    len: u64,
    modified: Option<std::time::SystemTime>,
}

/// The stamp of `work/data.db`, or None when it cannot vouch for the file: WAL mode
/// (the counter is not bumped), a journal or WAL file present, or an unreadable header.
pub fn data_stamp(work: &Path) -> Option<DataStamp> {
    use std::io::Read;
    let db = work.join("data.db");
    for side in ["data.db-journal", "data.db-wal"] {
        if work.join(side).exists() {
            return None;
        }
    }
    let meta = fs::metadata(&db).ok()?;
    let mut page = [0u8; 100];
    File::open(&db).ok()?.read_exact(&mut page).ok()?;
    // Bytes 18/19 are the write/read format versions: 2 means WAL.
    if !page.starts_with(b"SQLite format 3\0") || page[18] != 1 || page[19] != 1 {
        return None;
    }
    let mut header = [0u8; 16];
    // Change counter (24..28), page count (28..32), and schema cookie (40..44).
    header[..8].copy_from_slice(&page[24..32]);
    header[8..12].copy_from_slice(&page[40..44]);
    header[12..16].copy_from_slice(&page[92..96]);
    Some(DataStamp {
        header,
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}
