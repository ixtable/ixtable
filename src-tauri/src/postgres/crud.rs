//! PostgreSQL record writes with typed text parameters and optimistic checks.
use super::{from_text, load_def, param_sql, pe, text_param, text_sql};
use crate::data::{q, DataValue, LogicalType, NamedValue, TableDef};
use crate::recordstore::{StoreError, WriteOp, WriteOutcome};
use postgres::{types::ToSql, GenericClient};

fn params(texts: &[Option<String>]) -> Vec<&(dyn ToSql + Sync)> {
    texts.iter().map(|t| t as &(dyn ToSql + Sync)).collect()
}

type Prepared = Vec<(String, String, LogicalType, DataValue)>;
fn prepare(def: &TableDef, values: &[NamedValue]) -> Result<Prepared, StoreError> {
    Ok(crate::recordstore::sqlite::prepare(def, values, false)?
        .into_iter()
        .map(|(name, t, v)| {
            let declared = def
                .column(&name)
                .map(|c| c.declared_type.clone())
                .unwrap_or_default();
            (name, declared, t, v)
        })
        .collect())
}
fn identity(def: &TableDef, values: &[DataValue]) -> Result<Prepared, StoreError> {
    if def.primary_key.is_empty() {
        return Err(StoreError::validation(
            "PostgreSQL tables need a primary key to be edited (there is no rowid)",
        ));
    }
    if values.len() != def.primary_key.len() {
        return Err(StoreError::new(
            "STALE_ROW",
            "Row identity does not match the primary key",
        ));
    }
    let named: Vec<NamedValue> = def
        .primary_key
        .iter()
        .zip(values)
        .map(|(k, v)| NamedValue {
            column: k.clone(),
            value: v.clone(),
        })
        .collect();
    let def_with_generated = TableDef {
        columns: def
            .columns
            .iter()
            .cloned()
            .map(|mut c| {
                c.generated_expression = None;
                c
            })
            .collect(),
        ..def.clone()
    };
    prepare(&def_with_generated, &named)
}
fn comparison(column: &str, declared: &str, t: &LogicalType, i: usize) -> String {
    match t {
        LogicalType::Json => format!(
            "{}::jsonb IS NOT DISTINCT FROM ${i}::text::jsonb",
            q(column)
        ),
        _ => format!(
            "{} IS NOT DISTINCT FROM {}",
            q(column),
            param_sql(i, declared, t)
        ),
    }
}
fn where_clause(
    keys: &Prepared,
    expected: &Prepared,
    start: usize,
    texts: &mut Vec<Option<String>>,
) -> String {
    let mut parts = vec![];
    for (i, (name, declared, t, v)) in keys.iter().chain(expected.iter()).enumerate() {
        parts.push(comparison(name, declared, t, start + i));
        texts.push(text_param(v));
    }
    parts.join(" AND ")
}
fn expected_values(
    def: &TableDef,
    expected: Option<&[NamedValue]>,
) -> Result<Prepared, StoreError> {
    let all = TableDef {
        columns: def
            .columns
            .iter()
            .cloned()
            .map(|mut c| {
                c.generated_expression = None;
                c
            })
            .collect(),
        ..def.clone()
    };
    prepare(&all, expected.unwrap_or_default())
}

fn current_row(
    c: &mut impl GenericClient,
    def: &TableDef,
    keys: &Prepared,
) -> Result<Option<Vec<NamedValue>>, StoreError> {
    let mut texts = vec![];
    let wh = where_clause(keys, &vec![], 1, &mut texts);
    let cols = def
        .columns
        .iter()
        .map(|c| text_sql(&c.name, &c.logical_type))
        .collect::<Vec<_>>()
        .join(",");
    let row = c
        .query_opt(
            &format!("SELECT {cols} FROM {} WHERE {wh}", q(&def.name)),
            &params(&texts),
        )
        .map_err(pe)?;
    Ok(row.map(|r| {
        def.columns
            .iter()
            .enumerate()
            .map(|(i, col)| NamedValue {
                column: col.name.clone(),
                value: from_text(&col.logical_type, r.get(i)),
            })
            .collect()
    }))
}
fn no_match(
    c: &mut impl GenericClient,
    def: &TableDef,
    keys: &Prepared,
    expected: &Prepared,
) -> StoreError {
    match current_row(c, def, keys) {
        Ok(Some(current)) if !expected.is_empty() => {
            let changed: Vec<String> = expected
                .iter()
                .filter_map(|(name, _, _, v)| {
                    current
                        .iter()
                        .find(|x| &x.column == name)
                        .filter(|x| &x.value != v)
                })
                .map(|x| {
                    format!(
                        "{} is now {}",
                        x.column,
                        crate::recordstore::sqlite::display(&x.value)
                    )
                })
                .collect();
            StoreError::new(
                "CONFLICT",
                format!(
                    "This record was changed by someone else since you opened it{}{}. Reload to see the current values.",
                    if changed.is_empty() { "" } else { ": " },
                    changed.join(", ")
                ),
            )
        }
        Ok(_) => StoreError::new("STALE_ROW", "The record no longer exists"),
        Err(e) => e,
    }
}

