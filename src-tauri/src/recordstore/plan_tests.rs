use super::plan::*;
#[test]
fn renames_identifiers_but_not_strings() {
    assert_eq!(
        rename_identifier(
            "price > 0 AND \"price\" < 'price' AND prices = 1",
            "price",
            "cost"
        ),
        "\"cost\" > 0 AND \"cost\" < 'price' AND prices = 1"
    );
    assert!(mentions("qty * price", "PRICE"));
    assert!(!mentions("'qty'", "qty"));
}

#[test]
fn renames_list_the_definitions_that_use_the_old_name() {
    use super::commands::rename_dependents;
    use crate::archive::{DocumentConfig, SavedQuery};
    use crate::data::AlterTable;
    let query = |id: &str, sql: &str| SavedQuery {
        id: id.into(),
        name: id.into(),
        sql: sql.into(),
        ..Default::default()
    };
    let config = DocumentConfig {
        saved_queries: vec![
            query("by_price", "SELECT price FROM parts"),
            query("by_label", "SELECT label FROM parts"),
            query("other", "SELECT price FROM bins"),
        ],
        ..Default::default()
    };
    let rename_table = [AlterTable::RenameTable {
        new_name: "items".into(),
    }];
    let (deps, warnings) = rename_dependents(&config, "parts", &rename_table);
    let ids: Vec<_> = deps.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["by_price", "by_label"]);
    assert_eq!(warnings.len(), 1);
    assert!(
        warnings[0].contains("Renaming parts to items"),
        "{warnings:?}"
    );

    let rename_column = [AlterTable::RenameColumn {
        column: "price".into(),
        new_name: "cost".into(),
    }];
    let (deps, warnings) = rename_dependents(&config, "parts", &rename_column);
    assert_eq!(
        deps.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
        ["by_price"]
    );
    assert!(
        warnings[0].contains("query \u{201c}by_price\u{201d}"),
        "{warnings:?}"
    );

    let (deps, warnings) = rename_dependents(&config, "unused", &rename_table);
    assert!(deps.is_empty() && warnings.is_empty());
}

#[test]
fn column_dependents_ignore_control_kinds() {
    use super::commands::config_dependents;
    use crate::archive::DocumentConfig;
    use crate::design::{DesignSchema, Form};
    let form = |id: &str, column: &str| -> Form {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "source": { "kind": "table", "table": "notes" },
            "controls": [{
                "id": format!("{id}_c"),
                "kind": "text",
                "label": "Text",
                "binding": { "column": column }
            }]
        }))
        .unwrap()
    };
    let config = DocumentConfig {
        design: DesignSchema {
            version: 3,
            forms: vec![form("bound", "text"), form("other", "title")],
            navigation: vec![],
            start_page: None,
        },
        ..Default::default()
    };
    let ids: Vec<_> = config_dependents(&config, "text")
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(ids, ["bound"]);
}

fn int_col(name: &str, check: Option<&str>) -> crate::data::CreateColumn {
    crate::data::CreateColumn {
        name: name.into(),
        declared_type: "INTEGER".into(),
        nullable: true,
        check: check.map(Into::into),
        ..Default::default()
    }
}

fn checked_table() -> crate::data::TableDef {
    def_from_spec(&crate::data::CreateTable {
        name: "t".into(),
        columns: vec![int_col("qty", Some("qty > 0")), int_col("max", None)],
        checks: vec!["qty <= max".into()],
        ..Default::default()
    })
    .unwrap()
}

fn alter_qty(check: Option<&str>) -> Vec<String> {
    let op = crate::data::AlterTable::AlterColumn {
        column: "qty".into(),
        definition: int_col("qty", check),
    };
    let applied = apply_ops(&checked_table(), &[op], |_, _| {
        (super::ChangeMode::InPlace, None)
    })
    .unwrap();
    applied
        .def
        .checks
        .iter()
        .map(|c| c.expression.clone())
        .collect()
}

#[test]
fn altering_a_column_keeps_replaces_or_removes_its_check() {
    let def = checked_table();
    assert_eq!(column_checks(&def, "QTY"), vec![0]);
    assert!(column_checks(&def, "max").is_empty());
    assert_eq!(alter_qty(Some(" qty > 0 ")), vec!["qty > 0", "qty <= max"]);
    assert_eq!(alter_qty(Some("qty >= 1")), vec!["qty <= max", "qty >= 1"]);
    assert_eq!(alter_qty(None), vec!["qty > 0", "qty <= max"]);
    assert_eq!(alter_qty(Some("")), vec!["qty <= max"]);
    assert_eq!(
        joined_check(["a > 0", "a < 9"].into_iter()).as_deref(),
        Some("(a > 0) AND (a < 9)")
    );
}
