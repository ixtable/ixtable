use super::*;
use serde_json::json;

fn conn() -> duckdb::Connection {
    let c = duckdb::Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE orders(id INTEGER, customer TEXT, amount DOUBLE, paid BOOLEAN, placed DATE, placed_at TIMESTAMP);
         INSERT INTO orders VALUES
           (1,'ACME',10.5,true,'2024-01-02','2024-01-02 10:00:00'),
           (2,'Bolt',20,false,'2024-02-03','2024-02-03 11:30:00'),
           (3,'ACME',5,true,'2024-03-04','2024-03-04 09:15:00');",
    )
    .unwrap();
    c
}
fn param(
    name: &str,
    t: &str,
    default: Option<serde_json::Value>,
    required: bool,
) -> QueryParameter {
    QueryParameter {
        name: name.into(),
        logical_type: t.into(),
        default_value: default,
        required,
    }
}
fn nv(name: &str, value: DataValue) -> NamedValue {
    NamedValue {
        column: name.into(),
        value,
    }
}
fn run(
    sql: &str,
    declared: &[QueryParameter],
    supplied: &[NamedValue],
) -> Result<QueryRun, AppError> {
    run_on(&conn(), "test", None, sql, declared, supplied, true, None)
}

#[test]
fn rewrites_named_placeholders_outside_literals() {
    let r = rewrite_placeholders(
        "SELECT '$skip', \"$col\", $$ $no $$, $a, $b -- $c\n /* $d */ WHERE x = $a",
    )
    .unwrap();
    assert_eq!(r.names, vec!["a", "b"]);
    assert_eq!(
        r.sql,
        "SELECT '$skip', \"$col\", $$ $no $$, $1, $2 -- $c\n /* $d */ WHERE x = $1"
    );
    assert!(rewrite_placeholders("SELECT ?").is_err());
    assert!(rewrite_placeholders("SELECT $1").is_err());
    let r = rewrite_placeholders("SELECT 'it''s $x', E'\\' $y', $z").unwrap();
    assert_eq!(r.names, vec!["z"]);
}

#[test]
fn binds_typed_parameters() {
    let declared = [
        param("who", "text", None, false),
        param("min", "number", None, false),
        param("paid", "boolean", None, false),
        param("since", "date", None, false),
        param("after", "timestamp", None, false),
        param("id", "integer", None, false),
    ];
    let r = run(
        "SELECT id FROM orders WHERE customer = $who AND amount >= $min AND paid = $paid AND placed >= $since AND placed_at > $after AND id >= $id ORDER BY id",
        &declared,
        &[
            nv("who", DataValue::Text("ACME".into())),
            nv("min", DataValue::Text("5".into())),
            nv("paid", DataValue::Text("true".into())),
            nv("since", DataValue::Date("2024-01-01".into())),
            nv("after", DataValue::Text("2024-01-01T00:00:00Z".into())),
            nv("id", DataValue::Real(1.0)),
        ],
    )
    .unwrap();
    assert_eq!(
        r.rows,
        vec![vec![DataValue::Integer(1)], vec![DataValue::Integer(3)]]
    );
    let err = run(
        "SELECT $id",
        &[param("id", "integer", None, false)],
        &[nv("id", DataValue::Text("x".into()))],
    )
    .unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
}

#[test]
fn injection_attempts_are_bound_not_interpolated() {
    let r = run(
        "SELECT count(*) AS n FROM orders WHERE customer = $who",
        &[param("who", "text", None, false)],
        &[nv("who", DataValue::Text("ACME' OR '1'='1".into()))],
    )
    .unwrap();
    assert_eq!(r.rows, vec![vec![DataValue::Integer(0)]]);
}

