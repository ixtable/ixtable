//! Catalog query that describes a PostgreSQL table as a `TableDef` JSON document.

fn lit(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}
fn cols_json(arr: &str, rel: &str) -> String {
    format!("COALESCE((SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest({arr}) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = {rel} AND a.attnum = k.attnum), '[]'::json)")
}
fn action(col: &str) -> String {
    format!("CASE {col} WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END")
}

/// One-row catalog query returning a `TableDef` as JSON (column `definition`).
/// Used by the store and, through DuckDB's `postgres_query`, by the reader.
pub fn table_def_query(schema: &str, table: &str) -> String {
    format!(
        "SELECT json_build_object(\
 'name', c.relname,\
 'columns', COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'declaredType', format_type(a.atttypid, a.atttypmod), 'logicalType', 'text', 'nullable', NOT a.attnotnull,\
   'defaultExpression', CASE WHEN a.attgenerated = '' AND a.attidentity = '' THEN pg_get_expr(d.adbin, d.adrelid) END,\
   'generatedExpression', CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END, 'identity', a.attidentity <> '') ORDER BY a.attnum)\
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json),\
 'primaryKey', COALESCE((SELECT {pk} FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p'), '[]'::json),\
 'primaryKeyName', (SELECT p.conname FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p'),\
 'uniques', COALESCE((SELECT json_agg(json_build_object('name', p.conname, 'columns', {ucols}) ORDER BY p.conname) FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'u'), '[]'::json),\
 'checks', COALESCE((SELECT json_agg(json_build_object('name', p.conname, 'expression', substring(pg_get_constraintdef(p.oid) from '^CHECK \\((.*)\\)$')) ORDER BY p.conname) FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'c'), '[]'::json),\
 'foreignKeys', COALESCE((SELECT json_agg(json_build_object('name', p.conname, 'columns', {fcols}, 'targetTable', t.relname, 'targetColumns', {tcols}, 'onUpdate', {upd}, 'onDelete', {del}) ORDER BY p.conname) FROM pg_constraint p JOIN pg_class t ON t.oid = p.confrelid WHERE p.conrelid = c.oid AND p.contype = 'f'), '[]'::json),\
 'indexes', COALESCE((SELECT json_agg(json_build_object('name', i.relname, 'table', c.relname, 'unique', x.indisunique, 'columns', {icols}, 'sql', pg_get_indexdef(x.indexrelid)) ORDER BY i.relname) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = c.oid AND NOT x.indisprimary AND NOT EXISTS (SELECT 1 FROM pg_constraint u WHERE u.conindid = x.indexrelid)), '[]'::json),\
 'withoutRowid', false)::text AS definition \
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = {schema} AND c.relname = {table} AND c.relkind IN ('r','p')",
        pk = cols_json("p.conkey", "p.conrelid"),
        ucols = cols_json("p.conkey", "p.conrelid"),
        fcols = cols_json("p.conkey", "p.conrelid"),
        tcols = cols_json("p.confkey", "p.confrelid"),
        icols = cols_json("x.indkey::int2[]", "c.oid"),
        upd = action("p.confupdtype"),
        del = action("p.confdeltype"),
        schema = lit(schema),
        table = lit(table),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::TableSchema;

    #[test]
    fn query_reports_identity_columns() {
        assert!(table_def_query("s", "t").contains("'identity', a.attidentity <> ''"));
    }

    #[test]
    #[ignore = "needs IXTABLE_TEST_POSTGRES_URL; CI runs it with --include-ignored"]
    fn auto_increment_covers_identity_and_serial_but_not_plain_keys() {
        let Some(url) = crate::test_env::postgres_url() else {
            return;
        };
        let schema = format!("ixt_{}", uuid::Uuid::new_v4().simple());
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "CREATE SCHEMA {schema};\
             CREATE TABLE {schema}.plain (id integer PRIMARY KEY);\
             CREATE TABLE {schema}.ident (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);\
             CREATE TABLE {schema}.ser (id serial PRIMARY KEY);"
        ))
        .unwrap();
        let auto = |c: &mut postgres::Client, table: &str| {
            let def = crate::postgres::load_def(c, &schema, table).unwrap();
            TableSchema::from_def(def, "table".into()).columns[0].auto_increment
        };
        let result = (
            auto(&mut c, "plain"),
            auto(&mut c, "ident"),
            auto(&mut c, "ser"),
        );
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
        assert_eq!(result, (false, true, true));
    }
}
