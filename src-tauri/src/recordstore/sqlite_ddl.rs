//! SQLite DDL: table creation, in-place alters, the transactional table
//! rebuild for changes SQLite cannot make in place, impact, and health checks.
use super::{
    model::*,
    plan::{self, Applied},
    sqlite::{self, se},
};
use crate::data::{
    q, AlterTable, ColumnDef, IndexDef, LogicalType, TableDef, SQLITE_MAX_DECIMAL_PRECISION,
};
use rusqlite::Connection;

fn is_literal(expr: &str) -> bool {
    let e = expr.trim();
    let upper = e.to_ascii_uppercase();
    (e.starts_with('\'') && e.ends_with('\''))
        || (e.starts_with('(') && e.ends_with(')'))
        || e.trim_start_matches(['-', '+']).parse::<f64>().is_ok()
        || matches!(
            upper.as_str(),
            "NULL" | "TRUE" | "FALSE" | "CURRENT_TIME" | "CURRENT_DATE" | "CURRENT_TIMESTAMP"
        )
}
fn render_default(expr: &str) -> String {
    if is_literal(expr) {
        expr.trim().into()
    } else {
        format!("({})", expr.trim())
    }
}
fn check_precision(c: &ColumnDef) -> Result<(), StoreError> {
    if let LogicalType::Decimal {
        precision: Some(p), ..
    } = c.logical_type
    {
        if p > SQLITE_MAX_DECIMAL_PRECISION {
            return Err(StoreError::validation(format!(
                "SQLite stores at most {SQLITE_MAX_DECIMAL_PRECISION} significant digits; {} uses decimal({p},…). Use PostgreSQL or a smaller precision.",
                c.name
            )));
        }
    }
    Ok(())
}
pub fn column_sql(c: &ColumnDef, inline_key: Option<&str>) -> String {
    let mut out = format!("{} {}", q(&c.name), c.declared_type);
    if let Some(key) = inline_key {
        out.push(' ');
        out.push_str(key);
    }
    if !c.nullable {
        out.push_str(" NOT NULL");
    }
    if let Some(d) = &c.default_expression {
        out.push_str(" DEFAULT ");
        out.push_str(&render_default(d));
    }
    if let Some(g) = &c.generated_expression {
        out.push_str(&format!(" GENERATED ALWAYS AS ({g})"));
    }
    if let Some(check) = c.logical_type.sqlite_check(&c.name) {
        out.push_str(&format!(
            " CONSTRAINT {} CHECK ({check})",
            q(&LogicalType::sqlite_check_name(&c.name))
        ));
    }
    out
}
fn named(name: &Option<String>) -> String {
    name.as_deref()
        .map(|n| format!("CONSTRAINT {} ", q(n)))
        .unwrap_or_default()
}
fn cols(list: &[String]) -> String {
    list.iter().map(|c| q(c)).collect::<Vec<_>>().join(",")
}
pub fn create_table_sql(def: &TableDef, name: &str) -> Result<String, StoreError> {
    let mut parts = vec![];
    let inline = def.autoincrement && def.primary_key.len() == 1;
    for c in &def.columns {
        check_precision(c)?;
        let key = (inline && c.name == def.primary_key[0]).then_some("PRIMARY KEY AUTOINCREMENT");
        parts.push(column_sql(c, key));
    }
    if !def.primary_key.is_empty() && !inline {
        parts.push(format!(
            "{}PRIMARY KEY ({})",
            named(&def.primary_key_name),
            cols(&def.primary_key)
        ));
    }
    for u in &def.uniques {
        parts.push(format!("{}UNIQUE ({})", named(&u.name), cols(&u.columns)));
    }
    for c in &def.checks {
        parts.push(format!("{}CHECK ({})", named(&c.name), c.expression));
    }
    for f in &def.foreign_keys {
        parts.push(format!(
            "{}FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
            named(&f.name),
            cols(&f.columns),
            q(&f.target_table),
            cols(&f.target_columns),
            f.on_update,
            f.on_delete
        ));
    }
    Ok(format!(
        "CREATE TABLE {} ({}){}",
        q(name),
        parts.join(", "),
        if def.without_rowid {
            " WITHOUT ROWID"
        } else {
            ""
        }
    ))
}
pub fn index_sql(i: &IndexDef, table: &str) -> String {
    format!(
        "CREATE {}INDEX {} ON {} ({})",
        if i.unique { "UNIQUE " } else { "" },
        q(&i.name),
        q(table),
        cols(&i.columns)
    )
}

