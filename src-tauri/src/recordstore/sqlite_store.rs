//! `RecordStore` for `SqliteRecordStore`: transactions, DDL, indexes, and migration scripts.
use super::{
    capabilities,
    model::*,
    plan,
    sqlite::{self, se, SqliteRecordStore},
    sqlite_ddl::{
        create_table_sql, execute_plan, health, impact_on, index_sql, plan_changes, table_names_on,
    },
    RecordStore, ScriptReport, StoreCapabilities,
};
use crate::data::{q, AlterTable, CreateTable, DataValue, IndexDef, NamedValue, TableDef};
use rusqlite::params_from_iter;

impl SqliteRecordStore {
    /// Runs a script on this database (or, for a dry run, on a throwaway copy).
    fn script(
        &self,
        sql: &str,
        record: &[super::Bookkeeping],
        dry_run: bool,
    ) -> Result<ScriptReport, StoreError> {
        if let Some(message) = crate::data::sqltext::transaction_control_error(sql) {
            return Err(crate::recordstore::StoreError::new(
                "VALIDATION_ERROR",
                message,
            ));
        }
        let mut c = self.connection()?;
        let tx = c.transaction().map_err(se)?;
        let mut report = ScriptReport::default();
        tx.execute_batch(sql).map_err(se)?;
        report.log.push(format!(
            "executed {} statement(s)",
            sql.matches(';').count().max(1)
        ));
        report.health = health(&tx)?;
        for (record_sql, binds) in record {
            tx.execute(record_sql, params_from_iter(binds.iter()))
                .map_err(se)?;
        }
        if dry_run {
            tx.rollback().map_err(se)?;
            report.log.push("rolled back (dry run)".into());
        } else {
            tx.commit().map_err(se)?;
            report.log.push("committed".into());
        }
        Ok(report)
    }
}

impl RecordStore for SqliteRecordStore {
    fn kind(&self) -> &'static str {
        "sqlite"
    }
    fn capabilities(&self) -> StoreCapabilities {
        capabilities::sqlite()
    }
    fn table_names(&mut self) -> Result<Vec<String>, StoreError> {
        table_names_on(&self.connection()?)
    }
    fn table_def(&mut self, table: &str) -> Result<TableDef, StoreError> {
        sqlite::table_def(&self.connection()?, table)
    }
    fn insert(&mut self, table: &str, values: &[NamedValue]) -> Result<Vec<DataValue>, StoreError> {
        self.transaction(|c| sqlite::insert_on(c, table, values))
    }
    fn update(
        &mut self,
        table: &str,
        values: &[NamedValue],
        identity: &[DataValue],
        expected: Option<&[NamedValue]>,
    ) -> Result<u64, StoreError> {
        self.transaction(|c| sqlite::update_on(c, table, values, identity, expected))
    }
    fn delete(
        &mut self,
        table: &str,
        identity: &[DataValue],
        expected: Option<&[NamedValue]>,
    ) -> Result<u64, StoreError> {
        self.transaction(|c| sqlite::delete_on(c, table, identity, expected))
    }
    fn execute_batch(&mut self, ops: &[WriteOp]) -> Result<Vec<WriteOutcome>, StoreError> {
        self.transaction(|c| ops.iter().map(|op| sqlite::apply_op(c, op)).collect())
    }
    fn create_table(&mut self, spec: &CreateTable) -> Result<Vec<String>, StoreError> {
        let def = plan::def_from_spec(spec).map_err(StoreError::validation)?;
        let mut statements = vec![create_table_sql(&def, &def.name)?];
        statements.extend(def.indexes.iter().map(|i| index_sql(i, &def.name)));
        self.transaction(|c| {
            for s in &statements {
                c.execute_batch(s).map_err(se)?;
            }
            Ok(())
        })?;
        Ok(statements)
    }
    fn plan_alter(&mut self, table: &str, ops: &[AlterTable]) -> Result<ChangePlan, StoreError> {
        Ok(plan_changes(&self.connection()?, table, ops)?.0)
    }
    fn alter_table(&mut self, table: &str, ops: &[AlterTable]) -> Result<ChangePlan, StoreError> {
        let mut c = self.connection()?;
        let (plan, statements, rebuild) = plan_changes(&c, table, ops)?;
        execute_plan(&mut c, &statements, rebuild)?;
        Ok(plan)
    }
    fn drop_table(&mut self, table: &str) -> Result<(), StoreError> {
        let c = self.connection()?;
        sqlite::table_def(&c, table)?;
        drop(c);
        self.transaction(|c| {
            c.execute_batch(&format!("DROP TABLE {}", q(table)))
                .map_err(se)
        })
    }
    fn create_index(&mut self, spec: &CreateIndex) -> Result<(), StoreError> {
        plan::validate_name("Index", &spec.name).map_err(StoreError::validation)?;
        let def = self.table_def(&spec.table)?;
        if spec.columns.is_empty() || spec.columns.iter().any(|c| def.column(c).is_none()) {
            return Err(StoreError::validation("An index needs existing columns"));
        }
        let sql = index_sql(
            &IndexDef {
                name: spec.name.clone(),
                table: spec.table.clone(),
                columns: spec.columns.clone(),
                unique: spec.unique,
                sql: None,
            },
            &spec.table,
        );
        self.transaction(|c| c.execute_batch(&sql).map_err(se))
    }
    fn drop_index(&mut self, name: &str) -> Result<(), StoreError> {
        self.transaction(|c| {
            c.execute_batch(&format!("DROP INDEX {}", q(name)))
                .map_err(se)
        })
    }
    fn list_indexes(&mut self, table: Option<&str>) -> Result<Vec<IndexDef>, StoreError> {
        let c = self.connection()?;
        let tables = match table {
            Some(t) => vec![t.to_string()],
            None => table_names_on(&c)?,
        };
        let mut out = vec![];
        for t in tables {
            out.extend(sqlite::table_def(&c, &t)?.indexes);
        }
        Ok(out)
    }
    fn impact(&mut self, table: &str) -> Result<TableImpact, StoreError> {
        impact_on(&self.connection()?, table)
    }
    fn run_script(
        &mut self,
        sql: &str,
        record: &[super::Bookkeeping],
        dry_run: bool,
    ) -> Result<ScriptReport, StoreError> {
        if !dry_run {
            return self.script(sql, record, false);
        }
        let copy =
            std::env::temp_dir().join(format!("ixtable-dry-run-{}.db", uuid::Uuid::new_v4()));
        crate::manager::vacuum_into(&self.path, &copy)
            .map_err(|e| StoreError::new("DATABASE_ERROR", e.message))?;
        let result = SqliteRecordStore::new(&copy).script(sql, record, true);
        let _ = std::fs::remove_file(&copy);
        result
    }
    fn execute_internal(&mut self, sql: &str, binds: &[String]) -> Result<(), StoreError> {
        self.transaction(|c| {
            if binds.is_empty() {
                c.execute_batch(sql).map_err(se)
            } else {
                c.execute(sql, params_from_iter(binds.iter()))
                    .map(|_| ())
                    .map_err(se)
            }
        })
    }
    fn query_internal(&mut self, sql: &str) -> Result<Vec<Vec<Option<String>>>, StoreError> {
        let c = self.connection()?;
        let mut s = c.prepare(sql).map_err(se)?;
        let n = s.column_count();
        let rows = s
            .query_map([], |r| {
                (0..n)
                    .map(|i| {
                        Ok(match r.get_ref(i)? {
                            rusqlite::types::ValueRef::Null => None,
                            v => sqlite::read(v).as_text(),
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(se)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(se);
        rows
    }
}
