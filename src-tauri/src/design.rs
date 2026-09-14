use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const DESIGN_SCHEMA_VERSION: u32 = 2;

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
    pub layout: GridLayout,
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
    pub placement: Placement,
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
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Fixed,
    Content,
    Fr,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
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

impl Default for DesignSchema {
    fn default() -> Self {
        Self {
            version: DESIGN_SCHEMA_VERSION,
            forms: vec![Form {
                id: "main".into(),
                name: "Main form".into(),
                table: None,
                controls: vec![],
                layout: GridLayout::default(),
            }],
            navigation: vec![NavigationItem {
                id: "main".into(),
                label: "Main form".into(),
                form_id: "main".into(),
            }],
        }
    }
}

fn validate_tracks(tracks: &[GridTrack], label: &str) -> Result<(), String> {
    if tracks.is_empty() && label == "columns" {
        return Err("grid layout requires at least one column track".into());
    }
    for track in tracks {
        match track.kind {
            TrackKind::Content => {}
            TrackKind::Fixed | TrackKind::Fr => {
                if track.value.is_none_or(|value| value <= 0.0) {
                    return Err(format!("{label} tracks need a positive size"));
                }
            }
        }
        if track
            .min
            .zip(track.max)
            .is_some_and(|(min, max)| min > max)
        {
            return Err(format!("{label} track minimum cannot exceed maximum"));
        }
    }
    Ok(())
}

fn validate_span(column: u16, row: u16, column_span: u16, row_span: u16, columns: usize) -> Result<(), String> {
    if column == 0 || row == 0 || column_span == 0 || row_span == 0 {
        return Err("grid placement uses 1-based positions and positive spans".into());
    }
    let end = column as usize + column_span as usize - 1;
    if end > columns {
        return Err("grid placement exceeds declared columns".into());
    }
    Ok(())
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
            validate_tracks(&form.layout.columns, "columns")?;
            validate_tracks(&form.layout.rows, "rows")?;
            for breakpoint in &form.layout.breakpoints {
                validate_tracks(&breakpoint.columns, "breakpoint columns")?;
            }
            let mut region_names = HashSet::new();
            for region in &form.layout.named_regions {
                if region.name.is_empty() || !region_names.insert(&region.name) {
                    return Err("named grid regions must be unique".into());
                }
                validate_span(
                    region.column,
                    region.row,
                    region.column_span,
                    region.row_span,
                    form.layout.columns.len(),
                )?;
            }
            let mut controls = HashSet::new();
            for control in &form.controls {
                if control.id.is_empty() || !controls.insert(&control.id) {
                    return Err("control ids must be non-empty and unique within a form".into());
                }
                if let Some(region) = &control.placement.region {
                    if !region_names.contains(region) {
                        return Err("control placement references an unknown region".into());
                    }
                } else {
                    validate_span(
                        control.placement.column,
                        control.placement.row,
                        control.placement.column_span,
                        control.placement.row_span,
                        form.layout.columns.len(),
                    )?;
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

pub fn track_css(track: &GridTrack) -> String {
    let size = match track.kind {
        TrackKind::Fr => format!("{}fr", track.value.unwrap_or(1.0)),
        TrackKind::Content => "max-content".into(),
        TrackKind::Fixed => format!("{}px", track.value.unwrap_or(0.0)),
    };
    if track.min.is_none() && track.max.is_none() {
        return size;
    }
    let min = track
        .min
        .map(|value| format!("{value}px"))
        .unwrap_or_else(|| "0px".into());
    let max = track
        .max
        .map(|value| format!("{value}px"))
        .unwrap_or(size);
    format!("minmax({min}, {max})")
}

pub fn layout_css(layout: &GridLayout) -> String {
    let columns = layout
        .columns
        .iter()
        .map(track_css)
        .collect::<Vec<_>>()
        .join(" ");
    let rows = if layout.rows.is_empty() {
        "auto".into()
    } else {
        layout
            .rows
            .iter()
            .map(track_css)
            .collect::<Vec<_>>()
            .join(" ")
    };
    format!(
        "display:grid;grid-template-columns:{columns};grid-template-rows:{rows};column-gap:{}px;row-gap:{}px;padding:{}px;justify-items:{};align-items:{}",
        layout.column_gap,
        layout.row_gap,
        layout.padding,
        align_css(layout.justify_items),
        align_css(layout.align_items)
    )
}

fn align_css(align: GridAlign) -> &'static str {
    match align {
        GridAlign::Stretch => "stretch",
        GridAlign::Start => "start",
        GridAlign::Center => "center",
        GridAlign::End => "end",
    }
}

pub fn placement_css(placement: &Placement) -> String {
    if let Some(region) = &placement.region {
        return format!("grid-area:{region}");
    }
    format!(
        "grid-column:{} / span {};grid-row:{} / span {}",
        placement.column, placement.column_span, placement.row, placement.row_span
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_schema_is_valid_and_versioned() {
        let design = DesignSchema::default();
        assert_eq!(design.version, DESIGN_SCHEMA_VERSION);
        assert_eq!(design.forms[0].layout.columns.len(), 12);
        assert!(design.validate().is_ok());
    }

    #[test]
    fn future_schema_version_is_rejected() {
        let mut design = DesignSchema::default();
        design.version += 1;
        assert_eq!(
            design.validate().unwrap_err(),
            "unsupported design schema version 3"
        );
    }

    #[test]
    fn placement_cannot_overflow_columns() {
        let mut design = DesignSchema::default();
        design.forms[0].controls.push(Control {
            id: "name".into(),
            kind: ControlKind::Text,
            label: "Name".into(),
            binding: None,
            validation: Validation::default(),
            placement: Placement {
                column: 12,
                row: 1,
                column_span: 2,
                row_span: 1,
                region: None,
            },
        });
        assert_eq!(
            design.validate().unwrap_err(),
            "grid placement exceeds declared columns"
        );
    }

    #[test]
    fn css_grid_renderer_matches_canonical_fixture() {
        let layout = GridLayout {
            columns: vec![
                GridTrack::fr(1.0),
                GridTrack {
                    kind: TrackKind::Fixed,
                    value: Some(200.0),
                    min: Some(120.0),
                    max: Some(320.0),
                },
                GridTrack {
                    kind: TrackKind::Content,
                    value: None,
                    min: None,
                    max: None,
                },
            ],
            rows: vec![GridTrack {
                kind: TrackKind::Fixed,
                value: Some(48.0),
                min: None,
                max: None,
            }],
            column_gap: 8,
            row_gap: 12,
            padding: 16,
            justify_items: GridAlign::Stretch,
            align_items: GridAlign::Start,
            named_regions: vec![],
            breakpoints: vec![],
        };
        assert_eq!(
            layout_css(&layout),
            "display:grid;grid-template-columns:1fr minmax(120px, 320px) max-content;grid-template-rows:48px;column-gap:8px;row-gap:12px;padding:16px;justify-items:stretch;align-items:start"
        );
        assert_eq!(
            placement_css(&Placement {
                column: 2,
                row: 1,
                column_span: 2,
                row_span: 1,
                region: None,
            }),
            "grid-column:2 / span 2;grid-row:1 / span 1"
        );
    }
}
