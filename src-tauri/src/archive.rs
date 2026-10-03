//! SQLite database used as an application archive (see https://sqlite.org/sqlar.html).
//!
//! The on-disk `.ixt` file is a SQLite database with versioned tables for metadata,
//! compressed record-store bytes, JSON document config, and application-asset
//! attachments. Working sessions extract `data.db`, `document.json`, and
//! `config.yaml`. The `.ixt` file is the source of truth after a successful save.
use crate::design::DesignSchema;
use crate::{automation, dashboards, migrations, recordstore, reports, roles};
pub use crate::validation::{check_named_ids, validate_config, Issue, Severity};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const FORMAT_VERSION: i64 = 1;
/// Current `DocumentConfig.version`. Version 2 configs load through serde defaults.
pub const CONFIG_VERSION: u32 = 3;

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid archive: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("Invalid archive: {0}")]
    Invalid(String),
    #[error("Unsupported archive version {0}")]
    Unsupported(i64),
    #[error("Corrupt payload: {0}")]
    Corrupt(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentConfig {
    pub version: u32,
    pub name: String,
    pub active_mode: String,
    #[serde(default)]
    pub navigation_state: serde_json::Value,
    #[serde(default)]
    pub settings: serde_json::Value,
    #[serde(default)]
    pub saved_queries: Vec<SavedQuery>,
    #[serde(default)]
    pub design: DesignSchema,
    #[serde(default)]
    pub reports: Vec<reports::Report>,
    #[serde(default)]
    pub dashboards: Vec<dashboards::Dashboard>,
    #[serde(default)]
    pub actions: Vec<automation::ActionDef>,
    #[serde(default)]
    pub triggers: Vec<automation::Trigger>,
    #[serde(default)]
    pub migrations: Vec<migrations::Migration>,
    #[serde(default)]
    pub datasource: recordstore::DatasourceConfig,
    #[serde(default)]
    pub entities: Vec<recordstore::EntitySettings>,
    #[serde(default)]
    pub roles: Vec<roles::Role>,
    #[serde(default)]
    pub release: ReleaseInfo,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub filter_state: Option<serde_json::Value>,
    #[serde(default)]
    pub parameters: Vec<QueryParameter>,
    #[serde(default)]
    pub builder: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryParameter {
    pub name: String,
    pub logical_type: String,
    #[serde(default)]
    pub default_value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub min_runtime_version: Option<String>,
}

impl DocumentConfig {
    /// Brings an older config up to `CONFIG_VERSION`; newer versions are rejected.
    pub fn upgrade(mut self) -> Result<Self, ArchiveError> {
        if self.version > CONFIG_VERSION {
            return Err(ArchiveError::Invalid(format!(
                "unsupported config version {}",
                self.version
            )));
        }
        self.version = CONFIG_VERSION;
        Ok(self)
    }
}

impl Default for DocumentConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            name: "Untitled".into(),
            active_mode: "data".into(),
            navigation_state: serde_json::json!({}),
            settings: serde_json::json!({}),
            saved_queries: vec![],
            design: DesignSchema::default(),
            reports: vec![],
            dashboards: vec![],
            actions: vec![],
            triggers: vec![],
            migrations: vec![],
            datasource: recordstore::DatasourceConfig::default(),
            entities: vec![],
            roles: vec![],
            release: ReleaseInfo::default(),
        }
    }
}

pub fn document_config_yaml(config: &DocumentConfig) -> Result<String, ArchiveError> {
    serde_yaml::to_string(config).map_err(|e| ArchiveError::Invalid(e.to_string()))
}

pub fn document_config_from_yaml(yaml: &str) -> Result<DocumentConfig, ArchiveError> {
    let config = serde_yaml::from_str::<DocumentConfig>(yaml)
        .map_err(|e| ArchiveError::Invalid(e.to_string()))?
        .upgrade()?;
    config.design.validate().map_err(ArchiveError::Invalid)?;
    Ok(config)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub display_name: String,
    pub media_type: String,
    pub checksum: String,
    pub size: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip)]
    pub contents: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMetadata {
    pub document_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub application_version: String,
}

#[derive(Debug)]
pub struct ArchiveDocument {
    pub metadata: ArchiveMetadata,
    pub data: Vec<u8>,
    pub config: DocumentConfig,
    pub attachments: Vec<Attachment>,
}

