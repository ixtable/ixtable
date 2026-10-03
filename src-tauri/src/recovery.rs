//! Crash recovery of extracted WIP (PRD §7.2, §27.1).
//!
//! Each open session works in `recovery/<sessionId>/` and is registered in the global
//! `recovery_sessions` table with a `dirty` flag. A session that ended without closing
//! (crash, kill) leaves both behind. On the next start, dirty leftovers are offered for
//! recovery; clean leftovers hold nothing new and are removed. Recovering validates the
//! WIP, reopens it, checkpoints the current `.ixt` locally, and saves the WIP back into
//! the `.ixt`. Invalid WIP never touches the archive: the error is surfaced instead.
use crate::{
    archive::{ArchiveDocument, ArchiveError, ArchiveMetadata, Attachment, DocumentConfig},
    archive_io::{self, HashingReader},
    logging,
    manager::{AppError, DocumentManager, SessionState},
    storage::RecoveryRecord,
};
use chrono::Utc;
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader},
    path::{Path, PathBuf},
};

fn storage_error(e: impl ToString) -> AppError {
    AppError::new("IO_ERROR", e)
}

/// Checks that a leftover workspace can be reopened: `data.db` passes SQLite's
/// integrity check, `document.json` loads, and every asset matches its checksum.
pub fn validate_workspace(work: &Path, record: &RecoveryRecord) -> Result<ArchiveDocument, String> {
    let db = work.join("data.db");
    if !db.is_file() {
        return Err("data.db is missing".into());
    }
    let integrity: String = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("PRAGMA integrity_check", [], |r| r.get(0)))
        .map_err(|e| format!("data.db is not a valid database: {e}"))?;
    if integrity != "ok" {
        return Err(format!("data.db failed its integrity check: {integrity}"));
    }
    let json = fs::read(work.join("document.json"))
        .map_err(|e| format!("document.json is missing: {e}"))?;
    let config = serde_json::from_slice::<DocumentConfig>(&json)
        .map_err(|e| format!("document.json is invalid: {e}"))?
        .upgrade()
        .map_err(|e| e.to_string())?;
    config.design.validate()?;
    let metadata = match fs::read(work.join("archive.json")) {
        Ok(bytes) => serde_json::from_slice::<ArchiveMetadata>(&bytes)
            .map_err(|e| format!("archive.json is invalid: {e}"))?,
        Err(_) => {
            let now = Utc::now().to_rfc3339();
            ArchiveMetadata {
                document_id: record.document_id.clone(),
                created_at: now.clone(),
                updated_at: now,
                application_version: env!("CARGO_PKG_VERSION").into(),
            }
        }
    };
    if metadata.document_id != record.document_id {
        return Err("the workspace belongs to a different document".into());
    }
    let mut attachments = vec![];
    if let Ok(entries) = fs::read_dir(work.join("attachments")) {
        for entry in entries.filter_map(Result::ok) {
            let dir = entry.path();
            let hidden = entry.file_name().to_string_lossy().starts_with('.');
            if hidden || !dir.is_dir() {
                continue;
            }
            let meta: Attachment = fs::read(dir.join("metadata.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .ok_or_else(|| format!("asset {} has no valid metadata", dir.display()))?;
            let mut reader = HashingReader::new(BufReader::new(
                File::open(dir.join("content"))
                    .map_err(|e| format!("asset {} is missing: {e}", meta.display_name))?,
            ));
            io::copy(&mut reader, &mut io::sink()).map_err(|e| e.to_string())?;
            if reader.bytes != meta.size || reader.hex() != meta.checksum {
                return Err(format!(
                    "asset {} failed checksum validation",
                    meta.display_name
                ));
            }
            attachments.push(meta);
        }
    }
    attachments.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(ArchiveDocument {
        metadata,
        data: vec![],
        config,
        attachments,
    })
}

impl DocumentManager {
    fn open_session_ids(&self) -> HashSet<String> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.id.clone())
            .collect()
    }
    /// Sessions that ended without closing and still hold unsaved work. Leftovers without unsaved work are deleted here.
    pub fn recoverable_sessions(&self) -> Result<Vec<RecoveryRecord>, AppError> {
        let sessions = self.sessions.lock().unwrap();
        let open: HashSet<&str> = sessions.values().map(|s| s.id.as_str()).collect();
        let mut out = vec![];
        for r in self.global.recoveries().map_err(storage_error)? {
            if open.contains(r.session_id.as_str()) {
                continue;
            }
            if r.dirty {
                out.push(r);
                continue;
            }
            let _ = fs::remove_dir_all(&r.workspace);
            let _ = self.global.remove_recovery(&r.session_id);
            logging::info(
                "recovery",
                &format!(
                    "removed clean leftover workspace of session {}",
                    r.session_id
                ),
            );
        }
        Ok(out)
    }
    fn recovery_record(&self, session_id: &str) -> Result<RecoveryRecord, AppError> {
        if self.open_session_ids().contains(session_id) {
            return Err(AppError::new(
                "SESSION_OPEN",
                "That session is still open in this window",
            ));
        }
        self.global
            .recoveries()
            .map_err(storage_error)?
            .into_iter()
            .find(|r| r.session_id == session_id)
            .ok_or_else(|| AppError::new("NOT_FOUND", "No unsaved work to recover"))
    }
    pub fn discard_recovery(&self, session_id: &str) -> Result<(), AppError> {
        match self.recovery_record(session_id) {
            Ok(r) => {
                let _ = fs::remove_dir_all(&r.workspace);
            }
            Err(e) if e.code == "SESSION_OPEN" => return Err(e),
            Err(_) => {}
        }
        self.global
            .remove_recovery(session_id)
            .map_err(storage_error)?;
        logging::info(
            "recovery",
            &format!("discarded unsaved work of session {session_id}"),
        );
        Ok(())
    }
    /// Reopens a crashed session's WIP in `window`, then checkpoints it back into its `.ixt` (after saving a local checkpoint of the archive it replaces). Untitled work opens dirty and needs Save As.
    pub fn recover_session(
        &self,
        window: &str,
        session_id: &str,
    ) -> Result<SessionState, AppError> {
        let record = self.recovery_record(session_id)?;
        let work = PathBuf::from(&record.workspace);
        let doc = validate_workspace(&work, &record).map_err(|reason| {
            logging::error(
                "recovery",
                &format!("session {session_id} could not be recovered: {reason}"),
            );
            AppError::new(
                "RECOVERY_FAILED",
                format!("The unsaved work could not be recovered ({reason}). The last saved archive was kept."),
            )
        })?;
        let path = record.document_path.as_ref().map(PathBuf::from);
        let mut blocked = None;
        if let Some(p) = path.as_ref().filter(|p| p.exists()) {
            match archive_io::read_header(p) {
                Ok(h) if h.metadata.document_id == doc.metadata.document_id => {
                    if let Err(e) = self.checkpoint_archive(p, "before-recovery") {
                        logging::warn("recovery", &format!("pre-recovery checkpoint failed: {e}"));
                    }
                }
                Ok(_) => blocked = Some("The file now holds a different document. Use Save As to keep the recovered work."),
                Err(ArchiveError::NewerFormat(_)) => blocked = Some("The file was saved by a newer ixtable. Use Save As to keep the recovered work."),
                Err(e) => logging::warn(
                    "recovery",
                    &format!("{} is unreadable ({e}); it will be replaced", p.display()),
                ),
            }
        }
        let state =
            self.install_workspace(window, session_id.into(), path.clone(), doc, work, true)?;
        logging::info("recovery", &format!("recovered session {session_id}"));
        if let Some(message) = blocked {
            return self.with_session(window, |s| {
                s.conflict = true;
                s.last_error = Some(AppError::new("EXTERNAL_CONFLICT", message));
                Ok(s.state())
            });
        }
        if path.is_none() {
            return Ok(state);
        }
        match self.save(window, None) {
            Ok(state) => Ok(state),
            Err(_) => self.state(window),
        }
    }
}

