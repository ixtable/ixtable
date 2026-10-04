//! Conformance scenarios (continued): optimistic concurrency, schema changes, migrations.
use super::conformance::{col, each_store, int, nv, people, rows, text, Harness};
use super::{ChangeMode, CreateIndex};
use crate::data::{AlterTable, CreateColumn, DataValue, LogicalType};
use crate::migrations::{self, Migration};

#[test]
fn optimistic_updates_reject_stale_original_values() {
    each_store(|h| {
        people(h);
        h.store
            .insert(
                "people",
                &[
                    nv("id", int(1)),
                    nv("name", text("Ada")),
                    nv("score", DataValue::Real(1.0)),
                ],
            )
            .unwrap();
        let original = [nv("name", text("Ada")), nv("score", DataValue::Real(1.0))];
        h.store
            .update(
                "people",
                &[nv("score", DataValue::Real(2.0))],
                &[int(1)],
                Some(&original),
            )
            .unwrap();
        let stale = h
            .store
            .update(
                "people",
                &[nv("name", text("Eve"))],
                &[int(1)],
                Some(&original),
            )
            .unwrap_err();
        assert_eq!(stale.code, "CONFLICT", "{}", h.name);
        assert!(
            stale.message.contains("score is now 2"),
            "{}: {}",
            h.name,
            stale.message
        );
        assert_eq!(rows(h, "people")[0][1], text("Ada"));
        let gone = h
            .store
            .delete("people", &[int(9)], Some(&original))
            .unwrap_err();
        assert_eq!(gone.code, "STALE_ROW");
    });
}

/// The write-time policy check (`resolve_expected`) in front of each store, as
/// `update_row`, `delete_row`, and `execute_write_batch` apply it.
#[test]
fn concurrency_policies_apply_at_write_time() {
    use super::commands::resolve_expected;
    each_store(|h| {
        people(h);
        h.store
            .insert("people", &[nv("id", int(1)), nv("name", text("Ada"))])
            .unwrap();
        let original = vec![nv("name", text("Ada"))];
        // Optimistic (and unresolved) entities reject writes without original values.
        for policy in [Some("optimistic"), Some("customAction"), None] {
            let missing = resolve_expected(policy, "people", None).unwrap_err();
            assert_eq!(missing.code, "EXPECTED_REQUIRED", "{}", h.name);
            let empty = resolve_expected(policy, "people", Some(vec![])).unwrap_err();
            assert_eq!(empty.code, "EXPECTED_REQUIRED");
        }
        // Optimistic: a stale original value conflicts.
        let expected = resolve_expected(Some("optimistic"), "people", Some(original.clone()))
            .unwrap()
            .unwrap();
        h.store
            .update(
                "people",
                &[nv("name", text("Bea"))],
                &[int(1)],
                Some(&expected),
            )
            .unwrap();
        let stale = h
            .store
            .update(
                "people",
                &[nv("name", text("Eve"))],
                &[int(1)],
                Some(&expected),
            )
            .unwrap_err();
        assert_eq!(stale.code, "CONFLICT", "{}", h.name);
        assert_eq!(rows(h, "people")[0][1], text("Bea"));
        // Last write wins: the stale original values are dropped and the write lands.
        let lww =
            resolve_expected(Some("lastWriteWins"), "people", Some(original.clone())).unwrap();
        assert!(lww.is_none());
        assert_eq!(
            h.store
                .update(
                    "people",
                    &[nv("name", text("Eve"))],
                    &[int(1)],
                    lww.as_deref()
                )
                .unwrap(),
            1
        );
        assert_eq!(rows(h, "people")[0][1], text("Eve"));
        let none = resolve_expected(Some("lastWriteWins"), "people", None).unwrap();
        assert_eq!(
            h.store
                .delete("people", &[int(1)], none.as_deref())
                .unwrap(),
            1
        );
        assert!(rows(h, "people").is_empty());
    });
}

