//! Grid layout of a form (PRD §13): tracks, gaps, regions, breakpoints and placements.
use serde::{Deserialize, Serialize};

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