/// Whether SQLite can perform an operation without recreating the table.
pub fn classify(op: &AlterTable, def: &TableDef) -> (ChangeMode, Option<String>) {
    let rebuild = |why: &str| (ChangeMode::Rebuild, Some(why.to_string()));
    match op {
        AlterTable::RenameTable { .. } | AlterTable::RenameColumn { .. } => {
            (ChangeMode::InPlace, None)
        }
        AlterTable::AddColumn { column } => {
            let constant = column.default_expression.as_deref().map(|d| {
                let u = d.trim().to_ascii_uppercase();
                is_literal(d) && !d.trim().starts_with('(') && !u.starts_with("CURRENT_")
            });
            if column.unique || column.primary_key_position > 0 {
                rebuild("SQLite cannot add a unique or key column in place")
            } else if !column.nullable && constant != Some(true) {
                rebuild("A required column needs a constant default to be added in place")
            } else if constant == Some(false) {
                rebuild("SQLite cannot add a column with an expression default in place")
            } else {
                (ChangeMode::InPlace, None)
            }
        }
        AlterTable::DropColumn { column } => {
            let has = |list: &[String]| list.iter().any(|c| c.eq_ignore_ascii_case(column));
            let referenced = def.uniques.iter().any(|u| has(&u.columns))
                || def.foreign_keys.iter().any(|f| has(&f.columns))
                || def.indexes.iter().any(|i| has(&i.columns))
                || def
                    .checks
                    .iter()
                    .any(|c| plan::mentions(&c.expression, column))
                || def.columns.iter().any(|c| {
                    c.generated_expression
                        .as_deref()
                        .is_some_and(|g| plan::mentions(g, column))
                });
            if referenced {
                rebuild("The column is constrained, indexed, or referenced")
            } else {
                (ChangeMode::InPlace, None)
            }
        }
        _ => rebuild("SQLite recreates the table to change constraints or column definitions"),
    }
}

fn in_place_sql(op: &AlterTable, table: &str, def_after: &TableDef) -> Vec<String> {
    match op {
        AlterTable::RenameTable { new_name } => {
            vec![format!(
                "ALTER TABLE {} RENAME TO {}",
                q(table),
                q(new_name)
            )]
        }
        AlterTable::RenameColumn { column, new_name } => vec![format!(
            "ALTER TABLE {} RENAME COLUMN {} TO {}",
            q(table),
            q(column),
            q(new_name)
        )],
        AlterTable::AddColumn { column } => {
            let col = def_after.column(&column.name).cloned();
            let mut out = vec![format!(
                "ALTER TABLE {} ADD COLUMN {}",
                q(table),
                col.as_ref()
                    .map(|c| column_sql(c, None))
                    .unwrap_or_default()
            )];
            if let Some(check) = column.check.as_deref().filter(|c| !c.trim().is_empty()) {
                out[0].push_str(&format!(" CHECK ({check})"));
            }
            out
        }
        AlterTable::DropColumn { column } => {
            vec![format!(
                "ALTER TABLE {} DROP COLUMN {}",
                q(table),
                q(column)
            )]
        }
        _ => vec![],
    }
}

