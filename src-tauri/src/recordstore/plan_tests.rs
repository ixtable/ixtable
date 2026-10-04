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
