//! Restore to a new local copy (PRD §23): a verified cloud archive opens as a
//! new untitled document with a new document id. The archive's definition,
//! embedded SQLite data, and attachments come back together; PostgreSQL
//! records are external and are not restored (the UI shows that first).
use super::err;
use crate::archive_io;
use crate::manager::{AppError, SessionState};
use chrono::Utc;
use std::path::Path;
use uuid::Uuid;

/// Opens `archive` (already checksum-verified) as an untitled copy in `window`,
/// replacing the window's session.
/// `version_id` (a published checkpoint) becomes the copy's publish base.
pub fn open_copy(
    window: &str,
    archive: &Path,
    version_id: Option<&str>,
) -> Result<SessionState, AppError> {
    let m = crate::manager()?;
    let id = Uuid::new_v4().to_string();
    let workspace = m.recovery_root.join(&id);
    let result = (|| {
        let mut doc = archive_io::extract_to(archive, &workspace)?;
        let now = Utc::now().to_rfc3339();
        doc.metadata.document_id = Uuid::new_v4().to_string();
        doc.metadata.created_at = now.clone();
        doc.metadata.updated_at = now;
        doc.metadata.application_version = env!("CARGO_PKG_VERSION").into();
        archive_io::write_session_metadata(&workspace, &doc.metadata)?;
        if let (Some(link), Some(v)) = (doc.config.cloud.as_mut(), version_id) {
            link.head_version_id = Some(v.to_string());
            archive_io::write_config_files(&workspace, &doc.config)?;
        }
        Ok::<_, crate::archive::ArchiveError>(doc)
    })();
    let doc = match result {
        Ok(doc) => doc,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&workspace);
            return Err(err(
                "RESTORE_FAILED",
                format!("The archive could not be opened: {e}"),
            ));
        }
    };
    let state = m.install_workspace(window, id, None, doc, workspace, true)?;
    crate::logging::info("cloud", "restored a cloud archive as a new local copy");
    Ok(state)
}
