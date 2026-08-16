pub mod archive;
pub mod manager;
pub mod storage;

use archive::{Attachment, DocumentConfig};
use manager::{AppError, DocumentManager, SessionState};
use serde_json::Value;
use std::{path::PathBuf, sync::OnceLock};

static MANAGER: OnceLock<DocumentManager> = OnceLock::new();
fn manager() -> Result<&'static DocumentManager, AppError> {
    if let Some(m)=MANAGER.get(){return Ok(m)}
    let base=std::env::var_os("IXTABLE_STATE_DIR").map(PathBuf::from).unwrap_or_else(||std::env::temp_dir().join("ixtable"));
    let _=MANAGER.set(DocumentManager::new(base.join("data"),base.join("cache"))?); Ok(MANAGER.get().unwrap())
}

#[tauri_test::setup]
pub struct App;

#[tauri::command] fn app_info()->Value{serde_json::json!({"name":"ixtable","runtime":"tauri"})}
#[tauri::command] fn new_document(window_label:String)->Result<SessionState,AppError>{manager()?.new_session(&window_label)}
#[tauri::command] fn open_document(window_label:String,path:String)->Result<SessionState,AppError>{manager()?.open(&window_label,&PathBuf::from(path))}
#[tauri::command] fn document_state(window_label:String)->Result<SessionState,AppError>{manager()?.state(&window_label)}
#[tauri::command] fn read_document_config(window_label:String)->Result<DocumentConfig,AppError>{manager()?.config(&window_label)}
#[tauri::command] fn update_document_config(window_label:String,config:DocumentConfig)->Result<SessionState,AppError>{manager()?.update_config(&window_label,config)}
#[tauri::command] fn save_document(window_label:String)->Result<SessionState,AppError>{manager()?.save(&window_label,None)}
#[tauri::command] fn save_document_as(window_label:String,path:String)->Result<SessionState,AppError>{manager()?.save(&window_label,Some(PathBuf::from(path)))}
#[tauri::command] fn reload_document(window_label:String)->Result<SessionState,AppError>{manager()?.reload(&window_label)}
#[tauri::command] fn close_document(window_label:String,force:bool)->Result<(),AppError>{manager()?.close(&window_label,force)}
#[tauri::command] fn import_attachment(window_label:String,path:String,media_type:String)->Result<SessionState,AppError>{manager()?.import_attachment(&window_label,&PathBuf::from(path),&media_type)}
#[tauri::command] fn list_attachments(window_label:String)->Result<Vec<Attachment>,AppError>{manager()?.attachments(&window_label)}
#[tauri::command] fn export_attachment(window_label:String,id:String,path:String)->Result<(),AppError>{manager()?.export_attachment(&window_label,&id,&PathBuf::from(path))}
#[tauri::command] fn remove_attachment(window_label:String,id:String)->Result<SessionState,AppError>{manager()?.remove_attachment(&window_label,&id)}
#[tauri::command] fn get_preference(key:String)->Result<Option<Value>,AppError>{manager()?.global.preference(&key).map_err(|e|AppError::new("IO_ERROR",e))}
#[tauri::command] fn set_preference(key:String,value:Value)->Result<(),AppError>{manager()?.global.set_preference(&key,&value).map_err(|e|AppError::new("IO_ERROR",e))}
#[tauri::command] fn list_recent_files()->Result<Vec<storage::RecentFile>,AppError>{manager()?.global.recents().map_err(|e|AppError::new("IO_ERROR",e))}
#[tauri::command] fn list_recovery_sessions()->Result<Vec<storage::RecoveryRecord>,AppError>{manager()?.global.recoveries().map_err(|e|AppError::new("IO_ERROR",e))}
#[tauri::command] fn discard_recovery(session_id:String)->Result<(),AppError>{let m=manager()?;if let Some(r)=m.global.recoveries().map_err(|e|AppError::new("IO_ERROR",e))?.into_iter().find(|r|r.session_id==session_id){let _=std::fs::remove_dir_all(r.workspace);}m.global.remove_recovery(&session_id).map_err(|e|AppError::new("IO_ERROR",e))}

#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){tauri::Builder::default().invoke_handler(tauri::generate_handler![app_info,new_document,open_document,document_state,read_document_config,update_document_config,save_document,save_document_as,reload_document,close_document,import_attachment,list_attachments,export_attachment,remove_attachment,get_preference,set_preference,list_recent_files,list_recovery_sessions,discard_recovery]).run(tauri::generate_context!()).expect("error while running ixtable")}
