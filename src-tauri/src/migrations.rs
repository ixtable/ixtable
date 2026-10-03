//! Declared schema migrations (PRD §9.2, §11). Stub owned by the RecordStore agent.
use crate::archive::{check_named_ids, DocumentConfig, Issue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    pub id: String,
    pub name: String,
}

pub fn validate(config: &DocumentConfig) -> Vec<Issue> {
    check_named_ids(
        "migration",
        config.migrations.iter().map(|m| (m.id.as_str(), m.name.as_str())),
    )
}
