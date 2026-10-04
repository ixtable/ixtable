//! Stored bytes per archive payload, for size reports (PRD §7.4).
use super::{attachment_owner, has_chunks, header, open_read_only, DATA_OWNER};
use crate::archive::ArchiveError;
use std::{fs, path::Path};

/// One sized entry of an archive file, for size reports (PRD §7.4).
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SizeEntry {
    pub section: String,
    pub id: String,
    pub name: String,
    pub bytes: u64,
}

/// Stored (compressed) bytes per payload of an archive file, plus its total file size.
pub fn size_entries(path: &Path) -> Result<(u64, Vec<SizeEntry>), ArchiveError> {
    let conn = open_read_only(path)?;
    header(&conn)?;
    let chunked = has_chunks(&conn)?;
    let chunk_bytes = |owner: &str| -> Result<u64, ArchiveError> {
        if !chunked {
            return Ok(0);
        }
        Ok(conn.query_row(
            "SELECT COALESCE(SUM(length(contents)),0) FROM payload_chunks WHERE owner=?1",
            [owner],
            |r| r.get::<_, i64>(0),
        )? as u64)
    };
    let mut entries = vec![];
    let data: i64 = conn.query_row(
        "SELECT length(contents) FROM data_payload WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    entries.push(SizeEntry {
        section: "records".into(),
        id: DATA_OWNER.into(),
        name: "Record data (data.db)".into(),
        bytes: data as u64 + chunk_bytes(DATA_OWNER)?,
    });
    let config: i64 = conn.query_row(
        "SELECT length(CAST(json AS BLOB)) FROM document_config WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    entries.push(SizeEntry {
        section: "config".into(),
        id: "document_config".into(),
        name: "Application configuration".into(),
        bytes: config as u64,
    });
    let rows: Vec<(String, String, i64)> = {
        let mut stmt =
            conn.prepare("SELECT id, display_name, length(contents) FROM attachments")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, name, bytes) in rows {
        let extra = chunk_bytes(&attachment_owner(&id))?;
        entries.push(SizeEntry {
            section: "assets".into(),
            id,
            name,
            bytes: bytes as u64 + extra,
        });
    }
    Ok((fs::metadata(path)?.len(), entries))
}
