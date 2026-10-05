//! Incremental saves: payloads that did not change since the previous archive of the
//! same document are copied as compressed rows instead of being compressed again.
//! The copy goes into the new temp archive, so the atomic write path is unchanged.
use super::{attachment_owner, read_header, DATA_OWNER, FORMAT_VERSION};
use crate::archive::{ArchiveError, ArchiveMetadata, Attachment};
use rusqlite::{params, Connection};
use std::path::Path;

/// Attaches `prev` as `reuse` when it is a current-format archive of the same document.
pub(super) fn attach(
    conn: &Connection,
    prev: &Path,
    metadata: &ArchiveMetadata,
) -> Result<bool, ArchiveError> {
    match read_header(prev) {
        Ok(h)
            if h.format_version == FORMAT_VERSION
                && h.metadata.document_id == metadata.document_id => {}
        _ => return Ok(false),
    }
    conn.execute(
        "ATTACH DATABASE ?1 AS reuse",
        [prev.to_string_lossy().as_ref()],
    )?;
    Ok(true)
}

fn copy_chunks(conn: &Connection, owner: &str) -> Result<(), ArchiveError> {
    conn.execute(
        "INSERT INTO main.payload_chunks(owner,seq,contents) SELECT owner,seq,contents FROM reuse.payload_chunks WHERE owner=?1",
        [owner],
    )?;
    Ok(())
}

/// Copies the data payload; fails when the previous archive has none.
pub(super) fn copy_data(conn: &Connection) -> Result<(), ArchiveError> {
    let copied = conn.execute(
        "INSERT INTO main.data_payload SELECT id,compression,checksum,uncompressed_size,contents FROM reuse.data_payload WHERE id=1",
        [],
    )?;
    if copied != 1 {
        return Err(ArchiveError::Corrupt(
            "previous archive has no data payload to reuse".into(),
        ));
    }
    copy_chunks(conn, DATA_OWNER)
}

/// Copies an attachment's content when the previous archive holds the same id with the
/// same checksum and size; its descriptive fields come from `a`. False when it does not.
pub(super) fn copy_attachment(conn: &Connection, a: &Attachment) -> Result<bool, ArchiveError> {
    if a.checksum.is_empty() {
        return Ok(false);
    }
    let copied = conn.execute(
        "INSERT INTO main.attachments SELECT ?1,?2,?3,checksum,uncompressed_size,?4,?5,compression,contents FROM reuse.attachments WHERE id=?1 AND checksum=?6 AND uncompressed_size=?7",
        params![
            a.id,
            a.display_name,
            a.media_type,
            a.created_at,
            a.updated_at,
            a.checksum,
            a.size as i64
        ],
    )?;
    if copied == 0 {
        return Ok(false);
    }
    copy_chunks(conn, &attachment_owner(&a.id))?;
    Ok(true)
}
