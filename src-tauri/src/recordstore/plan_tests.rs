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
