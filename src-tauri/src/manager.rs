use crate::{
    archive::{self, ArchiveDocument, DocumentConfig, SavedQuery},
    data::{self, ReadRuntime},
    storage::{GlobalStorage, RecoveryRecord},
};
use chrono::Utc;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(code: &str, e: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: e.to_string(),
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl From<archive::ArchiveError> for AppError {
    fn from(e: archive::ArchiveError) -> Self {
        let code = match &e {
            archive::ArchiveError::Unsupported(_) => "UNSUPPORTED_VERSION",
            archive::ArchiveError::Corrupt(_) => "CORRUPT_PAYLOAD",
            archive::ArchiveError::Invalid(_) | archive::ArchiveError::Sql(_) => "INVALID_ARCHIVE",
            archive::ArchiveError::Io(x) if x.kind() == std::io::ErrorKind::NotFound => {
                "MISSING_FILE"
            }
            _ => "IO_ERROR",
        };
        Self::new(code, e)
    }
}

#[derive(Clone)]
struct Fingerprint {
    modified: Option<SystemTime>,
    size: u64,
    identity: String,
}
pub struct Session {
    pub id: String,
    pub window: String,
    pub path: Option<PathBuf>,
    pub workspace: PathBuf,
    pub doc: ArchiveDocument,
    pub reader: ReadRuntime,
    pub dirty: bool,
    pub conflict: bool,
    pub saving: bool,
    last_saved: SystemTime,
    fingerprint: Option<Fingerprint>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: String,
    pub document_id: String,
    pub name: String,
    pub path: Option<String>,
    pub workspace: String,
    pub dirty: bool,
    pub conflict: bool,
    pub saving: bool,
    pub active_mode: String,
    pub attachment_count: usize,
    pub autosave_eligible: bool,
}
impl Session {
    fn state(&self) -> SessionState {
        SessionState {
            session_id: self.id.clone(),
            document_id: self.doc.metadata.document_id.clone(),
            name: self.doc.config.name.clone(),
            path: self.path.as_ref().map(|p| p.to_string_lossy().into()),
            workspace: self.workspace.to_string_lossy().into(),
            dirty: self.dirty,
            conflict: self.conflict,
            saving: self.saving,
            active_mode: self.doc.config.active_mode.clone(),
            attachment_count: self.doc.attachments.len(),
            autosave_eligible: self.path.is_some() && !self.conflict && !self.saving,
        }
    }
}

pub struct DocumentManager {
    sessions: Mutex<HashMap<String, Session>>,
    pub global: GlobalStorage,
    recovery_root: PathBuf,
}
impl DocumentManager {
    pub fn new(app_data: PathBuf, cache: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(&cache).map_err(|e| AppError::new("IO_ERROR", e))?;
        Ok(Self {
            sessions: Mutex::new(HashMap::new()),
            global: GlobalStorage::new(app_data.join("global.db"))
                .map_err(|e| AppError::new("IO_ERROR", e))?,
            recovery_root: cache.join("recovery"),
        })
    }
    pub fn new_session(&self, window: &str) -> Result<SessionState, AppError> {
        let doc = archive::create_document("Untitled")?;
        self.install(window, None, doc)
    }
    pub fn open(&self, window: &str, path: &Path) -> Result<SessionState, AppError> {
        let doc = archive::read_archive(path)?;
        self.global
            .add_recent(path)
            .map_err(|e| AppError::new("IO_ERROR", e))?;
        self.install(window, Some(path.to_owned()), doc)
    }
    pub fn reopen_recovery(
        &self,
        window: &str,
        session_id: &str,
    ) -> Result<SessionState, AppError> {
        let record = self
            .global
            .recoveries()
            .map_err(|e| AppError::new("IO_ERROR", e))?
            .into_iter()
            .find(|record| record.session_id == session_id)
            .ok_or_else(|| AppError::new("NOT_FOUND", "Recovery session not found"))?;
        let doc = archive::read_workspace(Path::new(&record.workspace), record.document_id)?;
        let reader = ReadRuntime::new(Path::new(&record.workspace), &sqlite_extension_path()?)
            .map_err(|e| AppError::new("EXTENSION_STARTUP", e))?;
        let path = record.document_path.map(PathBuf::from);
        let fingerprint = path
            .as_ref()
            .filter(|path| path.exists())
            .map(|path| fingerprint(path, &doc.metadata.document_id))
            .transpose()?;
        let session = Session {
            id: record.session_id,
            window: window.into(),
            path,
            workspace: PathBuf::from(record.workspace),
            doc,
            reader,
            dirty: true,
            conflict: false,
            saving: false,
            last_saved: SystemTime::now(),
            fingerprint,
        };
        let state = session.state();
        self.sessions.lock().unwrap().insert(window.into(), session);
        Ok(state)
    }
    fn install(
        &self,
        window: &str,
        path: Option<PathBuf>,
        doc: ArchiveDocument,
    ) -> Result<SessionState, AppError> {
        let id = Uuid::new_v4().to_string();
        let workspace = archive::extract(&doc, &self.recovery_root)?;
        let reader = ReadRuntime::new(&workspace, &sqlite_extension_path()?)
            .map_err(|e| AppError::new("EXTENSION_STARTUP", e))?;
        let fp = path
            .as_ref()
            .map(|p| fingerprint(p, &doc.metadata.document_id))
            .transpose()?;
        let r = RecoveryRecord {
            session_id: id.clone(),
            document_id: doc.metadata.document_id.clone(),
            workspace: workspace.to_string_lossy().into(),
            document_path: path.as_ref().map(|x| x.to_string_lossy().into()),
            updated_at: Utc::now().to_rfc3339(),
        };
        self.global
            .register_recovery(&r)
            .map_err(|e| AppError::new("IO_ERROR", e))?;
        let s = Session {
            id: id.clone(),
            window: window.into(),
            path,
            workspace,
            doc,
            reader,
            dirty: false,
            conflict: false,
            saving: false,
            last_saved: SystemTime::now(),
            fingerprint: fp,
        };
        let state = s.state();
        self.sessions.lock().unwrap().insert(window.into(), s);
        Ok(state)
    }
    pub fn state(&self, window: &str) -> Result<SessionState, AppError> {
        self.sessions
            .lock()
            .unwrap()
            .get(window)
            .map(Session::state)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))
    }
    pub fn config(&self, window: &str) -> Result<DocumentConfig, AppError> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?
            .doc
            .config
            .clone())
    }
    pub fn database_path(&self, window: &str) -> Result<PathBuf, AppError> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?
            .workspace
            .join("data.db"))
    }
    pub fn mark_data_dirty(&self, window: &str) -> Result<SessionState, AppError> {
        let mut all = self.sessions.lock().unwrap();
        let s = all
            .get_mut(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        s.reader
            .refresh()
            .map_err(|e| AppError::new("IO_ERROR", e))?;
        s.dirty = true;
        Ok(s.state())
    }
    pub fn database_objects(&self, window: &str) -> Result<Vec<data::DbObject>, AppError> {
        let all = self.sessions.lock().unwrap();
        all.get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?
            .reader
            .objects()
            .map_err(|e| AppError::new("IO_ERROR", e))
    }
    pub fn table_schema(&self, window: &str, table: &str) -> Result<data::TableSchema, AppError> {
        let all = self.sessions.lock().unwrap();
        let session = all
            .get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        data::schema(&session.workspace.join("data.db"), table)
            .map_err(|e| AppError::new("IO_ERROR", e))
    }
    pub fn table_page(
        &self,
        window: &str,
        table: &str,
        offset: u64,
        limit: u64,
        sorts: &[data::Sort],
        filters: &[data::Filter],
    ) -> Result<data::Page, AppError> {
        let all = self.sessions.lock().unwrap();
        all.get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?
            .reader
            .page(table, offset, limit, sorts, filters)
            .map_err(|e| AppError::new("IO_ERROR", e))
    }
    pub fn read_query(&self, window: &str, sql: &str) -> Result<data::QueryResult, AppError> {
        let all = self.sessions.lock().unwrap();
        all.get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?
            .reader
            .query(sql)
            .map_err(|e| AppError::new("READ_ONLY", e))
    }
    pub fn save_query(
        &self,
        window: &str,
        id: Option<String>,
        name: String,
        sql: String,
        filter_state: Option<serde_json::Value>,
    ) -> Result<DocumentConfig, AppError> {
        self.read_query(window, &sql)?;
        let mut config = self.config(window)?;
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let query = SavedQuery {
            id: id.clone(),
            name,
            sql,
            filter_state,
        };
        if let Some(saved) = config.saved_queries.iter_mut().find(|query| query.id == id) {
            *saved = query;
        } else {
            config.saved_queries.push(query);
        }
        self.update_config(window, config.clone())?;
        Ok(config)
    }
    pub fn update_config(&self, window: &str, c: DocumentConfig) -> Result<SessionState, AppError> {
        let mut all = self.sessions.lock().unwrap();
        let s = all
            .get_mut(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        s.doc.config = c;
        s.dirty = true;
        fs::write(
            s.workspace.join("document.json"),
            serde_json::to_vec_pretty(&s.doc.config).unwrap(),
        )
        .map_err(|e| AppError::new("IO_ERROR", e))?;
        Ok(s.state())
    }
    pub fn save(&self, window: &str, new_path: Option<PathBuf>) -> Result<SessionState, AppError> {
        let mut all = self.sessions.lock().unwrap();
        let s = all
            .get_mut(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        let path = new_path.or_else(|| s.path.clone()).ok_or_else(|| {
            AppError::new("SAVE_AS_REQUIRED", "Untitled documents need a location")
        })?;
        if s.path.as_ref() == Some(&path) && changed(&path, s.fingerprint.as_ref())? {
            s.conflict = true;
            return Err(AppError::new(
                "EXTERNAL_CONFLICT",
                "The file changed outside ixtable. Reload it or Save As.",
            ));
        }
        s.saving = true;
        // The extracted database is authoritative after a session is installed.  In
        // particular, never let the stale payload loaded from the archive overwrite
        // edits made by the data editor.
        s.doc.data =
            fs::read(s.workspace.join("data.db")).map_err(|e| AppError::new("IO_ERROR", e))?;
        let result = archive::write_archive(&path, &s.doc);
        s.saving = false;
        result?;
        s.path = Some(path.clone());
        s.fingerprint = Some(fingerprint(&path, &s.doc.metadata.document_id)?);
        s.dirty = false;
        s.conflict = false;
        s.last_saved = SystemTime::now();
        self.global
            .add_recent(&path)
            .map_err(|e| AppError::new("IO_ERROR", e))?;
        Ok(s.state())
    }
    pub fn reload(&self, window: &str) -> Result<SessionState, AppError> {
        let path = self
            .sessions
            .lock()
            .unwrap()
            .get(window)
            .and_then(|s| s.path.clone())
            .ok_or_else(|| AppError::new("MISSING_FILE", "No saved file"))?;
        self.open(window, &path)
    }
    pub fn autosave_due(&self, window: &str) -> Result<bool, AppError> {
        let all = self.sessions.lock().unwrap();
        let s = all
            .get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        Ok(s.dirty
            && s.path.is_some()
            && !s.conflict
            && !s.saving
            && s.last_saved.elapsed().unwrap_or_default() >= Duration::from_secs(30))
    }
    pub fn close(&self, window: &str, force: bool) -> Result<(), AppError> {
        let mut all = self.sessions.lock().unwrap();
        let s = all
            .get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        if !force && (s.dirty || s.conflict || s.saving) {
            return Err(AppError::new(
                "CLOSE_BLOCKED",
                "Save or resolve the document before closing",
            ));
        }
        let s = all.remove(window).unwrap();
        fs::remove_dir_all(&s.workspace).map_err(|e| AppError::new("IO_ERROR", e))?;
        self.global
            .remove_recovery(&s.id)
            .map_err(|e| AppError::new("IO_ERROR", e))?;
        Ok(())
    }
    pub fn import_attachment(
        &self,
        window: &str,
        path: &Path,
        media: &str,
    ) -> Result<SessionState, AppError> {
        let contents = fs::read(path).map_err(|e| AppError::new("ATTACHMENT_FAILURE", e))?;
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into();
        let mut all = self.sessions.lock().unwrap();
        let s = all
            .get_mut(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        archive::add_attachment(&mut s.doc, name, media.into(), contents);
        s.dirty = true;
        Ok(s.state())
    }
    pub fn export_attachment(&self, window: &str, id: &str, path: &Path) -> Result<(), AppError> {
        let all = self.sessions.lock().unwrap();
        let s = all
            .get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        let a = s
            .doc
            .attachments
            .iter()
            .find(|a| a.id == id)
            .ok_or_else(|| AppError::new("ATTACHMENT_FAILURE", "Attachment not found"))?;
        fs::write(path, &a.contents).map_err(|e| AppError::new("ATTACHMENT_FAILURE", e))
    }
    pub fn remove_attachment(&self, window: &str, id: &str) -> Result<SessionState, AppError> {
        let mut all = self.sessions.lock().unwrap();
        let s = all
            .get_mut(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?;
        s.doc.attachments.retain(|a| a.id != id);
        s.dirty = true;
        Ok(s.state())
    }
    pub fn attachments(&self, window: &str) -> Result<Vec<crate::archive::Attachment>, AppError> {
        let all = self.sessions.lock().unwrap();
        Ok(all
            .get(window)
            .ok_or_else(|| AppError::new("NO_DOCUMENT", "No document is open"))?
            .doc
            .attachments
            .clone())
    }
}
fn fingerprint(path: &Path, identity: &str) -> Result<Fingerprint, AppError> {
    let m = fs::metadata(path).map_err(|e| AppError::new("IO_ERROR", e))?;
    Ok(Fingerprint {
        modified: m.modified().ok(),
        size: m.len(),
        identity: identity.into(),
    })
}
fn changed(path: &Path, old: Option<&Fingerprint>) -> Result<bool, AppError> {
    let Some(old) = old else { return Ok(false) };
    let m = fs::metadata(path).map_err(|e| AppError::new("MISSING_FILE", e))?;
    if m.len() != old.size || m.modified().ok() != old.modified {
        return Ok(true);
    };
    match archive::read_archive(path) {
        Ok(d) => Ok(d.metadata.document_id != old.identity),
        Err(_) => Ok(true),
    }
}

fn sqlite_extension_path() -> Result<PathBuf, AppError> {
    if let Some(path) = std::env::var_os("IXTABLE_DUCKDB_SQLITE_EXTENSION").map(PathBuf::from) {
        return validate_extension(path);
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    const TARGET: &str = "macos-arm64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    const TARGET: &str = "macos-x64";
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    const TARGET: &str = "windows-x64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    const TARGET: &str = "linux-x64";
    let relative = PathBuf::from("resources")
        .join("duckdb")
        .join(TARGET)
        .join("sqlite_scanner.duckdb_extension");
    let mut candidates = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&relative)];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(&relative));
            candidates.push(parent.join("../Resources").join(&relative));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(validate_extension)
        .transpose()?
        .ok_or_else(|| {
            AppError::new(
                "EXTENSION_STARTUP",
                format!("Missing bundled DuckDB SQLite extension for {TARGET}"),
            )
        })
}
fn validate_extension(path: PathBuf) -> Result<PathBuf, AppError> {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(&path).map_err(|e| AppError::new("EXTENSION_STARTUP", e))?;
    if bytes.is_empty() {
        return Err(AppError::new(
            "EXTENSION_STARTUP",
            "DuckDB SQLite extension is empty",
        ));
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    const EXPECTED: &str = "a3548846bd643cb717265a0a11352af2e830a466ca068f4cae2552af658879f2";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    const EXPECTED: &str = "fb287ea61bff87ad91b700491d44d584fb6e0b5926a4bf186f9d052ff6e976f7";
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    const EXPECTED: &str = "488c99012a2bd842dcc1d525441a7bd5c0427bb83236cbc01497615be167ac18";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    const EXPECTED: &str = "693d2bf90779df23ca5ebe0688639b9adfc11c2d55ae3466b33e28be16afaa5e";
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != EXPECTED {
        return Err(AppError::new(
            "EXTENSION_STARTUP",
            format!("DuckDB SQLite extension checksum mismatch: {actual}"),
        ));
    }
    Ok(path)
}
