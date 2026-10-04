// Runtime authorization tests (included from authz.rs).
use super::*;
use crate::manager::DocumentManager;
use crate::roles::{ObjectPermission, Permissions};
use serde_json::json;

fn grant(kind: &str, id: &str, flags: &[Op]) -> ObjectPermission {
    ObjectPermission {
        kind: kind.into(),
        id: id.into(),
        read: flags.contains(&Op::Read),
        create: flags.contains(&Op::Create),
        update: flags.contains(&Op::Update),
        delete: flags.contains(&Op::Delete),
    }
}

fn role(objects: Vec<ObjectPermission>, actions: &[&str]) -> Role {
    Role {
        id: "clerk".into(),
        name: "Clerk".into(),
        permissions: Permissions {
            navigation: vec!["nav-1".into()],
            objects,
            actions: actions.iter().map(|a| a.to_string()).collect(),
        },
    }
}

/// Forms on `orders` (with a customer lookup, an order-lines related list, and
/// an options query) and on a query; a report on `invoices` with a table query.
fn config() -> DocumentConfig {
    let mut config = DocumentConfig::default();
    config.design.forms = serde_json::from_value(json!([
        {
            "id": "f-orders", "name": "Orders",
            "source": {"kind": "table", "table": "orders"},
            "controls": [
                {"id": "c1", "kind": "relationship", "label": "Customer",
                 "relationship": {"table": "customers", "valueColumn": "id", "displayColumn": "name"}},
                {"id": "c2", "kind": "relatedList", "label": "Lines",
                 "related": {"table": "order_lines", "foreignKey": "order_id", "parentColumn": "id"}},
                {"id": "c3", "kind": "select", "label": "Status", "optionsQueryId": "q-status"}
            ]
        },
        {"id": "f-summary", "name": "Summary", "source": {"kind": "query", "queryId": "q-summary"}}
    ]))
    .unwrap();
    config.reports = serde_json::from_value(json!([{
        "id": "r-invoices", "name": "Invoices", "table": "invoices",
        "bands": {"detail": {"height": 10, "components": [
            {"id": "t1", "kind": "table", "x": 0, "y": 0, "w": 10, "h": 10, "queryId": "q-lines"}
        ]}}
    }]))
    .unwrap();
    config
}

fn no_fk(_: &str) -> Vec<String> {
    vec![]
}

#[test]
fn explicit_grants_mirror_the_frontend_can() {
    let c = config();
    let r = role(
        vec![grant("table", "notes", &[Op::Read, Op::Create])],
        &["act-1"],
    );
    assert!(allows(&c, &r, "table", "notes", Op::Read, &no_fk));
    assert!(allows(&c, &r, "table", "notes", Op::Create, &no_fk));
    assert!(!allows(&c, &r, "table", "notes", Op::Update, &no_fk));
    assert!(!allows(&c, &r, "table", "notes", Op::Delete, &no_fk));
    assert!(!allows(&c, &r, "table", "other", Op::Read, &no_fk));
    assert!(allows(&c, &r, "navigation", "nav-1", Op::Read, &no_fk));
    assert!(allows(&c, &r, "action", "act-1", Op::Execute, &no_fk));
    assert!(!allows(&c, &r, "action", "act-1", Op::Read, &no_fk));
    assert!(!allows(&c, &r, "action", "act-2", Op::Execute, &no_fk));
    assert!(!allows(&c, &deny_all(), "table", "notes", Op::Read, &no_fk));
}

#[test]
fn a_form_grants_its_source_table_lookups_related_lists_and_queries() {
    let c = config();
    let r = role(
        vec![grant(
            "form",
            "f-orders",
            &[Op::Read, Op::Create, Op::Update],
        )],
        &[],
    );
    for op in [Op::Read, Op::Create, Op::Update] {
        assert!(allows(&c, &r, "table", "orders", op, &no_fk), "{op:?}");
    }
    assert!(!allows(&c, &r, "table", "orders", Op::Delete, &no_fk));
    // Lookups and related lists are readable, not writable.
    for table in ["customers", "order_lines"] {
        assert!(allows(&c, &r, "table", table, Op::Read, &no_fk), "{table}");
        assert!(
            !allows(&c, &r, "table", table, Op::Create, &no_fk),
            "{table}"
        );
    }
    assert!(allows(&c, &r, "query", "q-status", Op::Read, &no_fk));
    assert!(!allows(&c, &r, "query", "q-summary", Op::Read, &no_fk));
    assert!(!allows(&c, &r, "table", "invoices", Op::Read, &no_fk));
    // Foreign-key targets of readable tables show as list lookups.
    let fk = |t: &str| {
        if t == "orders" {
            vec!["regions".to_string()]
        } else {
            vec![]
        }
    };
    assert!(allows(&c, &r, "table", "regions", Op::Read, &fk));
    assert!(!allows(&c, &r, "table", "regions", Op::Update, &fk));
    // A query-sourced form grants its query.
    let q = role(vec![grant("form", "f-summary", &[Op::Read])], &[]);
    assert!(allows(&c, &q, "query", "q-summary", Op::Read, &no_fk));
    assert!(!allows(&c, &q, "table", "orders", Op::Read, &no_fk));
}

