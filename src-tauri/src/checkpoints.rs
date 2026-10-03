//! Local recovery checkpoints (PRD §7.2, §24): validated archive copies stored under
//! `<state>/data/checkpoints/<documentId>/<checkpointId>.ixt` with a JSON sidecar.
//!
//! A checkpoint packs the session's current state, including unsaved WIP, so a
//! migration or recovery can always be undone by restoring it as a copy.
use crate::{
    archive::ArchiveMetadata,
    archive_io::{self, Payload, WriteRequest},
    logging,
    manager::{AppError, DocumentManager},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// Checkpoints kept per document; older ones are pruned.
pub const KEEP_CHECKPOINTS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub id: String,
    pub document_id: String,
    pub reason: String,
    pub created_at: String,
    pub path: String,
    pub size: u64,
}

fn io_error(e: impl ToString) -> AppError {
    AppError::new("IO_ERROR", e)
}

impl DocumentManager {
    fn checkpoint_dir(&self, document_id: &str) -> PathBuf {
        self.checkpoint_root.join(document_id)
    }
    fn record_checkpoint(
        &self,
        document_id: &str,
        id: String,
        reason: &str,
        path: &Path,
    ) -> Result<CheckpointInfo, AppError> {
        let info = CheckpointInfo {
            id,
            document_id: document_id.into(),
            reason: reason.into(),
            created_at: Utc::now().to_rfc3339(),
            path: path.to_string_lossy().into(),
            size: fs::metadata(path).map_err(io_error)?.len(),
        };
        fs::write(
            path.with_extension("json"),
            serde_json::to_vec_pretty(&info).map_err(io_error)?,
        )
        .map_err(io_error)?;
        logging::info(
            "checkpoint",
            &format!(
                "created checkpoint {} ({reason}) for {document_id}",
                info.id
            ),
        );
        self.prune_checkpoints(document_id);
        Ok(info)
    }
    fn checkpoints_of(&self, document_id: &str) -> Vec<CheckpointInfo> {
        let mut all: Vec<CheckpointInfo> = fs::read_dir(self.checkpoint_dir(document_id))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x == "json"))
                    .filter_map(|p| fs::read(p).ok())
                    .filter_map(|b| serde_json::from_slice::<CheckpointInfo>(&b).ok())
                    .filter(|c| Path::new(&c.path).exists())
                    .collect()
            })
            .unwrap_or_default();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        all
    }
    fn prune_checkpoints(&self, document_id: &str) {
        for old in self
            .checkpoints_of(document_id)
            .into_iter()
            .skip(KEEP_CHECKPOINTS)
        {
            let path = PathBuf::from(&old.path);
            let _ = fs::remove_file(path.with_extension("json"));
            let _ = fs::remove_file(path);
        }
    }
    /// Packs the session's current state (including unsaved edits) into a validated local checkpoint archive.
    pub fn create_checkpoint(
        &self,
        window: &str,
        reason: &str,
    ) -> Result<CheckpointInfo, AppError> {
        let snap = self.with_session(window, |s| Ok(self.snapshot(s)))?;
        let id = Uuid::new_v4().to_string();
        let document_id = snap.metadata.document_id.clone();
        let path = self.checkpoint_dir(&document_id).join(format!("{id}.ixt"));
        self.write_snapshot(&snap, &path).inspect_err(|e| {
            logging::error(
                "checkpoint",
                &format!("checkpoint for {document_id} failed: {e}"),
            );
        })?;
        self.record_checkpoint(&document_id, id, reason, &path)
    }
    /// Copies an existing archive file into the checkpoint store after validating it.
    pub fn checkpoint_archive(
        &self,
        archive: &Path,
        reason: &str,
    ) -> Result<CheckpointInfo, AppError> {
        let document_id = archive_io::verify(archive)?.metadata.document_id;
        let id = Uuid::new_v4().to_string();
        let dir = self.checkpoint_dir(&document_id);
        fs::create_dir_all(&dir).map_err(io_error)?;
        let path = dir.join(format!("{id}.ixt"));
        let part = dir.join(format!("{id}.part"));
        let copied = fs::copy(archive, &part)
            .map_err(io_error)
            .and_then(|_| Ok(archive_io::verify(&part)?))
            .and_then(|_| fs::rename(&part, &path).map_err(io_error));
        if let Err(e) = copied {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        self.record_checkpoint(&document_id, id, reason, &path)
    }
    /// Checkpoints of the session's document, newest first.
    pub fn list_checkpoints(&self, window: &str) -> Result<Vec<CheckpointInfo>, AppError> {
        let document_id = self.with_session(window, |s| Ok(s.doc.metadata.document_id.clone()))?;
        Ok(self.checkpoints_of(&document_id))
    }
    /// Writes a checkpoint to `dest` as a separate document (new document id), leaving the open session and its archive untouched. Returns the written path.
    pub fn restore_checkpoint_as_copy(
        &self,
        window: &str,
        checkpoint_id: &str,
        dest: &Path,
    ) -> Result<String, AppError> {
        let info = self
            .list_checkpoints(window)?
            .into_iter()
            .find(|c| c.id == checkpoint_id)
            .ok_or_else(|| AppError::new("NOT_FOUND", "Checkpoint not found"))?;
        let cache = self
            .recovery_root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir);
        let work = cache.join(format!("restore-{}", Uuid::new_v4()));
        let result = (|| {
            let doc = archive_io::extract_to(Path::new(&info.path), &work)?;
            let now = Utc::now().to_rfc3339();
            let metadata = ArchiveMetadata {
                document_id: Uuid::new_v4().to_string(),
                created_at: now.clone(),
                updated_at: now,
                application_version: env!("CARGO_PKG_VERSION").into(),
            };
            let data = work.join("data.db");
            let assets: Vec<PathBuf> = doc
                .attachments
                .iter()
                .map(|a| archive_io::asset_content(&work, &a.id))
                .collect();
            archive_io::write(
                dest,
                WriteRequest {
                    metadata: &metadata,
                    config: &doc.config,
                    data: Payload::File(&data),
                    attachments: doc
                        .attachments
                        .iter()
                        .zip(&assets)
                        .map(|(a, p)| (a, Payload::File(p)))
                        .collect(),
                    preserve_from: None,
                },
            )?;
            Ok::<_, AppError>(())
        })();
        let _ = fs::remove_dir_all(&work);
        result?;
        let _ = self.global.add_recent(dest);
        logging::info(
            "checkpoint",
            &format!("restored checkpoint {checkpoint_id} as {}", dest.display()),
        );
        Ok(dest.to_string_lossy().into())
    }
}

#[tauri::command]
pub fn create_checkpoint(
    window_label: String,
    reason: Option<String>,
) -> Result<CheckpointInfo, AppError> {
    crate::manager()?.create_checkpoint(&window_label, reason.as_deref().unwrap_or("manual"))
}
#[tauri::command]
pub fn list_checkpoints(window_label: String) -> Result<Vec<CheckpointInfo>, AppError> {
    crate::manager()?.list_checkpoints(&window_label)
}
#[tauri::command]
pub fn restore_checkpoint_as_copy(
    window_label: String,
    checkpoint_id: String,
    path: String,
) -> Result<String, AppError> {
    crate::manager()?.restore_checkpoint_as_copy(&window_label, &checkpoint_id, Path::new(&path))
}
