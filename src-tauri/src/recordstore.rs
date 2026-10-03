//! RecordStore selection and per-entity settings (PRD §9, §19). Stub owned by the RecordStore agent.
use crate::archive::{check_named_ids, DocumentConfig, Issue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DatasourceConfig {
    #[serde(default = "default_kind")]
    pub kind: String,
}
fn default_kind() -> String {
    "sqlite".into()
}
impl Default for DatasourceConfig {
    fn default() -> Self {
        Self {
            kind: default_kind(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntitySettings {
    pub id: String,
    pub table: String,
}

pub fn validate(config: &DocumentConfig) -> Vec<Issue> {
    let mut issues = check_named_ids(
        "entity",
        config.entities.iter().map(|e| (e.id.as_str(), e.table.as_str())),
    );
    if !matches!(config.datasource.kind.as_str(), "sqlite" | "postgres") {
        issues.push(Issue::error(
            "datasource",
            "datasource",
            format!("unknown datasource kind {}", config.datasource.kind),
        ));
    }
    issues
}