fn rebuild_sql(
    original: &TableDef,
    applied: &Applied,
    triggers: &[String],
) -> Result<Vec<String>, StoreError> {
    let tmp = format!("_ixtable_rebuild_{}", original.name);
    let mut out = vec![create_table_sql(&applied.def, &tmp)?];
    let pairs: Vec<(&ColumnDef, &String)> = applied
        .def
        .columns
        .iter()
        .zip(&applied.sources)
        .filter(|(c, _)| c.generated_expression.is_none())
        .filter_map(|(c, s)| s.as_ref().map(|s| (c, s)))
        .filter(|(_, s)| {
            original
                .column(s)
                .is_some_and(|c| c.generated_expression.is_none())
        })
        .collect();
    if !pairs.is_empty() {
        out.push(format!(
            "INSERT INTO {} ({}) SELECT {} FROM {}",
            q(&tmp),
            pairs
                .iter()
                .map(|(c, _)| q(&c.name))
                .collect::<Vec<_>>()
                .join(","),
            pairs
                .iter()
                .map(|(_, s)| q(s))
                .collect::<Vec<_>>()
                .join(","),
            q(&original.name)
        ));
    }
    out.push(format!("DROP TABLE {}", q(&original.name)));
    out.push(format!(
        "ALTER TABLE {} RENAME TO {}",
        q(&tmp),
        q(&original.name)
    ));
    for i in &applied.def.indexes {
        out.push(index_sql(i, &original.name));
    }
    out.extend(triggers.iter().cloned());
    Ok(out)
}

/// Plans `ops` on `table`: per-operation mode and the SQL that would run.
pub fn plan_changes(
    c: &Connection,
    table: &str,
    ops: &[AlterTable],
) -> Result<(ChangePlan, Vec<String>, bool), StoreError> {
    let original = sqlite::table_def(c, table)?;
    let applied = plan::apply_ops(&original, ops, classify).map_err(StoreError::validation)?;
    for col in &applied.def.columns {
        check_precision(col)?;
    }
    let rebuild = applied
        .operations
        .iter()
        .any(|o| o.mode == ChangeMode::Rebuild);
    let mut statements = vec![];
    if rebuild {
        let mut s = c
            .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?1 AND sql IS NOT NULL")
            .map_err(se)?;
        let triggers = s
            .query_map([table], |r| r.get::<_, String>(0))
            .map_err(se)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(se)?;
        statements = rebuild_sql(&original, &applied, &triggers)?;
        if let Some(new_name) = &applied.rename_to {
            statements.push(format!(
                "ALTER TABLE {} RENAME TO {}",
                q(table),
                q(new_name)
            ));
        }
    } else {
        let mut current = original.clone();
        let mut name = table.to_string();
        for op in ops {
            let next = plan::apply_ops(&current, std::slice::from_ref(op), classify)
                .map_err(StoreError::validation)?;
            statements.extend(in_place_sql(op, &name, &next.def));
            if let AlterTable::RenameTable { new_name } = op {
                name = new_name.clone();
            }
            current = next.def;
        }
    }
    let plan = ChangePlan {
        table: table.into(),
        destructive: applied.operations.iter().any(|o| o.destructive),
        operations: applied.operations,
        rebuild,
        statements: statements.clone(),
        warnings: applied.warnings,
        impact: None,
    };
    Ok((plan, statements, rebuild))
}