#[test]
fn a_report_grants_its_dataset_and_table_queries_for_reading_only() {
    let c = config();
    let r = role(vec![grant("report", "r-invoices", &[Op::Read])], &[]);
    assert!(allows(&c, &r, "report", "r-invoices", Op::Read, &no_fk));
    assert!(allows(&c, &r, "table", "invoices", Op::Read, &no_fk));
    assert!(!allows(&c, &r, "table", "invoices", Op::Create, &no_fk));
    assert!(allows(&c, &r, "query", "q-lines", Op::Read, &no_fk));
    assert!(!allows(
        &c,
        &deny_all(),
        "report",
        "r-invoices",
        Op::Read,
        &no_fk
    ));
}

fn session() -> (DocumentManager, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!("ixtable-authz-{}", uuid::Uuid::new_v4()));
    let m = DocumentManager::new(base.join("data"), base.join("cache")).unwrap();
    m.new_session("w").unwrap();
    m.with_session("w", |s| {
        s.doc.config.design.forms = config().design.forms;
        s.doc.config.reports = config().reports;
        s.doc.config.roles = vec![role(
            vec![
                grant("form", "f-orders", &[Op::Read, Op::Create]),
                grant("query", "q-open", &[Op::Read]),
            ],
            &[],
        )];
        Ok(())
    })
    .unwrap();
    (m, base)
}

#[test]
fn sessions_are_unrestricted_until_a_role_is_previewed_and_guard_every_command_family() {
    let (m, base) = session();
    let check =
        |kind: &str, id: &str, op: Op| m.with_session("w", |s| check_session(s, kind, id, op));
    let adhoc = || m.with_session("w", |s| unrestricted_session(s, "run ad hoc SQL"));
    // Developer: everything.
    assert!(check("table", "secrets", Op::Delete).is_ok());
    assert!(adhoc().is_ok());
    m.with_session("w", |s| preview_role(s, Some("clerk".into())))
        .unwrap();
    // insert_row / update_row / delete_row / execute_write_batch.
    assert!(check("table", "orders", Op::Create).is_ok());
    let e = check("table", "orders", Op::Delete).unwrap_err();
    assert_eq!(e.code, "FORBIDDEN");
    assert!(e.message.contains("Clerk") && e.message.contains("orders"));
    assert_eq!(
        check("table", "secrets", Op::Create).unwrap_err().code,
        "FORBIDDEN"
    );
    // read_table_page.
    assert!(check("table", "customers", Op::Read).is_ok());
    assert_eq!(
        check("table", "secrets", Op::Read).unwrap_err().code,
        "FORBIDDEN"
    );
    // run_saved_query.
    assert!(check("query", "q-open", Op::Read).is_ok());
    assert_eq!(
        check("query", "q-other", Op::Read).unwrap_err().code,
        "FORBIDDEN"
    );
    // write_report_pdf.
    assert_eq!(
        check("report", "r-invoices", Op::Read).unwrap_err().code,
        "FORBIDDEN"
    );
    // execute_read_query / execute_parameterized_query / export_attachment.
    assert_eq!(adhoc().unwrap_err().code, "FORBIDDEN");
    // An unknown role is allowed nothing; ending the preview restores access.
    m.with_session("w", |s| preview_role(s, Some("ghost".into())))
        .unwrap();
    assert_eq!(
        check("table", "orders", Op::Read).unwrap_err().code,
        "FORBIDDEN"
    );
    m.with_session("w", |s| preview_role(s, None)).unwrap();
    assert!(check("table", "secrets", Op::Delete).is_ok());
    assert!(adhoc().is_ok());
    // A trusted assignment: Unrestricted for the owner, or a role.
    m.with_session("w", |s| {
        s.access = Access::Role(deny_all());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        check("table", "orders", Op::Read).unwrap_err().code,
        "FORBIDDEN"
    );
    m.with_session("w", |s| {
        s.access = Access::Unrestricted;
        Ok(())
    })
    .unwrap();
    assert!(check("table", "orders", Op::Read).is_ok());
    let _ = m.close("w", true);
    let _ = std::fs::remove_dir_all(base);
}
