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
