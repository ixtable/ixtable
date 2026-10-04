use super::tests::{conn, nv, param};
use super::*;
use serde_json::json;

fn page(
    c: &duckdb::Connection,
    sql: &str,
    declared: &[QueryParameter],
    supplied: &[NamedValue],
    spec: &PageSpec,
) -> Result<QueryPage, AppError> {
    page_on(c, "test", None, sql, declared, supplied, spec)
}

#[test]
fn pages_saved_queries_in_duckdb_with_exact_totals() {
    let c = conn();
    c.execute_batch(
        "CREATE TABLE big AS SELECT range AS n, 'row ' || range AS label FROM range(25000);",
    )
    .unwrap();
    let declared = [param("min", "integer", None, true)];
    let min = [nv("min", DataValue::Integer(100))];
    let sorts = [crate::data::Sort {
        column: "n".into(),
        descending: true,
    }];
    let spec = PageSpec {
        offset: 10,
        limit: 5,
        sorts: &sorts,
        filters: &[],
    };
    // Trailing semicolon and comment in the saved SQL still wrap cleanly.
    let sql = "SELECT n, label FROM big WHERE n >= $min; -- tail";
    let r = page(&c, sql, &declared, &min, &spec).unwrap();
    assert_eq!(r.columns, vec!["n", "label"]);
    assert_eq!(r.total, 24_900, "no 10k cap on the total");
    assert_eq!(r.rows.len(), 5);
    assert_eq!(r.rows[0][0], DataValue::Integer(24_989));
    // Required parameters are still enforced.
    let err = page(&c, sql, &declared, &[], &spec).unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
}

#[test]
fn paged_filters_are_bound_and_columns_checked() {
    let c = conn();
    let filters = [crate::data::Filter {
        column: "customer".into(),
        operator: crate::data::FilterOperator::Contains,
        value: Some(DataValue::Text("acme' OR '1'='1".into())),
        values: None,
    }];
    let spec = PageSpec {
        offset: 0,
        limit: 10,
        sorts: &[],
        filters: &filters,
    };
    let sql = "SELECT id, customer FROM orders WHERE amount >= $min";
    let declared = [param("min", "number", Some(json!(0)), false)];
    let r = page(&c, sql, &declared, &[], &spec).unwrap();
    assert_eq!(r.total, 0);
    let filters = [
        crate::data::Filter {
            column: "customer".into(),
            operator: crate::data::FilterOperator::Contains,
            value: Some(DataValue::Text("acm".into())),
            values: None,
        },
        crate::data::Filter {
            column: "id".into(),
            operator: crate::data::FilterOperator::Gt,
            value: Some(DataValue::Integer(1)),
            values: None,
        },
    ];
    let spec = PageSpec {
        filters: &filters,
        ..spec
    };
    let supplied = [nv("min", DataValue::Integer(1))];
    let r = page(&c, sql, &declared, &supplied, &spec).unwrap();
    assert_eq!(r.total, 1);
    assert_eq!(
        r.rows,
        vec![vec![DataValue::Integer(3), DataValue::Text("ACME".into())]]
    );
    let bad = [crate::data::Sort {
        column: "amount\" DESC; DROP TABLE orders; --".into(),
        descending: false,
    }];
    let bad_spec = PageSpec {
        sorts: &bad,
        ..spec
    };
    let err = page(&c, sql, &declared, &[], &bad_spec).unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
    let err = page(&c, sql, &declared, &[], &PageSpec { limit: 0, ..spec }).unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
    assert!(page(&c, "DELETE FROM orders", &[], &[], &spec).is_err());
}

#[test]
fn paged_in_filters_bind_each_value_and_match_nothing_when_empty() {
    let c = conn();
    let sql = "SELECT id, customer FROM orders WHERE amount >= $min";
    let declared = [param("min", "number", Some(json!(0)), false)];
    let filter = |values: Vec<DataValue>| crate::data::Filter {
        column: "id".into(),
        operator: crate::data::FilterOperator::In,
        value: None,
        values: Some(values),
    };
    let sorts = [crate::data::Sort {
        column: "id".into(),
        descending: false,
    }];
    let filters = [filter(vec![DataValue::Integer(1), DataValue::Integer(3)])];
    let spec = PageSpec {
        offset: 0,
        limit: 10,
        sorts: &sorts,
        filters: &filters,
    };
    let supplied = [nv("min", DataValue::Integer(6))];
    let r = page(&c, sql, &declared, &supplied, &spec).unwrap();
    assert_eq!(r.total, 1);
    assert_eq!(r.rows[0][0], DataValue::Integer(1));
    let none = [filter(vec![])];
    let r = page(
        &c,
        sql,
        &declared,
        &[],
        &PageSpec {
            filters: &none,
            ..spec
        },
    )
    .unwrap();
    assert_eq!(r.total, 0);
    assert!(r.rows.is_empty());
}

#[test]
fn paged_search_is_literal_case_insensitive_and_counts_with_the_page() {
    let c = conn();
    c.execute_batch(
        "CREATE TABLE notes(id INTEGER, body TEXT);
         INSERT INTO notes VALUES (1,'50% off'),(2,'500 units'),(3,'a_b'),(4,'axb'),(5,'Acme'),(6,'ACME co');",
    )
    .unwrap();
    let sql = "SELECT id, body FROM notes";
    let search = |text: &str, offset: u64| {
        let filters = [crate::data::Filter {
            column: "body".into(),
            operator: crate::data::FilterOperator::Contains,
            value: Some(DataValue::Text(text.into())),
            values: None,
        }];
        let sorts = [crate::data::Sort {
            column: "id".into(),
            descending: false,
        }];
        let spec = PageSpec {
            offset,
            limit: 1,
            sorts: &sorts,
            filters: &filters,
        };
        page(&c, sql, &[], &[], &spec).unwrap()
    };
    assert_eq!(search("50%", 0).total, 1);
    assert_eq!(search("a_b", 0).total, 1);
    let r = search("acme", 1);
    assert_eq!(r.columns, vec!["id", "body"]);
    assert_eq!(r.total, 2);
    assert_eq!(
        r.rows,
        vec![vec![
            DataValue::Integer(6),
            DataValue::Text("ACME co".into())
        ]]
    );
    let past = search("acme", 5);
    assert!(past.rows.is_empty());
    assert_eq!(past.total, 2);
    assert_eq!(past.columns, vec!["id", "body"]);
}
