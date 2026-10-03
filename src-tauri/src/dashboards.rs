//! Dashboard definitions (PRD §16). Stub owned by the Dashboards agent.
use crate::archive::{check_named_ids, DocumentConfig, Issue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub id: String,
    pub name: String,
}

pub fn validate(config: &DocumentConfig) -> Vec<Issue> {
    check_named_ids(
        "dashboard",
        config.dashboards.iter().map(|d| (d.id.as_str(), d.name.as_str())),
    )
}
