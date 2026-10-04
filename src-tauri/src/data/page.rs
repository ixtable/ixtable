//! Record pages: filtered, sorted, stably ordered reads with typed values.
use super::{
    duck_value, like_pattern, q,
    read::{duck_bind, ReadRuntime, ReadTarget},
    DataValue, Filter, FilterOperator, LogicalType, Page, Sort,
};
use std::collections::HashSet;

impl ReadRuntime {
    pub fn page(
        &self,
        table: &str,
        offset: u64,
        limit: u64,
        sorts: &[Sort],
        filters: &[Filter],
    ) -> Result<Page, String> {
        if limit == 0 || limit > 1000 {
            return Err("Page size must be between 1 and 1000".into());
        }
        let _gate = self.read_gate()?;
        let mut meta = self.schema(table)?;
        let visible = self.duckdb_columns(table)?;
        meta.columns.retain(|c| visible.contains(&c.name));
        let cols: HashSet<_> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        for name in sorts
            .iter()
            .map(|s| s.column.as_str())
            .chain(filters.iter().map(|f| f.column.as_str()))
        {
            if !cols.contains(name) {
                return Err(format!("Unknown column {name:?}"));
            }
        }
        let mut binds: Vec<duckdb::types::Value> = vec![];
        let mut predicates = vec![];
        for f in filters {
            let col = q(&f.column);
            let predicate = match f.operator {
                FilterOperator::IsNull => format!("{col} IS NULL"),
                FilterOperator::IsNotNull => format!("{col} IS NOT NULL"),
                FilterOperator::In => {
                    let values = f.values.as_deref().unwrap_or_default();
                    if values.is_empty() {
                        "FALSE".to_string()
                    } else {
                        for v in values {
                            binds.push(duck_bind(v)?);
                        }
                        format!("{col} IN ({})", vec!["?"; values.len()].join(", "))
                    }
                }
                FilterOperator::Contains | FilterOperator::StartsWith => {
                    let text = match &f.value {
                        Some(DataValue::Text(v)) => v,
                        _ => return Err("Text filter value is required".into()),
                    };
                    binds.push(duckdb::types::Value::Text(like_pattern(
                        text,
                        matches!(f.operator, FilterOperator::Contains),
                    )));
                    format!("CAST({col} AS VARCHAR) ILIKE ? ESCAPE '\\'")
                }
                _ => {
                    let value = f.value.as_ref().ok_or("Filter value is required")?;
                    binds.push(duck_bind(value)?);
                    format!(
                        "{col} {} ?",
                        match f.operator {
                            FilterOperator::Eq => "=",
                            FilterOperator::Ne => "<>",
                            FilterOperator::Lt => "<",
                            FilterOperator::Lte => "<=",
                            FilterOperator::Gt => ">",
                            _ => ">=",
                        }
                    )
                }
            };
            predicates.push(predicate)
        }
        let wh = if predicates.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", predicates.join(" AND "))
        };
        let from = self.from(table);
        let total = self
            .connection
            .query_row(
                &format!("SELECT count(*) FROM {from}{wh}"),
                duckdb::params_from_iter(binds.iter()),
                |r| r.get::<_, u64>(0),
            )
            .map_err(|e| e.to_string())?;
        let rowid = matches!(self.target, ReadTarget::Sqlite)
            && meta.object_type == "table"
            && !meta.without_rowid
            && meta.primary_key.is_empty();
        let identity: Vec<String> = if rowid {
            vec!["rowid".into()]
        } else {
            meta.primary_key.clone()
        };
        if identity.is_empty() && meta.object_type == "table" {
            return Err("Object has no stable row identity".into());
        }
        let select = meta
            .columns
            .iter()
            .map(|c| match c.logical_type {
                LogicalType::Uuid | LogicalType::Json => format!("CAST({} AS VARCHAR)", q(&c.name)),
                _ => q(&c.name),
            })
            .chain(rowid.then(|| "rowid".into()))
            .collect::<Vec<_>>()
            .join(",");
        let order = sorts
            .iter()
            .map(|s| {
                format!(
                    "{} {}",
                    q(&s.column),
                    if s.descending { "DESC" } else { "ASC" }
                )
            })
            .chain(identity.iter().map(|c| format!("{} ASC", q(c))))
            .chain(identity.is_empty().then(|| {
                meta.columns
                    .iter()
                    .map(|c| q(&c.name))
                    .collect::<Vec<_>>()
                    .join(",")
            }))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(",");
        let order = if order.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {order}")
        };
        let mut all = binds;
        all.push(duckdb::types::Value::BigInt(limit as i64));
        all.push(duckdb::types::Value::BigInt(offset as i64));
        let mut stmt = self
            .connection
            .prepare(&format!(
                "SELECT {select} FROM {from}{wh}{order} LIMIT ? OFFSET ?"
            ))
            .map_err(|e| e.to_string())?;
        let count = meta.columns.len() + usize::from(rowid);
        let types: Vec<LogicalType> = meta
            .columns
            .iter()
            .map(|c| c.logical_type.clone())
            .collect();
        let raw = stmt
            .query_map(duckdb::params_from_iter(all.iter()), |r| {
                Ok((0..count)
                    .map(|i| {
                        let v = duck_value(r.get::<_, duckdb::types::Value>(i).unwrap());
                        match types.get(i) {
                            Some(t) => t.coerce_read(v),
                            None => v,
                        }
                    })
                    .collect::<Vec<_>>())
            })
            .map_err(|e| e.to_string())?;
        let mut rows = vec![];
        let mut identities = vec![];
        for row in raw {
            let mut row = row.map_err(|e| e.to_string())?;
            if rowid {
                identities.push(vec![row.pop().unwrap()])
            } else {
                identities.push(
                    identity
                        .iter()
                        .filter_map(|name| {
                            meta.columns
                                .iter()
                                .position(|c| &c.name == name)
                                .map(|i| row[i].clone())
                        })
                        .collect(),
                )
            }
            rows.push(row)
        }
        Ok(Page {
            columns: meta.columns,
            rows,
            identities,
            total,
            offset,
            limit,
        })
    }
}
