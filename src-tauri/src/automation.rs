//! Declarative actions and record triggers (PRD §17). Stub owned by the Automation agent.
use crate::archive::{check_named_ids, DocumentConfig, Issue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionDef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub id: String,
    pub name: String,
}

pub fn validate(config: &DocumentConfig) -> Vec<Issue> {
    let mut issues = check_named_ids(
        "action",
        config.actions.iter().map(|a| (a.id.as_str(), a.name.as_str())),
    );
    issues.extend(check_named_ids(
        "trigger",
        config.triggers.iter().map(|t| (t.id.as_str(), t.name.as_str())),
    ));
    issues
}
