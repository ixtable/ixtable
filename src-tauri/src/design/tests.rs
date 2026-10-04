use super::*;
use crate::archive::{DocumentConfig, SavedQuery};
use crate::validation::Severity;
use std::collections::HashMap;

fn control(id: &str, kind: ControlKind) -> Control {
    Control {
        id: id.into(),
        kind,
        label: id.into(),
        binding: Some(Binding {
            table: None,
            column: id.into(),
        }),
        ..Default::default()
    }
}

fn config_with(form: Form) -> DocumentConfig {
    let mut config = DocumentConfig::default();
    config.design.forms.push(form);
    config
}

fn errors(issues: &[crate::archive::Issue]) -> Vec<String> {
    issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| i.message.clone())
        .collect()
}

#[test]
fn default_schema_is_valid_and_versioned() {
    let design = DesignSchema::default();
    assert_eq!(design.version, DESIGN_SCHEMA_VERSION);
    assert_eq!(design.forms[0].layout.columns.len(), 12);
    assert!(design.validate().is_ok());
    assert!(validate(&DocumentConfig::default()).is_empty());
}

#[test]
fn future_schema_version_is_rejected() {
    let mut design = DesignSchema::default();
    design.version += 1;
    assert_eq!(
        design.validate().unwrap_err(),
        "unsupported design schema version 4"
    );
    let parsed: DesignSchema = serde_json::from_value(serde_json::json!({"version": 9})).unwrap();
    assert_eq!(parsed.version, 9);
}

#[test]
fn placement_cannot_overflow_columns() {
    let mut design = DesignSchema::default();
    let mut item = control("name", ControlKind::Text);
    item.placement = Placement {
        column: 12,
        row: 1,
        column_span: 2,
        row_span: 1,
        region: None,
    };
    design.forms[0].controls.push(item);
    assert_eq!(
        design.validate().unwrap_err(),
        "grid placement exceeds declared columns"
    );
}

#[test]
fn v2_design_upgrades_to_v3() {
    let legacy = serde_json::json!({
        "version": 2,
        "forms": [{"id": "f", "name": "Customers", "table": "customers", "controls": [
            {"id": "c", "kind": "checkbox", "label": "Active", "binding": {"table": "customers", "column": "active"}}
        ]}],
        "navigation": [{"id": "n", "label": "Customers", "formId": "f"}]
    });
    let design: DesignSchema = serde_json::from_value(legacy).unwrap();
    assert_eq!(design.version, DESIGN_SCHEMA_VERSION);
    let form = &design.forms[0];
    assert_eq!(
        form.source.as_ref().unwrap().table.as_deref(),
        Some("customers")
    );
    assert_eq!(form.modes, default_modes());
    assert_eq!(form.controls[0].kind, ControlKind::Boolean);
    assert_eq!(form.controls[0].binding.as_ref().unwrap().column, "active");
    assert_eq!(design.navigation[0].kind, NavKind::Form);
    assert_eq!(design.navigation[0].target_id.as_deref(), Some("f"));
    assert_eq!(design.start_page.as_deref(), Some("n"));
    assert!(design.validate().is_ok());
    let yaml = serde_yaml::to_string(&design).unwrap();
    let reparsed: DesignSchema = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(reparsed, design);
}

#[test]
fn dependency_issues_cover_queries_actions_forms_and_navigation() {
    let mut config = config_with(Form {
        id: "orders".into(),
        name: "Orders".into(),
        source: Some(FormSource {
            kind: SourceKind::Query,
            table: None,
            query_id: Some("missing".into()),
            ..Default::default()
        }),
        modes: vec![FormMode::List, FormMode::Edit],
        detail_form_id: Some("nope".into()),
        controls: vec![
            Control {
                action_id: Some("ghost".into()),
                ..control("go", ControlKind::Button)
            },
            Control {
                visible_when: Some(" ".into()),
                ..control("name", ControlKind::Text)
            },
            Control {
                parent: Some(ControlParent {
                    id: "absent".into(),
                    tab: None,
                }),
                ..control("x", ControlKind::Text)
            },
            control("tabs", ControlKind::Tabs),
            control("calc", ControlKind::Computed),
        ],
        ..Default::default()
    });
    config.design.navigation.push(NavigationItem {
        id: "grp".into(),
        label: "Group".into(),
        kind: NavKind::Group,
        children: vec![NavigationItem {
            id: "r".into(),
            label: "Sales".into(),
            kind: NavKind::Report,
            target_id: Some("r1".into()),
            ..Default::default()
        }],
        ..Default::default()
    });
    config.design.start_page = Some("unknown".into());
    let all = validate(&config);
    let errs = errors(&all);
    for needle in [
        "saved query that does not exist",
        "detail form that does not exist",
        "action that does not exist",
        "empty visibility expression",
        "container that does not exist",
        "has no tabs",
        "has no expression",
        "\"Sales\" opens something that does not exist",
        "start page",
    ] {
        assert!(
            errs.iter().any(|e| e.contains(needle)),
            "missing {needle}: {errs:?}"
        );
    }
    assert!(all.iter().any(|i| i.message.contains("read-only")));
    config.saved_queries.push(SavedQuery {
        id: "missing".into(),
        name: "Q".into(),
        sql: "SELECT 1".into(),
        ..Default::default()
    });
    assert!(!errors(&validate(&config))
        .iter()
        .any(|e| e.contains("saved query")));
}

