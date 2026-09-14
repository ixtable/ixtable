//! Crash-safe `.ixt` checkpoints: write a complete temporary archive, fsync,
//! validate, then rename over the previous file.
use crate::archive::{self, ArchiveDocument};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub struct Autosave {
    path: PathBuf,
    debounce: Duration,
    dirty_since: Option<Instant>,
}

impl Autosave {
    pub fn new(path: PathBuf, debounce: Duration) -> Self {
        Self {
            path,
            debounce,
            dirty_since: None,
        }
    }

    pub fn mark_dirty(&mut self) {
        if self.dirty_since.is_none() {
            self.dirty_since = Some(Instant::now());
        }
    }

    pub fn maybe_flush(&mut self, doc: &ArchiveDocument) -> Result<bool, archive::ArchiveError> {
        let Some(started) = self.dirty_since else {
            return Ok(false);
        };
        if started.elapsed() < self.debounce {
            return Ok(false);
        }
        archive::write_archive(&self.path, doc)?;
        self.dirty_since = None;
        Ok(true)
    }

    pub fn flush(&mut self, doc: &ArchiveDocument) -> Result<(), archive::ArchiveError> {
        archive::write_archive(&self.path, doc)?;
        self.dirty_since = None;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Leaves a sibling `.partial` file and never replaces `path`. Models a crash
/// after bytes hit disk but before the atomic rename.
pub fn interrupted_checkpoint(
    path: &Path,
    doc: &ArchiveDocument,
) -> Result<PathBuf, archive::ArchiveError> {
    let partial = path.with_extension("ixt.partial");
    archive::write_archive(&partial, doc)?;
    let mut truncated = fs::read(&partial)?;
    truncated.truncate(truncated.len() / 2);
    fs::write(&partial, truncated)?;
    Ok(partial)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{add_attachment, create_document, read_archive};
    use uuid::Uuid;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ixtable-phase0-{name}-{}.ixt", Uuid::new_v4()))
    }

    #[test]
    fn read_write_autosave_round_trips_config_and_data() {
        let path = tmp("autosave");
        let mut doc = create_document("Phase0").unwrap();
        doc.config.name = "Saved".into();
        let mut autosave = Autosave::new(path.clone(), Duration::from_secs(60));
        autosave.mark_dirty();
        assert!(!autosave.maybe_flush(&doc).unwrap());
        autosave.flush(&doc).unwrap();
        let opened = read_archive(&path).unwrap();
        assert_eq!(opened.config.name, "Saved");
        assert_eq!(opened.data, doc.data);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn interrupted_write_keeps_last_valid_checkpoint() {
        let path = tmp("atomic");
        let mut original = create_document("Original").unwrap();
        original.config.name = "Original".into();
        archive::write_archive(&path, &original).unwrap();

        let mut next = create_document("Next").unwrap();
        next.config.name = "Should not appear".into();
        add_attachment(&mut next, "blob.bin".into(), "application/octet-stream".into(), vec![7; 8 * 1024 * 1024]);
        let partial = interrupted_checkpoint(&path, &next).unwrap();
        assert!(partial.exists());
        let recovered = read_archive(&path).unwrap();
        assert_eq!(recovered.config.name, "Original");
        assert!(recovered.attachments.is_empty());
        assert!(read_archive(&partial).is_err());
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(partial);
    }

    #[test]
    fn large_asset_checkpoint_round_trips_checksum() {
        let path = tmp("large");
        let mut doc = create_document("Assets").unwrap();
        let payload: Vec<u8> = (0..4 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        add_attachment(
            &mut doc,
            "photo.bin".into(),
            "application/octet-stream".into(),
            payload.clone(),
        );
        archive::write_archive(&path, &doc).unwrap();
        let opened = read_archive(&path).unwrap();
        assert_eq!(opened.attachments.len(), 1);
        assert_eq!(opened.attachments[0].contents, payload);
        assert_eq!(opened.attachments[0].size, payload.len() as u64);
        let _ = fs::remove_file(path);
    }
}