pub(crate) fn insert_on(
    c: &mut impl GenericClient,
    schema: &str,
    table: &str,
    values: &[NamedValue],
) -> Result<Vec<DataValue>, StoreError> {
    let def = load_def(c, schema, table)?;
    let values = prepare(&def, values)?;
    let keys: Vec<(String, LogicalType)> = def
        .primary_key
        .iter()
        .map(|k| {
            (
                k.clone(),
                def.column(k)
                    .map(|c| c.logical_type.clone())
                    .unwrap_or(LogicalType::Text),
            )
        })
        .collect();
    let returning = if keys.is_empty() {
        "1".to_string()
    } else {
        keys.iter()
            .map(|(k, t)| text_sql(k, t))
            .collect::<Vec<_>>()
            .join(",")
    };
    let sql = if values.is_empty() {
        format!(
            "INSERT INTO {} DEFAULT VALUES RETURNING {returning}",
            q(table)
        )
    } else {
        format!(
            "INSERT INTO {} ({}) VALUES ({}) RETURNING {returning}",
            q(table),
            values.iter().map(|v| q(&v.0)).collect::<Vec<_>>().join(","),
            values
                .iter()
                .enumerate()
                .map(|(i, v)| param_sql(i + 1, &v.1, &v.2))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let texts: Vec<Option<String>> = values.iter().map(|v| text_param(&v.3)).collect();
    let row = c.query_one(&sql, &params(&texts)).map_err(pe)?;
    Ok(keys
        .iter()
        .enumerate()
        .map(|(i, (_, t))| from_text(t, row.get(i)))
        .collect())
}

pub(crate) fn update_on(
    c: &mut impl GenericClient,
    schema: &str,
    table: &str,
    values: &[NamedValue],
    identity_in: &[DataValue],
    expected: Option<&[NamedValue]>,
) -> Result<u64, StoreError> {
    let def = load_def(c, schema, table)?;
    if values.is_empty() {
        return Err(StoreError::validation("No values to update"));
    }
    let values = prepare(&def, values)?;
    let keys = identity(&def, identity_in)?;
    let expected = expected_values(&def, expected)?;
    let mut texts: Vec<Option<String>> = values.iter().map(|v| text_param(&v.3)).collect();
    let set = values
        .iter()
        .enumerate()
        .map(|(i, v)| format!("{}={}", q(&v.0), param_sql(i + 1, &v.1, &v.2)))
        .collect::<Vec<_>>()
        .join(",");
    let wh = where_clause(&keys, &expected, values.len() + 1, &mut texts);
    let n = c
        .execute(
            &format!("UPDATE {} SET {set} WHERE {wh}", q(table)),
            &params(&texts),
        )
        .map_err(pe)?;
    match n {
        1 => Ok(1),
        0 => Err(no_match(c, &def, &keys, &expected)),
        n => Err(StoreError::new(
            "STALE_ROW",
            format!("Expected one row, changed {n}"),
        )),
    }
}

pub(crate) fn delete_on(
    c: &mut impl GenericClient,
    schema: &str,
    table: &str,
    identity_in: &[DataValue],
    expected: Option<&[NamedValue]>,
) -> Result<u64, StoreError> {
    let def = load_def(c, schema, table)?;
    let keys = identity(&def, identity_in)?;
    let expected = expected_values(&def, expected)?;
    let mut texts = vec![];
    let wh = where_clause(&keys, &expected, 1, &mut texts);
    let n = c
        .execute(
            &format!("DELETE FROM {} WHERE {wh}", q(table)),
            &params(&texts),
        )
        .map_err(pe)?;
    match n {
        1 => Ok(1),
        0 => Err(no_match(c, &def, &keys, &expected)),
        n => Err(StoreError::new(
            "STALE_ROW",
            format!("Expected one row, changed {n}"),
        )),
    }
}

pub(crate) fn apply_op(
    c: &mut impl GenericClient,
    schema: &str,
    op: &WriteOp,
) -> Result<WriteOutcome, StoreError> {
    Ok(match op {
        WriteOp::Insert { table, values } => WriteOutcome {
            changed: 1,
            identity: Some(insert_on(c, schema, table, values)?),
        },
        WriteOp::Update {
            table,
            values,
            identity,
            expected,
        } => WriteOutcome {
            changed: update_on(c, schema, table, values, identity, expected.as_deref())?,
            identity: None,
        },
        WriteOp::Delete {
            table,
            identity,
            expected,
        } => WriteOutcome {
            changed: delete_on(c, schema, table, identity, expected.as_deref())?,
            identity: None,
        },
    })
}
