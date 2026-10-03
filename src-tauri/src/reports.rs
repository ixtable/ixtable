//! Report definitions (PRD §15). Stub owned by the Reports agent.
use crate::archive::{check_named_ids, DocumentConfig, Issue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub name: String,
}

pub fn validate(config: &DocumentConfig) -> Vec<Issue> {
    check_named_ids(
        "report",
        config.reports.iter().map(|r| (r.id.as_str(), r.name.as_str())),
    )
}