#[test]
fn defaults_and_required_parameters() {
    let declared = [param("who", "text", Some(json!("Bolt")), false)];
    let r = run(
        "SELECT id FROM orders WHERE customer = $who",
        &declared,
        &[],
    )
    .unwrap();
    assert_eq!(r.rows, vec![vec![DataValue::Integer(2)]]);
    let err = run(
        "SELECT id FROM orders WHERE customer = $who",
        &[param("who", "text", None, true)],
        &[],
    )
    .unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
    assert!(err.message.contains("required"), "{}", err.message);
    let err = run("SELECT $undeclared", &[], &[]).unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
    // Ad hoc runs need a value for every placeholder.
    let err = run_on(&conn(), "t", None, "SELECT $x", &[], &[], false, None).unwrap_err();
    assert_eq!(err.code, "VALIDATION_ERROR");
    let ok = run_on(
        &conn(),
        "t",
        None,
        "SELECT $x AS x",
        &[],
        &[nv("x", DataValue::Integer(4))],
        false,
        None,
    )
    .unwrap();
    assert_eq!(ok.rows, vec![vec![DataValue::Integer(4)]]);
}

#[test]
fn rejects_mutating_sql_with_guidance() {
    for sql in [
        "DELETE FROM orders",
        "UPDATE orders SET amount = 0",
        "WITH x AS (SELECT 1) INSERT INTO orders SELECT * FROM orders",
        "DROP TABLE orders",
    ] {
        let err = run(sql, &[], &[]).unwrap_err();
        assert_eq!(err.code, "READ_ONLY", "{sql}");
        assert!(err.message.contains("migration"), "{}", err.message);
        assert!(err.message.contains("action"), "{}", err.message);
    }
    assert_eq!(
        run("SELECT 1; SELECT 2", &[], &[]).unwrap_err().code,
        "READ_ONLY"
    );
}

#[test]
fn check_prepares_without_running() {
    let c = conn();
    assert_eq!(
        check_on(
            &c,
            "SELECT * FROM orders WHERE customer = $who AND id > $min"
        )
        .unwrap(),
        vec!["who", "min"]
    );
    assert_eq!(
        check_on(&c, "SELECT * FROM missing").unwrap_err().code,
        "DATABASE_ERROR"
    );
    assert_eq!(
        check_on(&c, "DELETE FROM orders").unwrap_err().code,
        "READ_ONLY"
    );
}

#[test]
fn row_limit_sets_truncated() {
    let c = conn();
    let r = run_on(
        &c,
        "t",
        None,
        "SELECT * FROM range(50)",
        &[],
        &[],
        true,
        Some(10),
    )
    .unwrap();
    assert_eq!(r.rows.len(), 10);
    assert!(r.truncated);
    assert_eq!(r.row_limit, 10);
    let r = run_on(
        &c,
        "t",
        None,
        "SELECT * FROM range(5)",
        &[],
        &[],
        true,
        Some(10),
    )
    .unwrap();
    assert!(!r.truncated);
}

#[test]
fn cancel_interrupts_a_long_query() {
    let c = conn();
    let window = "cancel-test";
    let handle = std::thread::spawn(|| {
        for _ in 0..200 {
            std::thread::sleep(std::time::Duration::from_millis(25));
            if cancel("cancel-test", Some("slow")) > 0 {
                return true;
            }
        }
        false
    });
    let started = Instant::now();
    let err = run_on(
        &c,
        window,
        Some("slow".into()),
        "SELECT count(*) FROM range(100000000) a CROSS JOIN range(100000) b WHERE a.range + b.range < 0",
        &[],
        &[],
        true,
        None,
    )
    .unwrap_err();
    assert!(handle.join().unwrap());
    assert_eq!(err.code, "CANCELLED");
    assert!(started.elapsed().as_secs() < 30);
    assert_eq!(cancel(window, None), 0, "run deregistered");
}

