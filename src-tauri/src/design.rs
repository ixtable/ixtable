use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const DESIGN_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesignSchema {
    pub version: u32,
    #[serde(default)]
    pub forms: Vec<Form>,
    #[serde(default)]
    pub navigation: Vec<NavigationItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub controls: Vec<Control>,
    #[serde(default)]
    pub layout: Layout,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub id: String,
    pub kind: ControlKind,
    pub label: String,
    #[serde(default)]
    pub binding: Option<Binding>,
    #[serde(default)]
    pub validation: Validation,
    #[serde(default)]
    pub width: ControlWidth,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub table: String,
    pub column: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub pattern: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub columns: u8,
    pub gap: u16,
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            columns: 1,
            gap: 16,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationItem {
    pub id: String,
    pub label: String,
    pub form_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    Text,
    Number,
    Select,
    Checkbox,
    Section,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ControlWidth {
    #[default]
    Full,
    Half,
}

impl Default for DesignSchema {
    fn default() -> Self {
        Self {
            version: DESIGN_SCHEMA_VERSION,
            forms: vec![Form {
                id: "main".into(),
                name: "Main form".into(),
                table: None,
                controls: vec![],
                layout: Layout::default(),
            }],
            navigation: vec![NavigationItem {
                id: "main".into(),
                label: "Main form".into(),
                form_id: "main".into(),
            }],
        }
    }
}
impl DesignSchema {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != DESIGN_SCHEMA_VERSION {
            return Err(format!(
                "unsupported design schema version {}",
                self.version
            ));
        }
        let mut forms = HashSet::new();
        for form in &self.forms {
            if form.id.is_empty() || !forms.insert(&form.id) {
                return Err("design form ids must be non-empty and unique".into());
            }
            if !(1..=4).contains(&form.layout.columns) {
                return Err("design layout columns must be between 1 and 4".into());
            }
            let mut controls = HashSet::new();
            for control in &form.controls {
                if control.id.is_empty() || !controls.insert(&control.id) {
                    return Err("control ids must be non-empty and unique within a form".into());
                }
                if let Some(binding) = &control.binding {
                    if binding.table.is_empty() || binding.column.is_empty() {
                        return Err("design bindings require a table and column".into());
                    }
                }
                if control
                    .validation
                    .min
                    .zip(control.validation.max)
                    .is_some_and(|(min, max)| min > max)
                {
                    return Err("validation minimum cannot exceed maximum".into());
                }
            }
        }
        if self
            .navigation
            .iter()
            .any(|item| !forms.contains(&item.form_id))
        {
            return Err("navigation references an unknown form".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_schema_is_valid_and_versioned() {
        let design = DesignSchema::default();
        assert_eq!(design.version, DESIGN_SCHEMA_VERSION);
        assert!(design.validate().is_ok());
    }

    #[test]
    fn future_schema_version_is_rejected() {
        let mut design = DesignSchema::default();
        design.version += 1;
        assert_eq!(
            design.validate().unwrap_err(),
            "unsupported design schema version 2"
        );
    }
}
