//! SQLite-specific store behaviour (generated columns, rowid identity,
//! rebuild safety) and property tests carried over from the original data layer.
use super::conformance::{col, sqlite_harness};
use super::sqlite_ddl;
use crate::data::{AlterTable, CreateColumn, CreateTable, DataValue, NamedValue, Sort};
use base64::{engine::general_purpose::STANDARD, Engine};
use proptest::prelude::*;
use std::collections::BTreeSet;

fn nv(column: &str, value: DataValue) -> NamedValue {
    NamedValue {
        column: column.into(),
        value,
    }
}

#[test]
fn generated_columns_rowid_identity_and_legacy_declared_types() {
    let mut h = sqlite_harness();
    let c = rusqlite::Connection::open(h.reader.workspace.join("data.db")).unwrap();
    c.execute_batch("CREATE TABLE parent(a TEXT,b INTEGER,payload BLOB,computed TEXT GENERATED ALWAYS AS (a || b) STORED,PRIMARY KEY(a,b)); CREATE TABLE loose(label TEXT);").unwrap();
    let id = h
        .store
        .insert(
            "parent",
            &[
                nv("a", DataValue::Text("x".into())),
                nv("b", DataValue::Integer(2)),
                nv("payload", DataValue::Blob(STANDARD.encode([0, 255]))),
            ],
        )
        .unwrap();
    assert_eq!(id, vec![DataValue::Text("x".into()), DataValue::Integer(2)]);
    assert_eq!(
        h.store
            .update(
                "parent",
                &[nv("computed", DataValue::Text("bad".into()))],
                &id,
                None
            )
            .unwrap_err()
            .code,
        "VALIDATION_ERROR"
    );
    h.reader.refresh().unwrap();
    assert_eq!(
        h.reader
            .page("parent", 0, 10, &[], &[])
            .unwrap()
            .columns
            .len(),
        3,
        "DuckDB's sqlite scanner does not read generated columns"
    );
    assert!(h.reader.schema("parent").unwrap().columns[3].generated);
    let rowid = h
        .store
        .insert("loose", &[nv("label", DataValue::Text("r".into()))])
        .unwrap();
    assert_eq!(rowid, vec![DataValue::Integer(1)]);
    h.reader.refresh().unwrap();
    assert_eq!(
        h.reader.page("loose", 0, 10, &[], &[]).unwrap().identities,
        vec![rowid.clone()]
    );
    h.store.delete("loose", &rowid, None).unwrap();
    let legacy = CreateTable {
        name: "legacy".into(),
        columns: vec![CreateColumn {
            name: "n".into(),
            declared_type: "NUMERIC".into(),
            nullable: true,
            ..Default::default()
        }],
        ..Default::default()
    };
    h.store.create_table(&legacy).unwrap();
    let bad = CreateTable {
        name: "bad".into(),
        columns: vec![CreateColumn {
            name: "n".into(),
            declared_type: "MONEY".into(),
            nullable: true,
            ..Default::default()
        }],
        ..Default::default()
    };
    assert!(h.store.create_table(&bad).is_err());
    let wide = CreateTable {
        name: "wide".into(),
        columns: vec![col("n", "decimal(20,2)")],
        ..Default::default()
    };
    assert!(h
        .store
        .create_table(&wide)
        .unwrap_err()
        .message
        .contains("at most 15"));
    assert_eq!(
        h.store
            .create_table(&CreateTable {
                name: "_ixtable_x".into(),
                columns: vec![col("n", "text")],
                ..Default::default()
            })
            .unwrap_err()
            .code,
        "VALIDATION_ERROR"
    );
}

