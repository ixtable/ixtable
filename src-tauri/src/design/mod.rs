//! Form design schema (PRD §13, §14): forms, controls, grid layout, and navigation.
//! Expressions are stored as source text; only the TypeScript side parses them.
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod checks;
mod upgrade;
pub use checks::{table_issues, validate, validate_tables};
/// Grid rules shared with dashboards (PRD §13: one grid system for forms and dashboards).
pub(crate) use checks::{
    validate_layout as validate_grid_layout, validate_span as validate_grid_span,
};

pub const DESIGN_SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", try_from = "Value")]
pub struct DesignSchema {
    pub version: u32,
    pub forms: Vec<Form>,
    pub navigation: Vec<NavigationItem>,
    pub start_page: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentDesign {
    version: u32,
    #[serde(default)]
    forms: Vec<Form>,
    #[serde(default)]
    navigation: Vec<NavigationItem>,
    #[serde(default)]
    start_page: Option<String>,
}

impl TryFrom<Value> for DesignSchema {
    type Error = String;
    fn try_from(value: Value) -> Result<Self, String> {
        let current: CurrentDesign =
            serde_json::from_value(upgrade::upgrade_value(value)).map_err(|e| e.to_string())?;
        Ok(Self {
            version: current.version,
            forms: current.forms,
            navigation: current.navigation,
            start_page: current.start_page,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FormMode {
    #[default]
    List,
    Detail,
    Create,
    Edit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    #[default]
    Table,
    Query,
}

/// Where a form reads its records: a table (editable) or a saved query (read-only).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormSource {
    pub kind: SourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
}

/// A form-level validation rule: `expression` must be true for the record to save.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormRule {
    pub id: String,
    pub expression: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub source: Option<FormSource>,
    #[serde(default = "default_modes")]
    pub modes: Vec<FormMode>,
    #[serde(default)]
    pub controls: Vec<Control>,
    #[serde(default)]
    pub layout: GridLayout,
    /// Columns shown in list mode; empty shows every bound control.
    #[serde(default)]
    pub list_columns: Vec<String>,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    /// Form opened when a list row is clicked; none opens this form in detail mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_form_id: Option<String>,
    #[serde(default)]
    pub rules: Vec<FormRule>,
}
pub fn default_modes() -> Vec<FormMode> {
    vec![
        FormMode::List,
        FormMode::Detail,
        FormMode::Create,
        FormMode::Edit,
    ]
}
fn default_page_size() -> u32 {
    25
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    Label,
    #[default]
    Text,
    Multiline,
    Number,
    Decimal,
    #[serde(alias = "checkbox")]
    Boolean,
    Date,
    Time,
    Datetime,
    Select,
    Relationship,
    Computed,
    Button,
    Section,
    Tabs,
    RelatedList,
    Image,
}
impl ControlKind {
    pub fn is_container(self) -> bool {
        matches!(self, Self::Section | Self::Tabs)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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
    pub placement: Placement,
    /// Container (section or tabs control, plus tab page id) this control sits in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<ControlParent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_when: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_when: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    /// Static text for label controls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SelectOption>,
    /// Saved query whose first column is the value and second (optional) the label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_query_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relationship: Option<Relationship>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tabs: Vec<TabPage>,
    /// Inner grid of a section or tabs container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<GridLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub related: Option<RelatedList>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
    /// Presentation variant, e.g. "toggle" for booleans.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlParent {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    pub value: String,
    #[serde(default)]
    pub label: String,
}
/// Foreign-key lookup: stores `value_column` of `table`, shows `display_column`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub table: String,
    pub value_column: String,
    pub display_column: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabPage {
    pub id: String,
    pub label: String,
}
/// Child rows of `table` whose `foreign_key` equals the parent record's `parent_column`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelatedList {
    pub table: String,
    pub foreign_key: String,
    pub parent_column: String,
    #[serde(default)]
    pub columns: Vec<String>,
    /// Form used to add and edit child rows (embedded; it may not hold related lists).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// Legacy (v2) field; v3 binds to the form source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    #[serde(default = "default_columns")]
    pub columns: Vec<GridTrack>,
    #[serde(default)]
    pub rows: Vec<GridTrack>,
    #[serde(default = "default_gap")]
    pub column_gap: u16,
    #[serde(default = "default_gap")]
    pub row_gap: u16,
    #[serde(default)]
    pub padding: u16,
    #[serde(default)]
    pub justify_items: GridAlign,
    #[serde(default)]
    pub align_items: GridAlign,
    #[serde(default)]
    pub named_regions: Vec<NamedRegion>,
    #[serde(default)]
    pub breakpoints: Vec<Breakpoint>,
}
fn default_columns() -> Vec<GridTrack> {
    vec![GridTrack::fr(1.0); 12]
}
fn default_gap() -> u16 {
    16
}
impl Default for GridLayout {
    fn default() -> Self {
        Self {
            columns: default_columns(),
            rows: vec![],
            column_gap: default_gap(),
            row_gap: default_gap(),
            padding: 0,
            justify_items: GridAlign::Stretch,
            align_items: GridAlign::Stretch,
            named_regions: vec![],
            breakpoints: vec![],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridTrack {
    pub kind: TrackKind,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}
impl GridTrack {
    pub fn fr(value: f64) -> Self {
        Self {
            kind: TrackKind::Fr,
            value: Some(value),
            min: None,
            max: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Fixed,
    Content,
    Fr,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum GridAlign {
    #[default]
    Stretch,
    Start,
    Center,
    End,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NamedRegion {
    pub name: String,
    pub column: u16,
    pub row: u16,
    pub column_span: u16,
    pub row_span: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    pub min_width: u32,
    pub columns: Vec<GridTrack>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    #[serde(default = "one")]
    pub column: u16,
    #[serde(default = "one")]
    pub row: u16,
    #[serde(default = "one")]
    pub column_span: u16,
    #[serde(default = "one")]
    pub row_span: u16,
    #[serde(default)]
    pub region: Option<String>,
}
fn one() -> u16 {
    1
}
impl Default for Placement {
    fn default() -> Self {
        Self {
            column: 1,
            row: 1,
            column_span: 1,
            row_span: 1,
            region: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NavKind {
    #[default]
    Form,
    Report,
    Dashboard,
    Table,
    Group,
}

/// Navigation entry; `group` items nest other items (nested navigation, not subforms).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub kind: NavKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<FormMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<NavigationItem>,
}

impl Default for DesignSchema {
    fn default() -> Self {
        Self {
            version: DESIGN_SCHEMA_VERSION,
            forms: vec![Form {
                id: "main".into(),
                name: "Main form".into(),
                modes: default_modes(),
                page_size: default_page_size(),
                ..Default::default()
            }],
            navigation: vec![NavigationItem {
                id: "main".into(),
                label: "Main form".into(),
                kind: NavKind::Form,
                target_id: Some("main".into()),
                ..Default::default()
            }],
            start_page: Some("main".into()),
        }
    }
}

/// Design issues including table and column references checked against the live schema.
#[tauri::command]
pub fn validate_design(
    window_label: String,
) -> Result<Vec<crate::archive::Issue>, crate::manager::AppError> {
    checks::validate_document_design(&window_label)
}

impl DesignSchema {
    /// Structural checks that make a design unloadable; dependency problems are [`validate`] issues.
    pub fn validate(&self) -> Result<(), String> {
        checks::structural(self)
    }
}

#[cfg(test)]
mod tests;