fn checksum(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn compress(data: &[u8]) -> Result<Vec<u8>, ArchiveError> {
    Ok(zstd::stream::encode_all(data, 3)?)
}
fn decompress(data: &[u8]) -> Result<Vec<u8>, ArchiveError> {
    zstd::stream::decode_all(data).map_err(|e| ArchiveError::Corrupt(e.to_string()))
}

pub fn empty_data_db() -> Result<Vec<u8>, ArchiveError> {
    let path = std::env::temp_dir().join(format!("ixtable-empty-{}.db", Uuid::new_v4()));
    Connection::open(&path)?.execute_batch("PRAGMA user_version=1;")?;
    let bytes = fs::read(&path)?;
    let _ = fs::remove_file(path);
    Ok(bytes)
}

pub fn create_document(name: impl Into<String>) -> Result<ArchiveDocument, ArchiveError> {
    let now = Utc::now().to_rfc3339();
    Ok(ArchiveDocument {
        metadata: ArchiveMetadata {
            document_id: Uuid::new_v4().to_string(),
            created_at: now.clone(),
            updated_at: now,
            application_version: env!("CARGO_PKG_VERSION").into(),
        },
        data: empty_data_db()?,
        config: DocumentConfig {
            name: name.into(),
            ..Default::default()
        },
        attachments: vec![],
    })
}

fn schema(conn: &Connection) -> Result<(), ArchiveError> {
    conn.execute_batch(
    "PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
     CREATE TABLE archive_metadata(format_version INTEGER NOT NULL, document_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, application_version TEXT NOT NULL);
     CREATE TABLE data_payload(id INTEGER PRIMARY KEY CHECK(id=1), compression TEXT NOT NULL, checksum TEXT NOT NULL, uncompressed_size INTEGER NOT NULL, contents BLOB NOT NULL);
     CREATE TABLE document_config(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, json TEXT NOT NULL);
     CREATE TABLE attachments(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, media_type TEXT NOT NULL, checksum TEXT NOT NULL, uncompressed_size INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, compression TEXT NOT NULL, contents BLOB NOT NULL);"
)?;
    Ok(())
}

pub fn write_archive(path: &Path, doc: &ArchiveDocument) -> Result<(), ArchiveError> {
    doc.config
        .design
        .validate()
        .map_err(ArchiveError::Invalid)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut conn = Connection::open(&tmp)?;
        schema(&conn)?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO archive_metadata VALUES(?1,?2,?3,?4,?5)",
            params![
                FORMAT_VERSION,
                doc.metadata.document_id,
                doc.metadata.created_at,
                Utc::now().to_rfc3339(),
                doc.metadata.application_version
            ],
        )?;
        let packed = compress(&doc.data)?;
        tx.execute(
            "INSERT INTO data_payload VALUES(1,'zstd',?1,?2,?3)",
            params![checksum(&doc.data), doc.data.len() as i64, packed],
        )?;
        tx.execute(
            "INSERT INTO document_config VALUES(1,?1,?2)",
            params![
                doc.config.version,
                serde_json::to_string(&doc.config)
                    .map_err(|e| ArchiveError::Invalid(e.to_string()))?
            ],
        )?;
        for a in &doc.attachments {
            tx.execute(
                "INSERT INTO attachments VALUES(?1,?2,?3,?4,?5,?6,?7,'zstd',?8)",
                params![
                    a.id,
                    a.display_name,
                    a.media_type,
                    checksum(&a.contents),
                    a.contents.len() as i64,
                    a.created_at,
                    a.updated_at,
                    compress(&a.contents)?
                ],
            )?;
        }
        tx.commit()?;
        conn.execute_batch("PRAGMA optimize;")?;
        drop(conn);
        let file = fs::OpenOptions::new().read(true).write(true).open(&tmp)?;
        file.sync_all()?;
        // Validate the complete temporary archive before replacing a valid destination.
        read_archive(&tmp)?;
        fs::rename(&tmp, path)?;
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn read_archive(path: &Path) -> Result<ArchiveDocument, ArchiveError> {
    if !path.exists() {
        return Err(ArchiveError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "document not found",
        )));
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let (version, metadata) = conn.query_row("SELECT format_version,document_id,created_at,updated_at,application_version FROM archive_metadata LIMIT 1", [], |r| Ok((r.get::<_,i64>(0)?, ArchiveMetadata { document_id:r.get(1)?,created_at:r.get(2)?,updated_at:r.get(3)?,application_version:r.get(4)? })))?;
    if version != FORMAT_VERSION {
        return Err(ArchiveError::Unsupported(version));
    }
    let (expected, size, packed): (String, i64, Vec<u8>) = conn.query_row(
        "SELECT checksum,uncompressed_size,contents FROM data_payload WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let data = decompress(&packed)?;
    if data.len() as i64 != size || checksum(&data) != expected {
        return Err(ArchiveError::Corrupt(
            "data.db checksum or size mismatch".into(),
        ));
    }
    let json: String = conn.query_row("SELECT json FROM document_config WHERE id=1", [], |r| {
        r.get(0)
    })?;
    let config = serde_json::from_str::<DocumentConfig>(&json)
        .map_err(|e| ArchiveError::Invalid(e.to_string()))?
        .upgrade()?;
    config.design.validate().map_err(ArchiveError::Invalid)?;
    let mut stmt=conn.prepare("SELECT id,display_name,media_type,checksum,uncompressed_size,created_at,updated_at,contents FROM attachments ORDER BY created_at,id")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Vec<u8>>(7)?,
        ))
    })?;
    let mut attachments = vec![];
    for row in rows {
        let (id, display_name, media_type, expected, size, created_at, updated_at, packed) = row?;
        let contents = decompress(&packed)?;
        if contents.len() as i64 != size || checksum(&contents) != expected {
            return Err(ArchiveError::Corrupt(format!(
                "attachment {id} checksum or size mismatch"
            )));
        }
        attachments.push(Attachment {
            id,
            display_name,
            media_type,
            checksum: expected,
            size: size as u64,
            created_at,
            updated_at,
            contents,
        });
    }
    Ok(ArchiveDocument {
        metadata,
        data,
        config,
        attachments,
    })
}

