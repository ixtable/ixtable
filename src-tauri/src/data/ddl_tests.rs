use super::ddl::*;

#[test]
fn parses_generated_and_hand_written_sqlite_tables() {
    let t = parse_sqlite_create_table(
        r#"CREATE TABLE "order lines" (
          "order" INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          line INTEGER NOT NULL,
          price DECIMAL(10,2) CONSTRAINT "ixt_type_price" CHECK ("price" IS NULL OR typeof("price") IN ('integer','real')) DEFAULT 0,
          note TEXT DEFAULT 'it''s' COLLATE NOCASE UNIQUE,
          created TIMESTAMP DEFAULT (CURRENT_TIMESTAMP),
          total REAL GENERATED ALWAYS AS (price * 2) STORED,
          -- a comment, with a comma
          CONSTRAINT pk PRIMARY KEY ("order", line),
          UNIQUE (line, note),
          CONSTRAINT positive CHECK (price >= 0),
          FOREIGN KEY (line) REFERENCES "lines" ("id") ON UPDATE SET NULL ON DELETE RESTRICT
        ) WITHOUT ROWID"#,
    )
    .unwrap();
    assert_eq!(t.name, "order lines");
    assert!(t.without_rowid);
    assert_eq!(t.primary_key, vec!["order", "line"]);
    assert_eq!(t.primary_key_name.as_deref(), Some("pk"));
    assert_eq!(t.columns.len(), 6);
    assert_eq!(t.columns[2].declared_type, "DECIMAL(10,2)");
    assert_eq!(t.columns[2].default_expression.as_deref(), Some("0"));
    assert_eq!(t.columns[3].default_expression.as_deref(), Some("'it''s'"));
    assert_eq!(
        t.columns[4].default_expression.as_deref(),
        Some("(CURRENT_TIMESTAMP)")
    );
    assert_eq!(
        t.columns[5].generated_expression.as_deref(),
        Some("price * 2")
    );
    assert!(!t.columns[0].nullable);
    assert_eq!(t.checks.len(), 1, "logical-type checks are not user checks");
    assert_eq!(t.checks[0].expression, "price >= 0");
    assert_eq!(t.uniques.len(), 2);
    assert_eq!(t.foreign_keys.len(), 2);
    assert_eq!(t.foreign_keys[0].on_delete, "CASCADE");
    assert_eq!(t.foreign_keys[1].on_update, "SET NULL");
    assert_eq!(t.foreign_keys[1].on_delete, "RESTRICT");
    assert_eq!(t.foreign_keys[1].target_table, "lines");
}

#[test]
fn parses_autoincrement_and_indexes() {
    let t = parse_sqlite_create_table(
        "CREATE TABLE item(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL DEFAULT 'new')",
    )
    .unwrap();
    assert!(t.autoincrement);
    assert_eq!(t.primary_key, vec!["id"]);
    let i = parse_sqlite_create_index(
        r#"CREATE UNIQUE INDEX IF NOT EXISTS "by label" ON item ("label" COLLATE NOCASE, id DESC)"#,
    )
    .unwrap();
    assert!(i.unique);
    assert_eq!(i.name, "by label");
    assert_eq!(i.columns, vec!["label", "id"]);
}

#[test]
fn rowid_alias_is_marked_auto_increment_only_for_integer_primary_keys() {
    let auto = |sql: &str| {
        let mut def = parse_sqlite_create_table(sql).unwrap();
        super::read::mark_rowid_alias(&mut def);
        super::TableSchema::from_def(def, "table".into()).columns[0].auto_increment
    };
    assert!(auto("CREATE TABLE a (id integer PRIMARY KEY, n TEXT)"));
    assert!(!auto("CREATE TABLE b (id BIGINT PRIMARY KEY, n TEXT)"));
    assert!(!auto(
        "CREATE TABLE c (id INTEGER, n TEXT, PRIMARY KEY (id, n))"
    ));
    assert!(!auto(
        "CREATE TABLE d (id INTEGER PRIMARY KEY, n TEXT) WITHOUT ROWID"
    ));
}