#[test]
fn schema_changes_publish_store_specific_modes_and_keep_data() {
    each_store(|h| {
        people(h);
        h.store
            .insert(
                "people",
                &[
                    nv("id", int(1)),
                    nv("name", text("Ada")),
                    nv("score", DataValue::Real(4.0)),
                ],
            )
            .unwrap();
        let ops = [
            AlterTable::RenameColumn {
                column: "score".into(),
                new_name: "points".into(),
            },
            AlterTable::AlterColumn {
                column: "points".into(),
                definition: CreateColumn {
                    nullable: false,
                    ..col("points", "decimal(8,1)")
                },
            },
            AlterTable::AddUnique {
                columns: vec!["name".into()],
                name: Some("people_name_key".into()),
            },
            AlterTable::AddColumn {
                column: CreateColumn {
                    default_expression: Some("'new'".into()),
                    ..col("status", "text")
                },
            },
        ];
        let plan = h.store.plan_alter("people", &ops).unwrap();
        let expected_mode = if h.name == "sqlite" {
            ChangeMode::Rebuild
        } else {
            ChangeMode::InPlace
        };
        assert_eq!(plan.operations[0].mode, ChangeMode::InPlace);
        assert_eq!(plan.operations[1].mode, expected_mode, "{}", h.name);
        assert_eq!(plan.rebuild, h.name == "sqlite");
        h.store.alter_table("people", &ops).unwrap();
        assert_eq!(
            rows(h, "people"),
            vec![vec![
                int(1),
                text("Ada"),
                DataValue::Decimal("4.0".into()),
                text("new")
            ]],
            "{}",
            h.name
        );
        let dup = h
            .store
            .insert(
                "people",
                &[
                    nv("id", int(2)),
                    nv("name", text("Ada")),
                    nv("points", int(1)),
                ],
            )
            .unwrap_err();
        assert_eq!(dup.constraint, Some("unique"), "{}", h.name);
        h.store
            .create_index(&CreateIndex {
                name: "people_points".into(),
                table: "people".into(),
                columns: vec!["points".into(), "status".into()],
                unique: false,
            })
            .unwrap();
        let indexes = h.store.list_indexes(Some("people")).unwrap();
        assert!(
            indexes
                .iter()
                .any(|i| i.name == "people_points" && i.columns.len() == 2),
            "{}: {indexes:?}",
            h.name
        );
        h.store
            .alter_table(
                "people",
                &[AlterTable::RenameTable {
                    new_name: "members".into(),
                }],
            )
            .unwrap();
        h.reader.refresh().unwrap();
        assert_eq!(
            h.reader.schema("members").unwrap().indexes.len(),
            1,
            "{}",
            h.name
        );
        h.store.drop_index("people_points").unwrap();
        h.store.drop_table("members").unwrap();
        h.reader.refresh().unwrap();
        assert!(h.reader.objects().unwrap().is_empty(), "{}", h.name);
    });
}