/// Executes a plan. Rebuilds run with foreign-key enforcement suspended and
/// end with `PRAGMA foreign_key_check`; any violation rolls everything back.
pub fn execute_plan(
    c: &mut Connection,
    statements: &[String],
    rebuild: bool,
) -> Result<(), StoreError> {
    if rebuild {
        c.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;")
            .map_err(se)?;
    }
    let result = (|| {
        let tx = c.transaction().map_err(se)?;
        for (i, sql) in statements.iter().enumerate() {
            let last_rename = rebuild
                && i + 1 == statements.len()
                && sql.starts_with("ALTER TABLE")
                && sql.contains(" RENAME TO ")
                && !sql.contains("_ixtable_rebuild_");
            if last_rename {
                tx.execute_batch("PRAGMA legacy_alter_table=OFF")
                    .map_err(se)?;
            }
            tx.execute_batch(sql).map_err(se)?;
        }
        if rebuild {
            let violations: Vec<String> = {
                let mut s = tx.prepare("PRAGMA foreign_key_check").map_err(se)?;
                let rows = s
                    .query_map([], |r| {
                        Ok(format!(
                            "{} row {} → {}",
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<i64>>(1)?.unwrap_or_default(),
                            r.get::<_, String>(2)?
                        ))
                    })
                    .map_err(se)?;
                rows.filter_map(Result::ok).take(5).collect()
            };
            if !violations.is_empty() {
                return Err(StoreError::constraint(
                    "foreign_key",
                    format!(
                        "the rebuilt table breaks relationships ({})",
                        violations.join("; ")
                    ),
                ));
            }
        }
        tx.commit().map_err(se)
    })();
    if rebuild {
        let _ = c.execute_batch("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;");
    }
    result
}

pub(crate) fn impact_on(c: &Connection, table: &str) -> Result<TableImpact, StoreError> {
    let def = sqlite::table_def(c, table)?;
    let count = |t: &str| -> Result<u64, StoreError> {
        c.query_row(&format!("SELECT count(*) FROM {}", q(t)), [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|n| n as u64)
        .map_err(se)
    };
    let rows = count(table)?;
    let mut inbound = vec![];
    for other in table_names_on(c)? {
        if other == table {
            continue;
        }
        let other_def = sqlite::table_def(c, &other)?;
        for f in other_def
            .foreign_keys
            .iter()
            .filter(|f| f.target_table.eq_ignore_ascii_case(table))
        {
            let wh = f
                .columns
                .iter()
                .map(|x| format!("{} IS NOT NULL", q(x)))
                .collect::<Vec<_>>()
                .join(" AND ");
            let refs = c
                .query_row(
                    &format!("SELECT count(*) FROM {} WHERE {wh}", q(&other)),
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(se)? as u64;
            inbound.push(InboundForeignKey {
                table: other.clone(),
                columns: f.columns.clone(),
                target_columns: f.target_columns.clone(),
                on_delete: f.on_delete.clone(),
                rows: refs,
            });
        }
    }
    Ok(TableImpact {
        table: table.into(),
        rows,
        inbound_foreign_keys: inbound,
        indexes: def.indexes.iter().map(|i| i.name.clone()).collect(),
        dependents: vec![],
        statements: vec![format!("DROP TABLE {}", q(table))],
    })
}
pub fn table_names_on(c: &Connection) -> Result<Vec<String>, StoreError> {
    let mut s = c
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_ixtable\\_%' ESCAPE '\\' ORDER BY name")
        .map_err(se)?;
    let names = s
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(se)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(se);
    names
}
pub(crate) fn health(c: &Connection) -> Result<Vec<String>, StoreError> {
    let mut out = vec![];
    let fk: Vec<String> = {
        let mut s = c.prepare("PRAGMA foreign_key_check").map_err(se)?;
        let rows = s
            .query_map([], |r| {
                Ok(format!(
                    "{} → {}",
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(2)?
                ))
            })
            .map_err(se)?;
        rows.filter_map(Result::ok).collect()
    };
    if !fk.is_empty() {
        return Err(StoreError::constraint(
            "foreign_key",
            format!("health check found broken relationships: {}", fk.join(", ")),
        ));
    }
    out.push("foreign_key_check: ok".into());
    let integrity: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(se)?;
    if integrity != "ok" {
        return Err(StoreError::new(
            "DATABASE_ERROR",
            format!("integrity_check: {integrity}"),
        ));
    }
    out.push("integrity_check: ok".into());
    Ok(out)
}