#[test]
fn validate_reports_query_problems() {
    let mut config = DocumentConfig::default();
    config.saved_queries = vec![
        SavedQuery {
            id: "q1".into(),
            name: "Orders".into(),
            sql: "SELECT * FROM orders WHERE customer = $who".into(),
            ..Default::default()
        },
        SavedQuery {
            id: "q2".into(),
            name: "orders".into(),
            sql: "DELETE FROM orders".into(),
            parameters: vec![param("unused", "money", None, false)],
            ..Default::default()
        },
        SavedQuery {
            id: "q3".into(),
            name: "Built".into(),
            sql: "SELECT 1".into(),
            builder: Some(json!({
                "sources": [{"id":"s1","table":"orders","alias":"o"},{"id":"s2","table":"customers","alias":"c"}],
                "joins": [],
                "fields": [
                    {"id":"f1","source":"o","column":"customer","selected":true},
                    {"id":"f2","source":"o","column":"amount","aggregate":"sum","selected":true}
                ],
                "filters": {"kind":"group","combinator":"and","items":[
                    {"kind":"condition","source":"o","column":"amount","operator":">","value":{"kind":"param","name":"min"}},
                    {"kind":"condition","source":"o","column":"amount","aggregate":"sum","operator":">","value":{"kind":"value","value":1}}
                ]},
                "groupBy": [],
                "orderBy": [{"fieldId":"nope","direction":"asc"}]
            })),
            ..Default::default()
        },
        SavedQuery {
            id: "q4".into(),
            name: "Unused".into(),
            sql: "SELECT 1".into(),
            parameters: vec![param("spare", "text", None, false)],
            ..Default::default()
        },
    ];
    let issues = validate(&config);
    let text = issues
        .iter()
        .map(|i| i.message.clone())
        .collect::<Vec<_>>()
        .join("\n");
    for expected in [
        "declares no parameter who",
        "also named",
        "read-only",
        "unsupported type",
        "never uses",
        "source \"c\" is not joined",
        "move it to Having",
        "sort refers to a missing field",
        "undeclared parameter $min",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in\n{text}");
    }
    let clean = DocumentConfig {
        saved_queries: vec![SavedQuery {
            id: "ok".into(),
            name: "Ok".into(),
            sql: "SELECT $a AS a".into(),
            parameters: vec![param("a", "integer", Some(json!(3)), false)],
            ..Default::default()
        }],
        ..Default::default()
    };
    assert!(validate(&clean).is_empty(), "{:?}", validate(&clean));
}

#[test]
fn parameterized_sql_checks_without_values() {
    let c = conn();
    for sql in [
        "SELECT * FROM orders WHERE customer = $who",
        "SELECT * FROM orders LIMIT $n",
        "SELECT * FROM orders WHERE ($who IS NULL OR customer = $who)",
        "SELECT * FROM orders WHERE customer LIKE '%' || $q || '%'",
        "SELECT * FROM orders WHERE placed BETWEEN $from AND $to",
        "SELECT $label AS label, count(*) FROM orders",
        "SELECT * FROM orders WHERE customer = $who;",
        "SELECT * FROM orders WHERE customer <> 'Delete; me' AND id > $min",
    ] {
        check_on(&c, sql).unwrap_or_else(|e| panic!("{sql}: {}", e.message));
    }
}

#[test]
fn validate_accepts_outer_join_kinds() {
    let built = |kind: &str| DocumentConfig {
        saved_queries: vec![SavedQuery {
            id: "q".into(),
            name: "Joined".into(),
            sql: "SELECT 1".into(),
            builder: Some(json!({
                "sources": [{"id":"s1","table":"orders","alias":"o"},{"id":"s2","table":"customers","alias":"c"}],
                "joins": [{"id":"j","kind":kind,"source":"c","conditions":[
                    {"leftSource":"o","leftColumn":"customer_id","rightColumn":"id"},
                    {"leftSource":"o","leftColumn":"region","rightColumn":"region"}
                ]}],
                "fields": [],
                "filters": {"kind":"group","combinator":"and","items":[]},
                "groupBy": [],
                "orderBy": []
            })),
            ..Default::default()
        }],
        ..Default::default()
    };
    for kind in ["inner", "left", "right", "full"] {
        let issues = validate(&built(kind));
        assert!(issues.is_empty(), "{kind}: {issues:?}");
    }
    let issues = validate(&built("cross"));
    assert!(issues
        .iter()
        .any(|i| i.message.contains("join kind \"cross\"")));
}