/// Reopens unsaved work left by a session that did not close, and saves it back.
#[tauri::command]
pub fn recover_session(window_label: String, session_id: String) -> Result<SessionState, AppError> {
    crate::manager()?.recover_session(&window_label, &session_id)
}

/// Test-bridge only: forgets a session the way a crash would (no close, no cleanup),
/// so integration tests can exercise recovery inside one process.
#[cfg(feature = "test-bridge")]
#[tauri::command]
pub fn simulate_crash(window_label: String) -> Result<(), AppError> {
    let m = crate::manager()?;
    let session = m.sessions.lock().unwrap().remove(&window_label);
    session
        .map(drop)
        .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{add_attachment, create_document};

    fn workspace() -> (PathBuf, RecoveryRecord) {
        let work = std::env::temp_dir().join(format!("ixtable-wip-{}", uuid::Uuid::new_v4()));
        let mut doc = create_document("WIP").unwrap();
        add_attachment(
            &mut doc,
            "a.txt".into(),
            "text/plain".into(),
            b"asset".to_vec(),
        );
        archive_io::extract_document(&doc, &work).unwrap();
        Connection::open(work.join("data.db"))
            .unwrap()
            .execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY); INSERT INTO item VALUES(1);")
            .unwrap();
        let record = RecoveryRecord {
            session_id: "s1".into(),
            document_id: doc.metadata.document_id.clone(),
            workspace: work.to_string_lossy().into(),
            document_path: None,
            updated_at: Utc::now().to_rfc3339(),
            dirty: true,
            name: Some("WIP".into()),
        };
        (work, record)
    }

    #[test]
    fn valid_wip_workspaces_load_with_their_assets() {
        let (work, record) = workspace();
        let doc = validate_workspace(&work, &record).unwrap();
        assert_eq!(doc.config.name, "WIP");
        assert_eq!(doc.metadata.document_id, record.document_id);
        assert_eq!(doc.attachments.len(), 1);
        assert!(doc.attachments[0].contents.is_empty());
        fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn invalid_wip_is_reported_not_loaded() {
        let (work, record) = workspace();
        let id = validate_workspace(&work, &record).unwrap().attachments[0]
            .id
            .clone();
        fs::write(archive_io::asset_content(&work, &id), b"tampered").unwrap();
        assert!(validate_workspace(&work, &record)
            .unwrap_err()
            .contains("failed checksum validation"));
        fs::write(work.join("document.json"), b"{\"name\":").unwrap();
        assert!(validate_workspace(&work, &record)
            .unwrap_err()
            .contains("document.json is invalid"));
        fs::write(work.join("data.db"), b"not sqlite at all, just text").unwrap();
        assert!(validate_workspace(&work, &record)
            .unwrap_err()
            .contains("data.db"));
        let other = RecoveryRecord {
            document_id: "someone-else".into(),
            ..record
        };
        fs::remove_file(work.join("data.db")).unwrap();
        assert_eq!(
            validate_workspace(&work, &other).unwrap_err(),
            "data.db is missing"
        );
        fs::remove_dir_all(work).unwrap();
    }
}
