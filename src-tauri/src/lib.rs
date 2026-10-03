pub mod archive;
pub mod archive_io;
pub mod assets;
pub mod automation;
pub mod bundle;
pub mod bundle_export;
pub mod checkpoints;
pub mod dashboards;
pub mod data;
pub mod design;
pub mod installation;
pub mod installation_checks;
pub mod installation_commands;
pub mod jobs;
pub mod logging;
pub mod manager;
pub mod migrations;
pub mod postgres;
pub mod queries;
pub mod recordstore;
pub mod recovery;
pub mod reports;
pub mod roles;
pub mod storage;
pub mod templates;
pub mod validation;

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
fn read_document_config_yaml(window_label: String) -> Result<String, AppError> {
    manager()?.config_yaml(&window_label)
}
#[tauri::command]
fn apply_document_config_yaml(
    window_label: String,
    yaml: String,
) -> Result<SessionState, AppError> {
    manager()?.apply_config_yaml(&window_label, &yaml)
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
    manager()?.asset_list(&window_label)
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
    manager()?.recoverable_sessions()
}
#[tauri::command]
fn discard_recovery(session_id: String) -> Result<(), AppError> {
    manager()?.discard_recovery(&session_id)
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
    recordstore::insert_row(&window_label, &table, &values)
}
/// `expected` carries the values the user started from; entities with the
/// optimistic policy reject the update with CONFLICT when they changed.
#[tauri::command]
fn update_row(
    window_label: String,
    table: String,
    values: Vec<data::NamedValue>,
    identity: Vec<data::DataValue>,
    expected: Option<Vec<data::NamedValue>>,
) -> Result<u64, AppError> {
    recordstore::update_row(&window_label, &table, &values, &identity, expected)
}
#[tauri::command]
fn delete_row(
    window_label: String,
    table: String,
    identity: Vec<data::DataValue>,
    expected: Option<Vec<data::NamedValue>>,
) -> Result<u64, AppError> {
    recordstore::delete_row(&window_label, &table, &identity, expected)
}
#[tauri::command]
fn create_database_table(
    window_label: String,
    spec: data::CreateTable,
) -> Result<SessionState, AppError> {
    installation::ensure_studio(&window_label)?;
    recordstore::create_table(&window_label, &spec)
}
#[tauri::command]
fn alter_database_table(
    window_label: String,
    table: String,
    operation: data::AlterTable,
) -> Result<SessionState, AppError> {
    installation::ensure_studio(&window_label)?;
    recordstore::alter_table(&window_label, &table, &[operation])
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
            read_document_config_yaml,
            apply_document_config_yaml,
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
            delete_saved_query,
            // archive commands
            manager::autosave_document,
            recovery::recover_session,
            checkpoints::create_checkpoint,
            checkpoints::list_checkpoints,
            checkpoints::restore_checkpoint_as_copy,
            assets::import_asset,
            assets::list_orphan_assets,
            assets::cleanup_orphan_assets,
            assets::archive_size_report,
            // logging commands
            logging::read_logs,
            logging::write_log,
            validation::validate_document,
            // reports commands
            reports::write_report_pdf,
            reports::read_report_assets,
            // dashboards commands
            // automation commands
            automation::validate_automation,
            jobs::enqueue_job,
            jobs::claim_next_job,
            jobs::complete_job,
            jobs::fail_job,
            jobs::cancel_job,
            jobs::retry_job,
            jobs::list_jobs,
            jobs::job_attempts,
            // migrations commands
            migrations::commands::migration_status,
            migrations::commands::migration_history,
            migrations::commands::preview_migration,
            migrations::commands::dry_run_migrations,
            migrations::commands::apply_migrations,
            migrations::commands::rollback_migration,
            // recordstore commands
            recordstore::commands::store_capabilities,
            recordstore::commands::table_drop_impact,
            recordstore::commands::drop_database_table,
            recordstore::commands::preview_table_changes,
            recordstore::commands::apply_table_changes,
            recordstore::commands::create_index,
            recordstore::commands::drop_index,
            recordstore::commands::list_indexes,
            recordstore::commands::execute_write_batch,
            recordstore::commands::test_datasource_connection,
            recordstore::commands::set_datasource_password,
            recordstore::commands::clear_datasource_password,
            recordstore::commands::connect_datasource,
            // roles commands
            // design commands
            design::validate_design,
            // queries commands
            queries::execute_parameterized_query,
            queries::run_saved_query,
            queries::cancel_query,
            queries::check_query_sql,
            // templates commands
            templates::list_templates,
            templates::read_template_config,
            templates::create_from_template,
            // bundle commands
            bundle_export::export_runtime_bundle,
            bundle_export::bundle_signer_fingerprint,
            installation_commands::inspect_runtime_bundle,
            installation_commands::open_runtime_bundle,
            installation_commands::update_runtime_installation,
            installation_commands::runtime_installation_info,
            installation_commands::preview_installation_reset,
            installation_commands::reset_runtime_installation_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ixtable")
}
