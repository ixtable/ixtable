//! RecordStore conformance suite (PRD §9.4, §10.1). Every scenario runs as
//! `sqlite::<scenario>` and as `postgres::<scenario>`, which is `#[ignore]`d and
//! needs `IXTABLE_TEST_POSTGRES_URL` (see `crate::test_env`); reads always go
//! through DuckDB, so this also proves read-after-write and logical-type
//! equivalence across engines.
use super::{sqlite::SqliteRecordStore, RecordStore, StoreError, WriteOp};
use crate::data::{
    CreateColumn, CreateForeignKey, CreateTable, DataValue, NamedValue, ReadRuntime, ReadTarget,
};

pub(crate) struct Harness {
    pub name: &'static str,
    pub store: Box<dyn RecordStore>,
    pub reader: ReadRuntime,
    cleanup: Option<Box<dyn FnOnce()>>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(f) = self.cleanup.take() {
            f()
        }
    }
}

pub(crate) fn sqlite_harness() -> Harness {
    let dir = std::env::temp_dir().join(format!("ixtable-conformance-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    rusqlite::Connection::open(dir.join("data.db")).unwrap();
    let reader = ReadRuntime::for_test(&dir).unwrap();
    let store = SqliteRecordStore::new(dir.join("data.db"));
    Harness {
        name: "sqlite",
        store: Box::new(store),
        reader,
        cleanup: Some(Box::new(move || {
            let _ = std::fs::remove_dir_all(dir);
        })),
    }
}

/// `None` (or a panic under CI) when `IXTABLE_TEST_POSTGRES_URL` is missing.
pub(crate) fn postgres_harness() -> Option<Harness> {
    let url = crate::test_env::postgres_url()?;
    let schema = format!("ixt_{}", uuid::Uuid::new_v4().simple());
    let mut admin =
        ::postgres::Client::connect(&url, ::postgres::NoTls).expect("PostgreSQL test server");
    admin
        .batch_execute(&format!("CREATE SCHEMA {schema}"))
        .unwrap();
    let store = crate::postgres::PostgresRecordStore::from_url(&url, &schema).unwrap();
    let dir = std::env::temp_dir().join(format!("ixtable-conformance-pg-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    rusqlite::Connection::open(dir.join("data.db")).unwrap();
    let mut reader = ReadRuntime::for_test(&dir).unwrap();
    reader
        .set_target(ReadTarget::Postgres {
            conninfo: url.clone(),
            schema: schema.clone(),
        })
        .unwrap();
    Some(Harness {
        name: "postgres",
        store: Box::new(store),
        reader,
        cleanup: Some(Box::new(move || {
            let _ = admin.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"));
            let _ = std::fs::remove_dir_all(dir);
        })),
    })
}

#[derive(Clone, Copy)]
pub(crate) enum Store {
    Sqlite,
    Postgres,
}

/// Runs a scenario on one store.
pub(crate) fn each_store(store: Store, scenario: impl Fn(&mut Harness)) {
    let harness = match store {
        Store::Sqlite => Some(sqlite_harness()),
        Store::Postgres => postgres_harness(),
    };
    if let Some(mut h) = harness {
        scenario(&mut h);
    }
}

/// Declares `sqlite::<scenario>` and the ignored `postgres::<scenario>` tests.
macro_rules! per_store {
    ($($scenario:ident),* $(,)?) => {
        mod sqlite {
            $(#[test]
            fn $scenario() {
                super::$scenario(super::Store::Sqlite)
            })*
        }
        mod postgres {
            $(#[test]
            #[ignore = "needs IXTABLE_TEST_POSTGRES_URL; CI runs it with --include-ignored"]
            fn $scenario() {
                super::$scenario(super::Store::Postgres)
            })*
        }
    };
}
pub(crate) use per_store;

per_store!(
    crud_is_visible_to_duckdb_reads_after_each_commit,
    constraints_map_to_stable_codes_and_cascade,
    batches_are_atomic_and_values_are_bound_not_interpolated,
    logical_types_round_trip_identically_through_duckdb,
);

pub(crate) fn col(name: &str, t: &str) -> CreateColumn {
    CreateColumn {
        name: name.into(),
        logical_type: Some(t.parse().unwrap()),
        nullable: true,
        ..Default::default()
    }
}
pub(crate) fn nv(column: &str, value: DataValue) -> NamedValue {
    NamedValue {
        column: column.into(),
        value,
    }
}
pub(crate) fn text(s: &str) -> DataValue {
    DataValue::Text(s.into())
}
pub(crate) fn int(i: i64) -> DataValue {
    DataValue::Integer(i)
}
pub(crate) fn rows(h: &mut Harness, table: &str) -> Vec<Vec<DataValue>> {
    h.reader.refresh().unwrap();
    let sort = [crate::data::Sort {
        column: h.reader.schema(table).unwrap().columns[0].name.clone(),
        descending: false,
    }];
    h.reader.page(table, 0, 100, &sort, &[]).unwrap().rows
}
pub(crate) fn constraint(e: StoreError) -> (&'static str, Option<&'static str>) {
    (e.code, e.constraint)
}

pub(crate) fn people(h: &mut Harness) {
    h.store
        .create_table(&CreateTable {
            name: "people".into(),
            columns: vec![
                CreateColumn {
                    primary_key_position: 1,
                    nullable: false,
                    ..col("id", "integer")
                },
                CreateColumn {
                    nullable: false,
                    ..col("name", "text")
                },
                col("score", "real"),
            ],
            ..Default::default()
        })
        .unwrap();
}

fn crud_is_visible_to_duckdb_reads_after_each_commit(store: Store) {
    each_store(store, |h| {
        people(h);
        let id = h
            .store
            .insert(
                "people",
                &[nv("name", text("Ada")), nv("score", DataValue::Real(2.5))],
            )
            .unwrap();
        assert_eq!(id, vec![int(1)], "{}: generated integer key", h.name);
        h.store
            .insert("people", &[nv("id", int(7)), nv("name", text("Bob"))])
            .unwrap();
        assert_eq!(
            rows(h, "people"),
            vec![
                vec![int(1), text("Ada"), DataValue::Real(2.5)],
                vec![int(7), text("Bob"), DataValue::Null]
            ]
        );
        assert_eq!(
            h.store
                .update("people", &[nv("name", text("Ada L."))], &[int(1)], None)
                .unwrap(),
            1
        );
        assert_eq!(rows(h, "people")[0][1], text("Ada L."), "{}", h.name);
        h.store.delete("people", &[int(7)], None).unwrap();
        assert_eq!(rows(h, "people").len(), 1);
        assert_eq!(
            constraint(h.store.delete("people", &[int(7)], None).unwrap_err()).0,
            "STALE_ROW"
        );
    });
}

fn constraints_map_to_stable_codes_and_cascade(store: Store) {
    each_store(store, |h| {
        h.store
            .create_table(&CreateTable {
                name: "parent".into(),
                columns: vec![
                    CreateColumn {
                        primary_key_position: 1,
                        nullable: false,
                        ..col("a", "text")
                    },
                    CreateColumn {
                        primary_key_position: 2,
                        nullable: false,
                        ..col("b", "integer")
                    },
                ],
                ..Default::default()
            })
            .unwrap();
        h.store
            .create_table(&CreateTable {
                name: "child".into(),
                columns: vec![
                    CreateColumn {
                        primary_key_position: 1,
                        nullable: false,
                        ..col("id", "integer")
                    },
                    col("pa", "text"),
                    col("pb", "integer"),
                    CreateColumn {
                        nullable: false,
                        default_expression: Some("1".into()),
                        check: Some("qty > 0".into()),
                        ..col("qty", "integer")
                    },
                    CreateColumn {
                        unique: true,
                        ..col("code", "text")
                    },
                ],
                foreign_keys: vec![CreateForeignKey {
                    name: None,
                    columns: vec!["pa".into(), "pb".into()],
                    target_table: "parent".into(),
                    target_columns: vec!["a".into(), "b".into()],
                    on_update: Some("CASCADE".into()),
                    on_delete: Some("CASCADE".into()),
                }],
                ..Default::default()
            })
            .unwrap();
        let fk = h
            .store
            .insert("child", &[nv("pa", text("x")), nv("pb", int(1))])
            .unwrap_err();
        assert_eq!(
            constraint(fk),
            ("CONSTRAINT_VIOLATION", Some("foreign_key")),
            "{}",
            h.name
        );
        h.store
            .insert("parent", &[nv("a", text("x")), nv("b", int(1))])
            .unwrap();
        h.store
            .insert(
                "child",
                &[nv("pa", text("x")), nv("pb", int(1)), nv("code", text("A"))],
            )
            .unwrap();
        assert_eq!(
            rows(h, "child")[0][3],
            int(1),
            "{}: default applied",
            h.name
        );
        let dup = h
            .store
            .insert("child", &[nv("code", text("A"))])
            .unwrap_err();
        assert_eq!(
            constraint(dup),
            ("CONSTRAINT_VIOLATION", Some("unique")),
            "{}",
            h.name
        );
        let check = h.store.insert("child", &[nv("qty", int(0))]).unwrap_err();
        assert_eq!(
            constraint(check),
            ("CONSTRAINT_VIOLATION", Some("check")),
            "{}",
            h.name
        );
        let nn = h
            .store
            .insert("child", &[nv("qty", DataValue::Null)])
            .unwrap_err();
        assert_eq!(
            constraint(nn),
            ("CONSTRAINT_VIOLATION", Some("not_null")),
            "{}",
            h.name
        );
        let pk = h
            .store
            .insert("parent", &[nv("a", text("x")), nv("b", int(1))])
            .unwrap_err();
        assert_eq!(constraint(pk).0, "CONSTRAINT_VIOLATION", "{}", h.name);
        let impact = h.store.impact("parent").unwrap();
        assert_eq!(
            (
                impact.rows,
                impact.inbound_foreign_keys.len(),
                impact.inbound_foreign_keys[0].rows
            ),
            (1, 1, 1)
        );
        h.store
            .delete("parent", &[text("x"), int(1)], None)
            .unwrap();
        assert!(rows(h, "child").is_empty(), "{}: ON DELETE CASCADE", h.name);
    });
}

fn batches_are_atomic_and_values_are_bound_not_interpolated(store: Store) {
    each_store(store, |h| {
        people(h);
        let hostile = "Robert'); DROP TABLE people; --";
        let err = h
            .store
            .execute_batch(&[
                WriteOp::Insert {
                    table: "people".into(),
                    values: vec![nv("id", int(1)), nv("name", text(hostile))],
                },
                WriteOp::Insert {
                    table: "people".into(),
                    values: vec![nv("id", int(2)), nv("name", DataValue::Null)],
                },
            ])
            .unwrap_err();
        assert_eq!(
            constraint(err),
            ("CONSTRAINT_VIOLATION", Some("not_null")),
            "{}",
            h.name
        );
        assert!(
            rows(h, "people").is_empty(),
            "{}: batch rolled back",
            h.name
        );
        let out = h
            .store
            .execute_batch(&[
                WriteOp::Insert {
                    table: "people".into(),
                    values: vec![nv("id", int(1)), nv("name", text(hostile))],
                },
                WriteOp::Update {
                    table: "people".into(),
                    values: vec![nv("score", int(3))],
                    identity: vec![int(1)],
                    expected: None,
                },
            ])
            .unwrap();
        assert_eq!(out[0].identity, Some(vec![int(1)]));
        assert_eq!(
            rows(h, "people"),
            vec![vec![int(1), text(hostile), DataValue::Real(3.0)]]
        );
    });
}

fn logical_types_round_trip_identically_through_duckdb(store: Store) {
    let types = [
        ("d", "decimal(10,2)"),
        ("dt", "date"),
        ("t", "time"),
        ("ts", "timestamp"),
        ("b", "boolean"),
        ("u", "uuid"),
        ("j", "json"),
        ("bl", "blob"),
        ("r", "real"),
        ("tx", "text"),
    ];
    each_store(store, |h| {
        let mut columns = vec![CreateColumn {
            primary_key_position: 1,
            nullable: false,
            ..col("id", "integer")
        }];
        columns.extend(types.iter().map(|(n, t)| col(n, t)));
        h.store
            .create_table(&CreateTable {
                name: "typed".into(),
                columns,
                ..Default::default()
            })
            .unwrap();
        let values = [
            text("1234.5"),
            text("2024-02-29"),
            text("13:05:09.25"),
            text("2024-01-31 23:59:58.5"),
            text("true"),
            text("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"),
            text("{\"a\": [1, 2]}"),
            DataValue::Blob("AP8=".into()),
            DataValue::Real(-0.125),
            text("ünïcode ✓"),
        ];
        let mut named = vec![nv("id", int(1))];
        named.extend(
            types
                .iter()
                .zip(values.iter())
                .map(|((n, _), v)| nv(n, v.clone())),
        );
        h.store.insert("typed", &named).unwrap();
        h.store.insert("typed", &[nv("id", int(2))]).unwrap();
        let got = rows(h, "typed");
        assert_eq!(
            got[0][1..].to_vec(),
            vec![
                DataValue::Decimal("1234.50".into()),
                DataValue::Date("2024-02-29".into()),
                DataValue::Time("13:05:09.25".into()),
                DataValue::Timestamp("2024-01-31T23:59:58.5".into()),
                DataValue::Boolean(true),
                text("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
                got[0][7].clone(),
                DataValue::Blob("AP8=".into()),
                DataValue::Real(-0.125),
                text("ünïcode ✓"),
            ],
            "{}",
            h.name
        );
        let json: serde_json::Value = serde_json::from_str(&got[0][7].as_text().unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({"a": [1, 2]}));
        assert!(
            got[1][1..].iter().all(|v| v == &DataValue::Null),
            "{}: nulls {:?}",
            h.name,
            got[1]
        );
        let schema = h.reader.schema("typed").unwrap();
        let logical: Vec<String> = schema
            .columns
            .iter()
            .skip(1)
            .map(|c| c.logical_type.to_string())
            .collect();
        assert_eq!(
            logical,
            types.iter().map(|t| t.1.to_string()).collect::<Vec<_>>(),
            "{}",
            h.name
        );
        let bad = h
            .store
            .insert("typed", &[nv("id", int(3)), nv("d", text("1.234"))])
            .unwrap_err();
        assert_eq!(bad.code, "VALIDATION_ERROR");
        let filtered = h
            .reader
            .page(
                "typed",
                0,
                10,
                &[],
                &[crate::data::Filter {
                    column: "dt".into(),
                    operator: crate::data::FilterOperator::Eq,
                    value: Some(DataValue::Date("2024-02-29".into())),
                    values: None,
                }],
            )
            .unwrap();
        assert_eq!(filtered.total, 1, "{}: date parameter binding", h.name);
    });
}

/// A PostgreSQL refresh keeps the attached database (it only clears postgres_scanner's
/// catalog cache), and the next read still sees new rows and new tables.
#[test]
#[ignore = "needs IXTABLE_TEST_POSTGRES_URL; CI runs it with --include-ignored"]
fn postgres_refresh_keeps_the_attachment_and_sees_writes_and_ddl() {
    let Some(mut h) = postgres_harness() else {
        return;
    };
    people(&mut h);
    h.reader.refresh().unwrap();
    // A rebuilt reader is a new in-memory DuckDB database without this table.
    h.reader
        .connection()
        .execute_batch("CREATE TABLE memory.main.refresh_marker(x INTEGER)")
        .unwrap();
    h.store
        .insert("people", &[nv("name", text("Ada"))])
        .unwrap();
    assert_eq!(rows(&mut h, "people").len(), 1);
    h.store
        .create_table(&CreateTable {
            name: "pets".into(),
            columns: vec![CreateColumn {
                primary_key_position: 1,
                nullable: false,
                ..col("id", "integer")
            }],
            ..Default::default()
        })
        .unwrap();
    h.reader.refresh().unwrap();
    assert!(h.reader.objects().unwrap().iter().any(|o| o.name == "pets"));
    h.store.insert("pets", &[nv("id", int(1))]).unwrap();
    assert_eq!(rows(&mut h, "pets"), vec![vec![int(1)]]);
    h.reader
        .connection()
        .execute_batch("SELECT * FROM memory.main.refresh_marker")
        .expect("refresh kept the same DuckDB database");
}