pub fn extract(doc: &ArchiveDocument, root: &Path) -> Result<PathBuf, ArchiveError> {
    let work = root.join(&doc.metadata.document_id);
    fs::create_dir_all(&work)?;
    fs::write(work.join("data.db"), &doc.data)?;
    fs::write(
        work.join("document.json"),
        serde_json::to_vec_pretty(&doc.config).unwrap(),
    )?;
    fs::write(work.join("config.yaml"), document_config_yaml(&doc.config)?)?;
    for a in &doc.attachments {
        let dir = work.join("attachments").join(&a.id);
        fs::create_dir_all(&dir)?;
        fs::write(dir.join("content"), &a.contents)?;
        fs::write(
            dir.join("metadata.json"),
            serde_json::to_vec_pretty(a).unwrap(),
        )?;
    }
    Ok(work)
}

pub fn add_attachment(
    doc: &mut ArchiveDocument,
    display_name: String,
    media_type: String,
    contents: Vec<u8>,
) -> String {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    doc.attachments.push(Attachment {
        id: id.clone(),
        display_name,
        media_type,
        checksum: checksum(&contents),
        size: contents.len() as u64,
        created_at: now.clone(),
        updated_at: now,
        contents,
    });
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::{Control, ControlKind, Placement, Validation};

    #[test]
    fn design_survives_archive_round_trip() {
        let path = std::env::temp_dir().join(format!("design-round-trip-{}.ixt", Uuid::new_v4()));
        let mut document = create_document("Designed").unwrap();
        document.config.design.forms[0].controls.push(Control {
            id: "name".into(),
            kind: ControlKind::Text,
            label: "Name".into(),
            binding: None,
            validation: Validation {
                required: true,
                ..Default::default()
            },
            placement: Placement {
                column: 1,
                row: 1,
                column_span: 12,
                row_span: 1,
                region: None,
            },
        });
        write_archive(&path, &document).unwrap();
        let reopened = read_archive(&path).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(reopened.config.design, document.config.design);
    }

    #[test]
    fn legacy_config_without_design_gets_current_default() {
        let config: DocumentConfig = serde_json::from_value(serde_json::json!({
            "version": 2, "name": "Legacy", "activeMode": "data"
        }))
        .unwrap();
        assert_eq!(config.design.version, crate::design::DESIGN_SCHEMA_VERSION);
        assert!(config.design.validate().is_ok());
    }

    #[test]
    fn version_two_config_loads_as_version_three() {
        let legacy = serde_json::json!({
            "version": 2, "name": "Legacy", "activeMode": "data",
            "savedQueries": [{"id": "q1", "name": "All", "sql": "SELECT 1"}]
        });
        let config = serde_json::from_value::<DocumentConfig>(legacy)
            .unwrap()
            .upgrade()
            .unwrap();
        assert_eq!(config.version, CONFIG_VERSION);
        assert!(config.reports.is_empty() && config.roles.is_empty());
        assert_eq!(config.datasource.kind, "sqlite");
        assert!(config.saved_queries[0].parameters.is_empty());
        let yaml = document_config_from_yaml("name: Old\nactiveMode: data\nversion: 2\n").unwrap();
        assert_eq!(yaml.version, CONFIG_VERSION);
        assert!(document_config_from_yaml("name: New\nactiveMode: data\nversion: 99\n").is_err());
    }

    #[test]
    fn yaml_round_trips_feature_fields() {
        let mut config = DocumentConfig::default();
        config.saved_queries.push(SavedQuery {
            id: "q1".into(),
            name: "By customer".into(),
            sql: "SELECT 1".into(),
            parameters: vec![QueryParameter {
                name: "customer".into(),
                logical_type: "text".into(),
                default_value: Some(serde_json::json!("CUST-001")),
            }],
            builder: Some(serde_json::json!({"source": "Customers"})),
            ..Default::default()
        });
        config.reports.push(crate::reports::Report {
            id: "r1".into(),
            name: "Sales".into(),
        });
        config.dashboards.push(crate::dashboards::Dashboard {
            id: "d1".into(),
            name: "Overview".into(),
        });
        config.actions.push(crate::automation::ActionDef {
            id: "a1".into(),
            name: "Approve".into(),
        });
        config.triggers.push(crate::automation::Trigger {
            id: "t1".into(),
            name: "On create".into(),
        });
        config.migrations.push(crate::migrations::Migration {
            id: "m1".into(),
            name: "Add index".into(),
        });
        config.entities.push(crate::recordstore::EntitySettings {
            id: "e1".into(),
            table: "Orders".into(),
        });
        config.roles.push(crate::roles::Role {
            id: "role1".into(),
            name: "Clerk".into(),
        });
        config.release.version = "1.2.0".into();
        config.release.min_runtime_version = Some("1.0.0".into());
        let yaml = document_config_yaml(&config).unwrap();
        assert!(yaml.contains("minRuntimeVersion"));
        assert_eq!(document_config_from_yaml(&yaml).unwrap(), config);
        assert!(validate_config(&config).is_empty());
    }

    #[test]
    fn validate_config_reports_duplicate_ids_and_design_errors() {
        let mut config = DocumentConfig::default();
        for name in ["One", ""] {
            config.reports.push(crate::reports::Report {
                id: "same".into(),
                name: name.into(),
            });
        }
        config.design.version += 1;
        let issues = validate_config(&config);
        assert!(issues.iter().any(|i| i.object_kind == "design" && i.severity == Severity::Error));
        assert!(issues
            .iter()
            .any(|i| i.object_kind == "report" && i.message.contains("duplicate")));
        assert!(issues
            .iter()
            .any(|i| i.object_kind == "report" && i.severity == Severity::Warning));
        let json = serde_json::to_value(&issues[0]).unwrap();
        assert_eq!(json["severity"], "error");
        assert!(json.get("objectKind").is_some());
    }

    #[test]
    fn yaml_round_trips_document_config() {
        let config = DocumentConfig::default();
        let yaml = document_config_yaml(&config).unwrap();
        let parsed = document_config_from_yaml(&yaml).unwrap();
        assert_eq!(parsed, config);
        let loaded = document_config_from_yaml("name: From YAML\nactiveMode: data\nversion: 2\n")
            .unwrap();
        assert_eq!(loaded.name, "From YAML");
        assert!(loaded.design.validate().is_ok());
    }
}
