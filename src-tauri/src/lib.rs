pub mod archive;
pub mod data;
pub mod manager;
pub mod storage;

use archive::{Attachment, DocumentConfig};
use manager::{AppError, DocumentManager, SessionState};
use serde_json::Value;
use std::{path::PathBuf, sync::OnceLock};

static MANAGER: OnceLock<DocumentManager> = OnceLock::new();
fn manager() -> Result<&'static DocumentManager, AppError> {
    if let Some(m) = MANAGER.get() {
        return Ok(m);
    }
    let base = std::env::var_os("IXTABLE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("ixtable"));
    let _ = MANAGER.set(DocumentManager::new(base.join("data"), base.join("cache"))?);
    Ok(MANAGER.get().unwrap())
}

#[cfg_attr(feature = "test-bridge", tauri_test::setup)]
pub struct App;

#[tauri::command]
fn app_info() -> Value {
    serde_json::json!({"name":"ixtable","runtime":"tauri"})
}
#[tauri::command]
fn new_document(window_label: String) -> Result<SessionState, AppError> {
    manager()?.new_session(&window_label)
}
#[tauri::command]
fn open_document(window_label: String, path: String) -> Result<SessionState, AppError> {
    manager()?.open(&window_label, &PathBuf::from(path))
}
#[tauri::command]
fn document_state(window_label: String) -> Result<SessionState, AppError> {
    manager()?.state(&window_label)
}
#[tauri::command]
fn read_document_config(window_label: String) -> Result<DocumentConfig, AppError> {
    manager()?.config(&window_label)
}
#[tauri::command]
fn update_document_config(
    window_label: String,
    config: DocumentConfig,
) -> Result<SessionState, AppError> {
    manager()?.update_config(&window_label, config)
}
#[tauri::command]
fn save_document(window_label: String) -> Result<SessionState, AppError> {
    manager()?.save(&window_label, None)
}
#[tauri::command]
fn save_document_as(window_label: String, path: String) -> Result<SessionState, AppError> {
    manager()?.save(&window_label, Some(PathBuf::from(path)))
}
#[tauri::command]
fn reload_document(window_label: String) -> Result<SessionState, AppError> {
    manager()?.reload(&window_label)
}
#[tauri::command]
fn close_document(window_label: String, force: bool) -> Result<(), AppError> {
    manager()?.close(&window_label, force)
}
#[tauri::command]
fn import_attachment(
    window_label: String,
    path: String,
    media_type: String,
) -> Result<SessionState, AppError> {
    manager()?.import_attachment(&window_label, &PathBuf::from(path), &media_type)
}
#[tauri::command]
fn list_attachments(window_label: String) -> Result<Vec<Attachment>, AppError> {
    manager()?.attachments(&window_label)
}
#[tauri::command]
fn export_attachment(window_label: String, id: String, path: String) -> Result<(), AppError> {
    manager()?.export_attachment(&window_label, &id, &PathBuf::from(path))
}
#[tauri::command]
fn remove_attachment(window_label: String, id: String) -> Result<SessionState, AppError> {
    manager()?.remove_attachment(&window_label, &id)
}
#[tauri::command]
fn get_preference(key: String) -> Result<Option<Value>, AppError> {
    manager()?
        .global
        .preference(&key)
        .map_err(|e| AppError::new("IO_ERROR", e))
}
#[tauri::command]
fn set_preference(key: String, value: Value) -> Result<(), AppError> {
    manager()?
        .global
        .set_preference(&key, &value)
        .map_err(|e| AppError::new("IO_ERROR", e))
}
#[tauri::command]
fn list_recent_files() -> Result<Vec<storage::RecentFile>, AppError> {
    manager()?
        .global
        .recents()
        .map_err(|e| AppError::new("IO_ERROR", e))
}
#[tauri::command]
fn list_recovery_sessions() -> Result<Vec<storage::RecoveryRecord>, AppError> {
    manager()?
        .global
        .recoveries()
        .map_err(|e| AppError::new("IO_ERROR", e))
}
#[tauri::command]
fn discard_recovery(session_id: String) -> Result<(), AppError> {
    let m = manager()?;
    if let Some(r) = m
        .global
        .recoveries()
        .map_err(|e| AppError::new("IO_ERROR", e))?
        .into_iter()
        .find(|r| r.session_id == session_id)
    {
        let _ = std::fs::remove_dir_all(r.workspace);
    }
    m.global
        .remove_recovery(&session_id)
        .map_err(|e| AppError::new("IO_ERROR", e))
}
fn db(window: &str) -> Result<PathBuf, AppError> {
    manager()?.database_path(window)
}
fn data_err(e: String) -> AppError {
    let lower = e.to_ascii_lowercase();
    let code = if lower.contains("does not exist") || lower.contains("not found") {
        "NOT_FOUND"
    } else if lower.contains("expected one row") || lower.contains("identity") {
        "STALE_ROW"
    } else if lower.contains("constraint") || lower.contains("foreign key") {
        "CONSTRAINT_VIOLATION"
    } else if lower.contains("read-only") || lower.contains("readonly") {
        "READ_ONLY"
    } else if lower.contains("unknown column")
        || lower.contains("required")
        || lower.contains("allowed")
    {
        "VALIDATION_ERROR"
    } else if lower.contains("extension") {
        "EXTENSION_STARTUP"
    } else {
        "DATABASE_ERROR"
    };
    AppError::new(code, e)
}
#[tauri::command]
fn list_database_objects(window_label: String) -> Result<Vec<data::DbObject>, AppError> {
    manager()?.database_objects(&window_label)
}
#[tauri::command]
fn inspect_table(window_label: String, table: String) -> Result<data::TableSchema, AppError> {
    manager()?.table_schema(&window_label, &table)
}
#[tauri::command]
fn read_table_page(
    window_label: String,
    table: String,
    offset: u64,
    limit: u64,
    sorts: Vec<data::Sort>,
    filters: Vec<data::Filter>,
) -> Result<data::Page, AppError> {
    manager()?.table_page(&window_label, &table, offset, limit, &sorts, &filters)
}
#[tauri::command]
fn execute_read_query(window_label: String, sql: String) -> Result<data::QueryResult, AppError> {
    manager()?.read_query(&window_label, &sql)
}
#[tauri::command]
fn insert_row(
    window_label: String,
    table: String,
    values: Vec<data::NamedValue>,
) -> Result<Vec<data::DataValue>, AppError> {
    let r = data::insert(&db(&window_label)?, &table, &values).map_err(data_err)?;
    manager()?.mark_data_dirty(&window_label)?;
    Ok(r)
}
#[tauri::command]
fn update_row(
    window_label: String,
    table: String,
    values: Vec<data::NamedValue>,
    identity: Vec<data::DataValue>,
) -> Result<u64, AppError> {
    let r = data::update(&db(&window_label)?, &table, &values, &identity).map_err(data_err)?;
    manager()?.mark_data_dirty(&window_label)?;
    Ok(r)
}
#[tauri::command]
fn delete_row(
    window_label: String,
    table: String,
    identity: Vec<data::DataValue>,
) -> Result<u64, AppError> {
    let r = data::delete(&db(&window_label)?, &table, &identity).map_err(data_err)?;
    manager()?.mark_data_dirty(&window_label)?;
    Ok(r)
}
#[tauri::command]
fn create_database_table(
    window_label: String,
    spec: data::CreateTable,
) -> Result<SessionState, AppError> {
    data::create_table(&db(&window_label)?, &spec).map_err(data_err)?;
    manager()?.mark_data_dirty(&window_label)
}
#[tauri::command]
fn alter_database_table(
    window_label: String,
    table: String,
    operation: data::AlterTable,
) -> Result<SessionState, AppError> {
    data::alter_table(&db(&window_label)?, &table, &operation).map_err(data_err)?;
    manager()?.mark_data_dirty(&window_label)
}
#[tauri::command]
fn save_query(
    window_label: String,
    id: Option<String>,
    name: String,
    sql: String,
    filter_state: Option<Value>,
) -> Result<DocumentConfig, AppError> {
    manager()?.save_query(&window_label, id, name, sql, filter_state)
}
#[tauri::command]
fn delete_saved_query(window_label: String, id: String) -> Result<DocumentConfig, AppError> {
    let mut c = manager()?.config(&window_label)?;
    let before = c.saved_queries.len();
    c.saved_queries.retain(|x| x.id != id);
    if before == c.saved_queries.len() {
        return Err(AppError::new("NOT_FOUND", "Saved query not found"));
    }
    manager()?.update_config(&window_label, c.clone())?;
    Ok(c)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            new_document,
            open_document,
            document_state,
            read_document_config,
            update_document_config,
            save_document,
            save_document_as,
            reload_document,
            close_document,
            import_attachment,
            list_attachments,
            export_attachment,
            remove_attachment,
            get_preference,
            set_preference,
            list_recent_files,
            list_recovery_sessions,
            discard_recovery,
            list_database_objects,
            inspect_table,
            read_table_page,
            execute_read_query,
            insert_row,
            update_row,
            delete_row,
            create_database_table,
            alter_database_table,
            save_query,
            delete_saved_query
        ])
        .run(tauri::generate_context!())
        .expect("error while running ixtable")
}