#[test]
fn migrations_apply_record_and_roll_back_transactionally() {
    each_store(|h| {
        let m1 = Migration { id: "m1".into(), name: "Create items".into(), order: 1, up: "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO items (id, label) VALUES (1, 'one');".into(), down: Some("DROP TABLE items;".into()), reversible: true, ..Default::default() };
        let bad = Migration { id: "m2".into(), name: "Broken".into(), order: 2, up: "INSERT INTO items (id, label) VALUES (2, 'two'); INSERT INTO items (id, label) VALUES (3, NULL);".into(), ..Default::default() };
        let all = [m1.clone(), bad.clone()];
        assert_eq!(
            migrations::pending_in(h.store.as_mut(), &all)
                .unwrap()
                .len(),
            2
        );
        let ok = migrations::run_one(h.store.as_mut(), &m1, false, None);
        assert_eq!(ok.status, "applied", "{}: {:?}", h.name, ok.error);
        let failed = migrations::run_one(h.store.as_mut(), &bad, false, Some("cp1"));
        assert_eq!(failed.status, "failed");
        assert!(failed.recovery.unwrap().contains("cp1"));
        assert_eq!(
            rows(h, "items").len(),
            1,
            "{}: failed migration rolled back",
            h.name
        );
        let pending = migrations::pending_in(h.store.as_mut(), &all).unwrap();
        assert_eq!(
            pending.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m2"]
        );
        let statuses: Vec<String> = migrations::history(h.store.as_mut())
            .unwrap()
            .into_iter()
            .map(|l| l.status)
            .collect();
        assert_eq!(statuses, vec!["applied", "failed"]);
        assert!(h
            .store
            .run_script("CREATE TABLE scratch (x INTEGER)", &[], true)
            .is_ok());
        h.reader.refresh().unwrap();
        assert!(
            h.reader
                .objects()
                .unwrap()
                .iter()
                .all(|o| o.name != "scratch" && !o.name.starts_with("_ixtable_")),
            "{}: dry run left no trace",
            h.name
        );
        let back = migrations::run_one(h.store.as_mut(), &m1, true, None);
        assert_eq!(back.status, "rolled_back", "{}: {:?}", h.name, back.error);
        h.reader.refresh().unwrap();
        assert!(h.reader.objects().unwrap().is_empty());
        assert_eq!(LogicalType::Integer, "integer".parse().unwrap());
    });
}

#[test]
fn altering_a_column_keeps_replaces_or_removes_its_check() {
    each_store(|h| {
        h.store
            .create_table(&crate::data::CreateTable {
                name: "stock".into(),
                columns: vec![
                    CreateColumn {
                        primary_key_position: 1,
                        nullable: false,
                        ..col("id", "integer")
                    },
                    CreateColumn {
                        check: Some("qty > 0".into()),
                        ..col("qty", "integer")
                    },
                ],
                ..Default::default()
            })
            .unwrap();
        let mut next_id = 0;
        let mut accepts = |h: &mut Harness, qty: i64| {
            next_id += 1;
            h.store
                .insert("stock", &[nv("id", int(next_id)), nv("qty", int(qty))])
                .is_ok()
        };
        let alter = |h: &mut Harness, check: Option<String>| {
            h.store
                .alter_table(
                    "stock",
                    &[AlterTable::AlterColumn {
                        column: "qty".into(),
                        definition: CreateColumn {
                            nullable: false,
                            check,
                            ..col("qty", "integer")
                        },
                    }],
                )
                .unwrap();
        };
        // The designer sends the check back exactly as the store reports it.
        let reported = h.store.table_def("stock").unwrap().checks[0]
            .expression
            .clone();
        alter(h, Some(reported));
        assert_eq!(h.store.table_def("stock").unwrap().checks.len(), 1);
        assert!(!accepts(h, 0), "{}: check kept", h.name);
        assert!(accepts(h, 1), "{}", h.name);
        alter(h, Some("qty < 100".into()));
        assert_eq!(h.store.table_def("stock").unwrap().checks.len(), 1);
        assert!(!accepts(h, 100), "{}: check replaced", h.name);
        assert!(accepts(h, 0), "{}: old check gone", h.name);
        alter(h, None);
        assert!(!accepts(h, 100), "{}: no check given keeps it", h.name);
        alter(h, Some(String::new()));
        assert!(h.store.table_def("stock").unwrap().checks.is_empty());
        assert!(accepts(h, 500), "{}: check removed", h.name);
        let staged = |check: &str| AlterTable::AlterColumn {
            column: "qty".into(),
            definition: CreateColumn {
                nullable: false,
                check: Some(check.into()),
                ..col("qty", "integer")
            },
        };
        h.store
            .alter_table("stock", &[staged("qty < 1000"), staged("qty < 600")])
            .unwrap_or_else(|e| panic!("{}: {e:?}", h.name));
        assert_eq!(h.store.table_def("stock").unwrap().checks.len(), 1);
        assert!(!accepts(h, 700), "{}: second staged check wins", h.name);
        assert!(accepts(h, 599), "{}", h.name);
    });
}
