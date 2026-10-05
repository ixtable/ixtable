use super::files::*;
use super::*;
use std::path::{Path, PathBuf};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ixtable-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(connection: &duckdb::Connection, sql: &str) -> Result<Vec<Vec<DataValue>>, String> {
    let mut stmt = connection.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut out = vec![];
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let width = row.as_ref().column_count();
        out.push(
            (0..width)
                .map(|i| duck_value(row.get(i).unwrap()))
                .collect(),
        );
    }
    Ok(out)
}

/// Writes a Parquet file with an unrestricted DuckDB (test setup only).
fn write_parquet(path: &Path) {
    let c = duckdb::Connection::open_in_memory().unwrap();
    c.execute_batch(&format!(
        "COPY (SELECT * FROM (VALUES (1, 'north', 12.5::DECIMAL(6,2)), (2, 'south', 7.25::DECIMAL(6,2))) t(id, region, amount)) TO '{}' (FORMAT parquet)",
        literal(path)
    ))
    .unwrap();
}

#[test]
fn formats_come_from_extensions() {
    assert_eq!(
        FileFormat::from_path(Path::new("a.CSV")),
        Some(FileFormat::Csv)
    );
    assert_eq!(
        FileFormat::from_path(Path::new("a.tsv")),
        Some(FileFormat::Csv)
    );
    assert_eq!(
        FileFormat::from_path(Path::new("a.xlsx")),
        Some(FileFormat::Xlsx)
    );
    assert_eq!(
        FileFormat::from_path(Path::new("a.ndjson")),
        Some(FileFormat::Json)
    );
    assert_eq!(
        FileFormat::from_path(Path::new("a.parquet")),
        Some(FileFormat::Parquet)
    );
    assert_eq!(FileFormat::from_path(Path::new("a.exe")), None);
}

#[test]
fn csv_scans_take_one_safe_delimiter() {
    let p = Path::new("/tmp/it's.csv");
    let csv = |d: &str| CsvOptions {
        header: false,
        delimiter: Some(d.into()),
    };
    assert_eq!(
        scan_sql(p, FileFormat::Csv, &csv(";")).unwrap(),
        "read_csv('/tmp/it''s.csv', header=false, delim=';')"
    );
    assert!(scan_sql(p, FileFormat::Csv, &csv("\t")).is_ok());
    assert!(scan_sql(p, FileFormat::Csv, &csv(",,")).is_err());
    assert!(scan_sql(p, FileFormat::Csv, &csv("'")).is_err());
    assert!(scan_sql(p, FileFormat::Xlsx, &CsvOptions::default()).is_err());
}

#[test]
fn the_sandbox_reads_only_the_chosen_file() {
    let dir = temp_dir("sandbox");
    let chosen = dir.join("chosen.csv");
    let other = dir.join("other.csv");
    std::fs::write(&chosen, "id;name\n1;Ada\n2;Grace\n").unwrap();
    std::fs::write(&other, "secret\n42\n").unwrap();
    let sandbox = sandbox(&chosen).unwrap();
    let options = CsvOptions {
        header: true,
        delimiter: Some(";".into()),
    };
    let scan = scan_sql(&chosen, FileFormat::Csv, &options).unwrap();
    let rows = run(&sandbox, &format!("SELECT * FROM {scan} ORDER BY id")).unwrap();
    assert_eq!(
        rows,
        vec![
            vec![DataValue::Integer(1), DataValue::Text("Ada".into())],
            vec![DataValue::Integer(2), DataValue::Text("Grace".into())],
        ]
    );
    let other_sql = literal(&other);
    let out = literal(&dir.join("out.csv"));
    for sql in [
        format!("SELECT * FROM read_csv('{other_sql}')"),
        format!("SELECT * FROM '{other_sql}'"),
        "SELECT * FROM read_text('/etc/passwd')".to_string(),
        format!("COPY (SELECT 1) TO '{out}'"),
        format!("SELECT * FROM glob('{}/*')", literal(&dir)),
        "SET enable_external_access = true".to_string(),
        format!("SET allowed_paths = ['{other_sql}']"),
        "INSTALL httpfs".to_string(),
    ] {
        assert!(run(&sandbox, &sql).is_err(), "sandbox allowed: {sql}");
    }
    assert!(!dir.join("out.csv").exists());
}

#[test]
fn reader_exposes_bundled_files_as_read_only_views() {
    let dir = temp_dir("filesources");
    let c = rusqlite::Connection::open(dir.join("data.db")).unwrap();
    c.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);")
        .unwrap();
    drop(c);
    let csv = dir.join("sales.csv");
    std::fs::write(&csv, "region,amount\nnorth,10\nsouth,5\nnorth,2\n").unwrap();
    let json = dir.join("people.json");
    std::fs::write(
        &json,
        r#"[{"name":"Ada","age":36},{"name":"Grace","age":45}]"#,
    )
    .unwrap();
    let parquet = dir.join("orders.parquet");
    write_parquet(&parquet);
    let secret = dir.join("secret.csv");
    std::fs::write(&secret, "x\n1\n").unwrap();
    let view = |name: &str, path: &Path, format| FileView {
        name: name.into(),
        path: path.to_owned(),
        format,
        csv: CsvOptions::default(),
    };
    let mut reader = ReadRuntime::for_test(&dir).unwrap();
    reader
        .configure(
            ReadTarget::Sqlite,
            vec![
                view("sales", &csv, FileFormat::Csv),
                view("people", &json, FileFormat::Json),
                view("orders", &parquet, FileFormat::Parquet),
                view("missing", &dir.join("nope.csv"), FileFormat::Csv),
            ],
        )
        .unwrap();
    assert_eq!(reader.file_errors().len(), 1);
    assert!(reader.file_errors()[0].starts_with("missing: "));
    let totals = reader
        .query(
            "SELECT region, sum(amount) AS total FROM files.sales GROUP BY region ORDER BY region",
        )
        .unwrap();
    assert_eq!(
        totals.rows,
        vec![
            vec![DataValue::Text("north".into()), DataValue::Integer(12)],
            vec![DataValue::Text("south".into()), DataValue::Integer(5)],
        ]
    );
    let joined = reader
        .query("SELECT p.name, o.amount FROM files.people p JOIN files.orders o ON o.id = p.age - 35 ORDER BY 1")
        .unwrap();
    assert_eq!(
        joined.rows,
        vec![vec![
            DataValue::Text("Ada".into()),
            DataValue::Decimal("12.50".into())
        ]]
    );
    // The embedded data still reads, also after a refresh.
    assert_eq!(reader.row_count("t").unwrap(), 1);
    reader.refresh().unwrap();
    assert_eq!(
        reader
            .query("SELECT count(*) FROM files.orders")
            .unwrap()
            .rows[0][0],
        DataValue::Integer(2)
    );
    // No write reaches a source, and no other file opens even past the guard.
    let secret_sql = literal(&secret);
    assert!(reader.query("DROP VIEW files.sales").is_err());
    for sql in [
        "INSERT INTO files.sales VALUES ('east', 1)".to_string(),
        format!("SELECT * FROM read_csv('{secret_sql}')"),
        format!("COPY files.sales TO '{}'", literal(&dir.join("leak.csv"))),
    ] {
        assert!(reader.query(&sql).is_err(), "guarded: {sql}");
        assert!(run(reader.connection(), &sql).is_err(), "direct: {sql}");
    }
    assert!(!dir.join("leak.csv").exists());
    // Removing the sources drops the views.
    reader.configure(ReadTarget::Sqlite, vec![]).unwrap();
    assert!(reader.query("SELECT * FROM files.sales").is_err());
}
