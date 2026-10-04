//! Working-session layout: `data.db`, `document.json`, `config.yaml`, `archive.json`,
//! and `attachments/<id>/{content,metadata.json}`.
use super::{visit, Visitor};
use crate::archive::{ArchiveDocument, ArchiveError, ArchiveMetadata, Attachment, DocumentConfig};
use std::{
    fs::{self, File},
    io,
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

/// Writes `document.json` and `config.yaml` for a working session.
pub fn write_config_files(work: &Path, config: &DocumentConfig) -> Result<(), ArchiveError> {
    fs::write(
        work.join("document.json"),
        serde_json::to_vec_pretty(config).map_err(|e| ArchiveError::Invalid(e.to_string()))?,
    )?;
    fs::write(
        work.join("config.yaml"),
        crate::archive::document_config_yaml(config)?,
    )?;
    Ok(())
}
pub fn write_asset_metadata(work: &Path, a: &Attachment) -> Result<(), ArchiveError> {
    let dir = asset_dir(work, &a.id);
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("metadata.json"),
        serde_json::to_vec_pretty(a).map_err(|e| ArchiveError::Invalid(e.to_string()))?,
    )?;
    Ok(())
}
/// Writes the session's archive metadata (`archive.json`) used by crash recovery.
pub fn write_session_metadata(work: &Path, m: &ArchiveMetadata) -> Result<(), ArchiveError> {
    fs::write(
        work.join("archive.json"),
        serde_json::to_vec_pretty(m).map_err(|e| ArchiveError::Invalid(e.to_string()))?,
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
