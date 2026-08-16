use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

pub struct GlobalStorage { path: PathBuf }
#[derive(Debug, Clone, Serialize, Deserialize)] #[serde(rename_all="camelCase")] pub struct RecentFile { pub path:String, pub opened_at:String }
#[derive(Debug, Clone, Serialize, Deserialize)] #[serde(rename_all="camelCase")] pub struct RecoveryRecord { pub session_id:String, pub document_id:String, pub workspace:String, pub document_path:Option<String>, pub updated_at:String }

impl GlobalStorage {
 pub fn new(path:PathBuf)->Result<Self,rusqlite::Error>{ if let Some(p)=path.parent(){let _=fs::create_dir_all(p);} let db=Self{path}; db.connection()?; Ok(db) }
 fn connection(&self)->Result<Connection,rusqlite::Error>{let c=Connection::open(&self.path)?;c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS recent_files(path TEXT PRIMARY KEY,opened_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS window_state(label TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery_sessions(session_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,workspace TEXT NOT NULL,document_path TEXT,updated_at TEXT NOT NULL);")?;Ok(c)}
 pub fn set_preference(&self,key:&str,value:&serde_json::Value)->Result<(),rusqlite::Error>{self.connection()?.execute("INSERT INTO preferences VALUES(?1,?2,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=version+1",params![key,value.to_string()])?;Ok(())}
 pub fn preference(&self,key:&str)->Result<Option<serde_json::Value>,rusqlite::Error>{let c=self.connection()?;let mut s=c.prepare("SELECT value FROM preferences WHERE key=?1")?;let mut rows=s.query([key])?;Ok(rows.next()?.and_then(|r|r.get::<_,String>(0).ok()).and_then(|v|serde_json::from_str(&v).ok()))}
 pub fn add_recent(&self,path:&Path)->Result<(),rusqlite::Error>{self.connection()?.execute("INSERT INTO recent_files VALUES(?1,datetime('now')) ON CONFLICT(path) DO UPDATE SET opened_at=excluded.opened_at",[path.to_string_lossy().as_ref()])?;Ok(())}
 pub fn recents(&self)->Result<Vec<RecentFile>,rusqlite::Error>{let c=self.connection()?;let mut s=c.prepare("SELECT path,opened_at FROM recent_files ORDER BY opened_at DESC LIMIT 20")?;let rows=s.query_map([],|r|Ok(RecentFile{path:r.get(0)?,opened_at:r.get(1)?}))?.filter_map(Result::ok).collect();Ok(rows)}
 pub fn set_window_state(&self,label:&str,value:&serde_json::Value)->Result<(),rusqlite::Error>{self.connection()?.execute("INSERT INTO window_state VALUES(?1,?2) ON CONFLICT(label) DO UPDATE SET json=excluded.json",params![label,value.to_string()])?;Ok(())}
 pub fn register_recovery(&self,r:&RecoveryRecord)->Result<(),rusqlite::Error>{self.connection()?.execute("INSERT OR REPLACE INTO recovery_sessions VALUES(?1,?2,?3,?4,?5)",params![r.session_id,r.document_id,r.workspace,r.document_path,r.updated_at])?;Ok(())}
 pub fn recoveries(&self)->Result<Vec<RecoveryRecord>,rusqlite::Error>{let c=self.connection()?;let mut s=c.prepare("SELECT session_id,document_id,workspace,document_path,updated_at FROM recovery_sessions ORDER BY updated_at DESC")?;let rows=s.query_map([],|r|Ok(RecoveryRecord{session_id:r.get(0)?,document_id:r.get(1)?,workspace:r.get(2)?,document_path:r.get(3)?,updated_at:r.get(4)?}))?.filter_map(Result::ok).filter(|r|Path::new(&r.workspace).exists()).collect();Ok(rows)}
 pub fn remove_recovery(&self,id:&str)->Result<(),rusqlite::Error>{self.connection()?.execute("DELETE FROM recovery_sessions WHERE session_id=?1",[id])?;Ok(())}
}