#[test]
fn rebuild_keeps_inbound_foreign_keys_indexes_and_rejects_orphans() {
    let mut h = sqlite_harness();
    let c = rusqlite::Connection::open(h.reader.workspace.join("data.db")).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY, label TEXT); CREATE INDEX p_label ON p(label); CREATE TABLE ch(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id)); INSERT INTO p VALUES (1,'a'),(2,NULL); INSERT INTO ch VALUES (1,1);").unwrap();
    let make_required = [AlterTable::AlterColumn {
        column: "label".into(),
        definition: CreateColumn {
            nullable: false,
            ..col("label", "text")
        },
    }];
    let plan = h.store.plan_alter("p", &make_required).unwrap();
    assert!(
        plan.rebuild
            && plan
                .statements
                .iter()
                .any(|s| s.contains("_ixtable_rebuild_p"))
    );
    let err = h.store.alter_table("p", &make_required).unwrap_err();
    assert_eq!(
        err.constraint,
        Some("not_null"),
        "row 2 has no label; the rebuild rolls back"
    );
    h.store
        .update(
            "p",
            &[nv("label", DataValue::Text("b".into()))],
            &[DataValue::Integer(2)],
            None,
        )
        .unwrap();
    h.store.alter_table("p", &make_required).unwrap();
    let def = h.store.table_def("p").unwrap();
    assert!(!def.column("label").unwrap().nullable);
    assert_eq!(def.indexes.len(), 1);
    assert_eq!(
        h.store.table_def("ch").unwrap().foreign_keys[0].target_table,
        "p"
    );
    assert_eq!(
        h.store
            .insert("ch", &[nv("pid", DataValue::Integer(9))])
            .unwrap_err()
            .constraint,
        Some("foreign_key")
    );
    let renamed = h
        .store
        .plan_alter(
            "p",
            &[
                AlterTable::RenameColumn {
                    column: "label".into(),
                    new_name: "title".into(),
                },
                AlterTable::DropColumn {
                    column: "title".into(),
                },
            ],
        )
        .unwrap();
    assert!(
        renamed.destructive && renamed.rebuild,
        "dropping an indexed column needs a rebuild"
    );
    let (_, statements, _) = sqlite_ddl::plan_changes(
        &c,
        "p",
        &[AlterTable::AddColumn {
            column: col("note", "text"),
        }],
    )
    .unwrap();
    assert_eq!(
        statements,
        vec!["ALTER TABLE \"p\" ADD COLUMN \"note\" TEXT".to_string()]
    );
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, max_shrink_iters: 512, ..ProptestConfig::default() })]

    /// Values survive a store write and a DuckDB read without narrowing.
    #[test]
    fn prop_scalar_round_trip(
        integer in any::<i64>(),
        text in any::<String>().prop_filter("no NUL", |s| !s.contains('\0')),
        blob in prop::collection::vec(any::<u8>(), 0..64),
        real in any::<f64>().prop_filter("finite", |v| v.is_finite())
    ) {
        let mut h = sqlite_harness();
        h.store.create_table(&CreateTable { name: "v".into(), columns: vec![CreateColumn { primary_key_position: 1, nullable: false, ..col("id", "integer") }, col("t", "text"), col("b", "blob"), col("r", "real")], ..Default::default() }).unwrap();
        let id = h.store.insert("v", &[nv("id", DataValue::Integer(integer)), nv("t", DataValue::Text(text.clone())), nv("b", DataValue::Blob(STANDARD.encode(&blob))), nv("r", DataValue::Real(real))]).unwrap();
        prop_assert_eq!(id, vec![DataValue::Integer(integer)]);
        h.reader.refresh().unwrap();
        let got = h.reader.page("v", 0, 1, &[], &[]).unwrap();
        prop_assert_eq!(&got.rows[0], &vec![DataValue::Integer(integer), DataValue::Text(text), DataValue::Blob(STANDARD.encode(blob)), DataValue::Real(real)]);
    }

    /// Hostile identifiers stay data; they never become executable SQL.
    #[test]
    fn prop_quoted_identifiers_are_safe(table in "[^\\x00]{1,16}", column in "[^\\x00]{1,16}") {
        prop_assume!(!table.trim().is_empty() && !column.trim().is_empty());
        let mut h = sqlite_harness();
        h.store.create_table(&CreateTable { name: "sentinel".into(), columns: vec![col("v", "integer")], ..Default::default() }).unwrap();
        if h.store.create_table(&CreateTable { name: table.clone(), columns: vec![col(&column, "text")], ..Default::default() }).is_ok() {
            h.store.insert(&table, &[nv(&column, DataValue::Text("payload".into()))]).unwrap();
            h.reader.refresh().unwrap();
            prop_assert_eq!(&h.reader.page(&table, 0, 10, &[], &[]).unwrap().rows[0][0], &DataValue::Text("payload".into()));
        }
        prop_assert!(h.store.table_def("sentinel").is_ok());
    }

    /// Ties in user sorts are broken by the composite identity.
    #[test]
    fn prop_composite_identity_stabilizes_pagination(input in prop::collection::vec(("[a-z]{1,4}", -50i64..50), 0..30), descending in any::<bool>()) {
        let unique = input.into_iter().collect::<BTreeSet<_>>();
        let mut h = sqlite_harness();
        h.store.create_table(&CreateTable { name: "k".into(), columns: vec![CreateColumn { primary_key_position: 1, nullable: false, ..col("a", "text") }, CreateColumn { primary_key_position: 2, nullable: false, ..col("b", "integer") }], ..Default::default() }).unwrap();
        for (a, b) in unique.iter().rev() {
            h.store.insert("k", &[nv("a", DataValue::Text(a.clone())), nv("b", DataValue::Integer(*b))]).unwrap();
        }
        h.reader.refresh().unwrap();
        let sorts = [Sort { column: "a".into(), descending }];
        let first = h.reader.page("k", 0, 100, &sorts, &[]).unwrap();
        let observed: Vec<(String, i64)> = first.identities.iter().map(|id| match (&id[0], &id[1]) { (DataValue::Text(a), DataValue::Integer(b)) => (a.clone(), *b), _ => unreachable!() }).collect();
        let mut expected = unique.into_iter().collect::<Vec<_>>();
        expected.sort_by(|l, r| (if descending { r.0.cmp(&l.0) } else { l.0.cmp(&r.0) }).then_with(|| l.1.cmp(&r.1)));
        prop_assert_eq!(observed, expected);
    }

    /// A stale identity never changes another record.
    #[test]
    fn prop_stale_identity_never_mutates_rows(original in any::<i64>(), stale in any::<i64>(), replacement in any::<i64>()) {
        prop_assume!(original != stale);
        let mut h = sqlite_harness();
        h.store.create_table(&CreateTable { name: "i".into(), columns: vec![CreateColumn { primary_key_position: 1, nullable: false, ..col("id", "integer") }, CreateColumn { nullable: false, ..col("v", "integer") }], ..Default::default() }).unwrap();
        h.store.insert("i", &[nv("id", DataValue::Integer(original)), nv("v", DataValue::Integer(original))]).unwrap();
        prop_assert_eq!(h.store.update("i", &[nv("v", DataValue::Integer(replacement))], &[DataValue::Integer(stale)], None).unwrap_err().code, "STALE_ROW");
        h.reader.refresh().unwrap();
        prop_assert_eq!(&h.reader.page("i", 0, 10, &[], &[]).unwrap().rows[0][1], &DataValue::Integer(original));
    }
}