#[test]
fn related_list_nesting_is_one_level() {
    let related = |form: Option<&str>| Control {
        related: Some(RelatedList {
            table: "items".into(),
            foreign_key: "order_id".into(),
            parent_column: "id".into(),
            columns: vec![],
            form_id: form.map(Into::into),
        }),
        ..control("lines", ControlKind::RelatedList)
    };
    let mut config = config_with(Form {
        id: "order".into(),
        name: "Order".into(),
        controls: vec![related(Some("item"))],
        ..Default::default()
    });
    config.design.forms.push(Form {
        id: "item".into(),
        name: "Item".into(),
        ..Default::default()
    });
    assert!(errors(&validate(&config)).is_empty());
    config.design.forms[2].controls.push(related(None));
    assert!(errors(&validate(&config))
        .iter()
        .any(|e| e.contains("one level")));
}

#[test]
fn table_references_are_checked_against_schema() {
    let mut config = config_with(Form {
        id: "c".into(),
        name: "Customers".into(),
        source: Some(FormSource {
            kind: SourceKind::Table,
            table: Some("customers".into()),
            query_id: None,
            ..Default::default()
        }),
        controls: vec![
            control("name", ControlKind::Text),
            control("ghost", ControlKind::Text),
            Control {
                relationship: Some(Relationship {
                    table: "regions".into(),
                    value_column: "id".into(),
                    display_column: "label".into(),
                }),
                ..control("region", ControlKind::Relationship)
            },
        ],
        ..Default::default()
    });
    config.design.navigation.push(NavigationItem {
        id: "t".into(),
        label: "Raw".into(),
        kind: NavKind::Table,
        target_id: Some("nope".into()),
        ..Default::default()
    });
    let tables = HashMap::from([
        (
            "customers".to_string(),
            vec!["name".to_string(), "region".to_string()],
        ),
        ("regions".to_string(), vec!["id".to_string()]),
    ]);
    let errs = errors(&validate_tables(&config, &tables));
    assert_eq!(errs.len(), 3, "{errs:?}");
    assert!(errs.iter().any(|e| e.contains("customers.ghost")));
    assert!(errs.iter().any(|e| e.contains("regions.label")));
    assert!(errs.iter().any(|e| e.contains("table that does not exist")));
}

#[test]
fn container_children_use_the_container_grid() {
    let mut tabs = control("tabs", ControlKind::Tabs);
    tabs.tabs = vec![TabPage {
        id: "t1".into(),
        label: "General".into(),
    }];
    tabs.layout = Some(GridLayout {
        columns: vec![GridTrack::fr(1.0); 2],
        ..Default::default()
    });
    let mut child = control("name", ControlKind::Text);
    child.parent = Some(ControlParent {
        id: "tabs".into(),
        tab: Some("t1".into()),
    });
    child.placement.column_span = 2;
    let mut design = DesignSchema::default();
    design.forms[0].controls = vec![tabs, child.clone()];
    assert!(design.validate().is_ok());
    design.forms[0].controls[1].placement.column_span = 3;
    assert!(design.validate().is_err());
    let config = config_with(Form {
        id: "f".into(),
        name: "F".into(),
        controls: vec![
            Control {
                tabs: vec![TabPage {
                    id: "t1".into(),
                    label: "A".into(),
                }],
                ..control("tabs", ControlKind::Tabs)
            },
            Control {
                parent: Some(ControlParent {
                    id: "tabs".into(),
                    tab: Some("t9".into()),
                }),
                ..child
            },
        ],
        ..Default::default()
    });
    assert!(errors(&validate(&config))
        .iter()
        .any(|e| e.contains("tab that does not exist")));
}

#[test]
fn query_source_parameter_bindings_are_checked() {
    let mut config = config_with(Form {
        id: "f".into(),
        name: "Orders".into(),
        source: Some(FormSource {
            kind: SourceKind::Query,
            query_id: Some("q".into()),
            params: [
                ("who".to_string(), "app.user.name".to_string()),
                ("ghost".to_string(), "1".to_string()),
                ("min".to_string(), " ".to_string()),
            ]
            .into(),
            ..Default::default()
        }),
        modes: vec![FormMode::List],
        ..Default::default()
    });
    config.saved_queries.push(SavedQuery {
        id: "q".into(),
        name: "Q".into(),
        sql: "SELECT 1 WHERE $who IS NOT NULL OR $min > 0".into(),
        parameters: ["who", "min"]
            .iter()
            .map(|n| crate::archive::QueryParameter {
                name: n.to_string(),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    });
    let errs = errors(&validate(&config)).join("\n");
    assert!(errs.contains("binds $ghost"), "{errs}");
    assert!(errs.contains("binds $min to an empty"), "{errs}");
    assert!(!errs.contains("$who"), "{errs}");
    let json = serde_json::to_value(&config.design.forms.last().unwrap().source).unwrap();
    assert_eq!(json["params"]["who"], "app.user.name");
}
