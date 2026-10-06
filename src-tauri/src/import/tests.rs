use super::parse::{check_size, for_each_row, layout, parse, unique_names, ParseOptions};
use super::sources::{validate, views, FileSource};
use super::write::*;
use super::xlsx::infer;
use crate::archive::DocumentConfig;
use crate::data::files::{CsvOptions, FileFormat};
use crate::data::{DataValue, LogicalType, NamedValue};
use crate::recordstore::{sqlite::SqliteRecordStore, RecordStore};
use std::path::{Path, PathBuf};

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ixtable-import-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, contents).unwrap();
    path
}
fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/imports")
        .join(name)
}
fn types(parsed: &super::parse::ParsedFile) -> Vec<(String, String)> {
    parsed
        .columns
        .iter()
        .map(|c| (c.name.clone(), c.logical_type.to_string()))
        .collect()
}
fn text(s: &str) -> DataValue {
    DataValue::Text(s.into())
}
const ALL: usize = 1_000;

#[test]
fn csv_preview_infers_types_and_counts_every_row() {
    let dir = temp_dir();
    let mut csv = String::from("id,name,joined,active,score\n");
    for i in 1..=120 {
        csv.push_str(&format!(
            "{i},P{i},2024-01-{:02},{},{}.5\n",
            i % 28 + 1,
            i % 2 == 0,
            i
        ));
    }
    let path = write(&dir, "people.csv", &csv);
    let parsed = parse(&path, &ParseOptions::default(), 50).unwrap();
    assert_eq!(parsed.format, FileFormat::Csv);
    assert_eq!(parsed.total_rows, 120);
    assert_eq!(parsed.rows.len(), 50);
    assert_eq!(
        types(&parsed),
        [
            ("id", "integer"),
            ("name", "text"),
            ("joined", "date"),
            ("active", "boolean"),
            ("score", "real")
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(
        parsed.rows[0],
        vec![
            DataValue::Integer(1),
            text("P1"),
            DataValue::Date("2024-01-02".into()),
            DataValue::Boolean(false),
            DataValue::Real(1.5)
        ]
    );
}

#[test]
fn csv_header_and_delimiter_options_apply() {
    let dir = temp_dir();
    let path = write(&dir, "data.txt", "a|b\nc|d\n");
    let options = ParseOptions {
        header: false,
        delimiter: Some("|".into()),
        ..Default::default()
    };
    let parsed = parse(&path, &options, ALL).unwrap();
    assert_eq!(parsed.columns.len(), 2);
    assert_eq!(parsed.total_rows, 2);
    assert_eq!(parsed.rows[0], vec![text("a"), text("b")]);
    let unknown = write(&dir, "data.bin", "x");
    assert!(parse(&unknown, &ParseOptions::default(), ALL)
        .unwrap_err()
        .contains("Unsupported file type"));
    assert!(parse(&dir.join("missing.csv"), &ParseOptions::default(), ALL).is_err());
}

#[test]
fn json_and_parquet_files_parse_through_duckdb() {
    let dir = temp_dir();
    let json = write(
        &dir,
        "items.json",
        r#"[{"sku":"A1","qty":3,"tags":["x"]},{"sku":"B2","qty":null,"tags":[]}]"#,
    );
    let parsed = parse(&json, &ParseOptions::default(), ALL).unwrap();
    assert_eq!(
        types(&parsed),
        [
            ("sku".into(), "text".into()),
            ("qty".into(), "integer".into()),
            ("tags".into(), "json".into())
        ]
    );
    assert_eq!(parsed.rows[1][1], DataValue::Null);
    assert_eq!(parsed.rows[0][2], text("[\"x\"]"));
    let ndjson = write(&dir, "items.ndjson", "{\"a\":1}\n{\"a\":2}\n");
    assert_eq!(
        parse(&ndjson, &ParseOptions::default(), ALL)
            .unwrap()
            .total_rows,
        2
    );

    let parquet = dir.join("orders.parquet");
    duckdb::Connection::open_in_memory()
        .unwrap()
        .execute_batch(&format!(
            "COPY (SELECT 7 AS id, 19.99::DECIMAL(8,2) AS amount, TIMESTAMP '2024-03-01 10:30:00' AS at) TO '{}' (FORMAT parquet)",
            crate::data::files::literal(&parquet)
        ))
        .unwrap();
    let parsed = parse(&parquet, &ParseOptions::default(), ALL).unwrap();
    assert_eq!(
        types(&parsed),
        [
            ("id", "integer"),
            ("amount", "decimal(8,2)"),
            ("at", "timestamp")
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(parsed.rows[0][1], DataValue::Decimal("19.99".into()));
}

#[test]
fn xlsx_sheets_parse_with_inferred_types() {
    let parsed = parse(&fixture("people.xlsx"), &ParseOptions::default(), ALL).unwrap();
    assert_eq!(parsed.sheets, vec!["People", "Notes"]);
    assert_eq!(
        types(&parsed),
        [
            ("name", "text"),
            ("age", "integer"),
            ("joined", "date"),
            ("active", "boolean"),
            ("score", "real")
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(parsed.total_rows, 3);
    assert_eq!(
        parsed.rows[0],
        vec![
            text("Ada"),
            DataValue::Integer(36),
            DataValue::Date("2024-01-15".into()),
            DataValue::Boolean(true),
            DataValue::Real(9.5)
        ]
    );
    let notes = ParseOptions {
        sheet: Some("Notes".into()),
        ..Default::default()
    };
    let parsed = parse(&fixture("people.xlsx"), &notes, ALL).unwrap();
    assert_eq!(parsed.rows, vec![vec![text("hello")]]);
    let missing = ParseOptions {
        sheet: Some("Nope".into()),
        ..Default::default()
    };
    assert!(parse(&fixture("people.xlsx"), &missing, ALL).is_err());
}

#[test]
fn inference_picks_the_narrowest_type_and_names_are_unique() {
    let ints = [DataValue::Integer(1), DataValue::Real(2.0), DataValue::Null];
    assert_eq!(infer(ints.iter()), LogicalType::Integer);
    let reals = [DataValue::Integer(1), DataValue::Real(2.5)];
    assert_eq!(infer(reals.iter()), LogicalType::Real);
    let stamps = [
        DataValue::Date("2024-01-01".into()),
        DataValue::Timestamp("2024-01-01T10:00:00".into()),
    ];
    assert_eq!(infer(stamps.iter()), LogicalType::Timestamp);
    let mixed = [DataValue::Integer(1), text("x")];
    assert_eq!(infer(mixed.iter()), LogicalType::Text);
    assert_eq!(infer([DataValue::Null].iter()), LogicalType::Text);
    assert_eq!(
        unique_names(vec!["a".into(), "".into(), "A".into(), "a".into()]),
        vec!["a", "column_2", "A_2", "a_3"]
    );
}

#[test]
fn new_tables_get_a_key() {
    let columns = vec![NewColumn {
        source: "Name".into(),
        name: "name".into(),
        logical_type: LogicalType::Text,
    }];
    let spec = new_table_spec("people", &columns, None).unwrap();
    assert_eq!(spec.columns[0].name, "id");
    assert_eq!(spec.columns[0].primary_key_position, 1);
    assert_eq!(spec.columns[1].name, "name");
    let spec = new_table_spec("people", &columns, Some("name")).unwrap();
    assert_eq!(spec.columns.len(), 1);
    assert_eq!(spec.columns[0].primary_key_position, 1);
    assert!(!spec.columns[0].nullable);
    assert!(new_table_spec("people", &columns, Some("other")).is_err());
    assert!(new_table_spec("people", &[], None).is_err());
    let id = vec![NewColumn {
        source: "id".into(),
        name: "ID".into(),
        logical_type: LogicalType::Integer,
    }];
    assert!(new_table_spec("people", &id, None).is_err());
}

/// An SQLite store with `people(id INTEGER PK, name TEXT NOT NULL UNIQUE, age INTEGER, joined DATE)`.
fn people_store(dir: &Path) -> SqliteRecordStore {
    rusqlite::Connection::open(dir.join("data.db")).unwrap();
    let mut store = SqliteRecordStore::new(&dir.join("data.db"));
    let spec: crate::data::CreateTable = serde_json::from_value(serde_json::json!({
        "name": "people",
        "columns": [
            {"name": "id", "logicalType": "integer", "nullable": false, "primaryKeyPosition": 1},
            {"name": "name", "logicalType": "text", "nullable": false, "unique": true},
            {"name": "age", "logicalType": "integer"},
            {"name": "joined", "logicalType": "date"}
        ]
    }))
    .unwrap();
    store.create_table(&spec).unwrap();
    store
}

fn map(source: &str, field: &str) -> FieldMapping {
    FieldMapping {
        source: source.into(),
        field: field.into(),
    }
}

/// Every row of a file as the import reads it.
fn file_rows(path: &Path, options: &ParseOptions) -> Vec<Vec<DataValue>> {
    let layout = layout(path, options).unwrap();
    let mut rows = vec![];
    for_each_row(path, options, &layout, |r| {
        rows.push(r);
        Ok(())
    })
    .unwrap();
    rows
}

#[test]
fn rows_are_checked_then_written_through_the_record_store() {
    let dir = temp_dir();
    let path = write(
        &dir,
        "people.csv",
        "Name,Age,Joined\nAda,36,2024-01-15\nGrace,old,2024-02-01\n,40,2024-03-01\nAda,50,2024-04-01\nLinus,,2024-05-01\n",
    );
    let options = ParseOptions::default();
    let layout = layout(&path, &options).unwrap();
    assert_eq!(layout.names, ["Name", "Age", "Joined"]);
    let mut store = people_store(&dir);
    let columns = table_fields(&mut store, "people").unwrap();
    // Unknown, duplicate, and missing required fields are refused before any write.
    let names = &layout.names;
    assert!(plan_fields(names, &[map("Nope", "name")], &columns).is_err());
    assert!(plan_fields(names, &[map("Name", "nope")], &columns).is_err());
    assert!(plan_fields(names, &[map("Name", "name"), map("Age", "name")], &columns).is_err());
    assert!(plan_fields(names, &[map("Age", "age")], &columns)
        .unwrap_err()
        .contains("name"));

    // CSV values arrive as text and convert per row.
    let fields = plan_fields(
        names,
        &[
            map("Name", "name"),
            map("Age", "age"),
            map("Joined", "joined"),
        ],
        &columns,
    )
    .unwrap();
    let rows = file_rows(&path, &options);
    assert_eq!(rows[0], vec![text("Ada"), text("36"), text("2024-01-15")]);
    assert_eq!(
        convert_row(1, &rows[0], &fields).unwrap(),
        vec![
            NamedValue {
                column: "name".into(),
                value: text("Ada")
            },
            NamedValue {
                column: "age".into(),
                value: DataValue::Integer(36)
            },
            NamedValue {
                column: "joined".into(),
                value: DataValue::Date("2024-01-15".into())
            },
        ]
    );
    // Row 4 repeats a unique name: its batch is retried row by row.
    let outcome = write_file(&mut store, "people", &fields, &path, &options, &layout);
    assert_eq!(outcome.aborted, None);
    assert_eq!((outcome.rows, outcome.imported, outcome.failed), (5, 2, 3));
    let reported: Vec<_> = outcome
        .errors
        .iter()
        .map(|e| (e.row, e.column.as_deref(), e.message.as_str()))
        .collect();
    assert_eq!(
        reported[..2],
        [
            (2, Some("age"), "age requires an integer"),
            (3, Some("name"), "name is required"),
        ]
    );
    assert_eq!((reported[2].0, reported[2].1), (4, None));
    assert!(
        reported[2].2.to_lowercase().contains("unique"),
        "{}",
        reported[2].2
    );
    let names = store
        .query_internal("SELECT name, age FROM people ORDER BY id")
        .unwrap();
    assert_eq!(
        names,
        vec![
            vec![Some("Ada".into()), Some("36".into())],
            vec![Some("Linus".into()), None],
        ]
    );
}

#[test]
fn a_late_value_that_breaks_the_sniffed_type_fails_only_its_row() {
    let dir = temp_dir();
    let mut csv = String::from("name,age\n");
    for i in 1..=30_005 {
        let age = if i == 30_002 {
            "n/a".to_string()
        } else {
            (i % 90).to_string()
        };
        csv.push_str(&format!("P{i},{age}\n"));
    }
    let path = write(&dir, "late.csv", &csv);
    let options = ParseOptions::default();
    // The preview sniffs the whole file, so the column is suggested as text.
    let preview = parse(&path, &options, 50).unwrap();
    assert_eq!(preview.total_rows, 30_005);
    assert_eq!(types(&preview)[1], ("age".into(), "text".into()));
    // Imported into an integer field, only the bad row is skipped.
    let layout = layout(&path, &options).unwrap();
    let mut store = people_store(&dir);
    let columns = table_fields(&mut store, "people").unwrap();
    let fields = plan_fields(
        &layout.names,
        &[map("name", "name"), map("age", "age")],
        &columns,
    )
    .unwrap();
    let outcome = write_file(&mut store, "people", &fields, &path, &options, &layout);
    assert_eq!(outcome.aborted, None);
    assert_eq!((outcome.imported, outcome.failed), (30_004, 1));
    assert_eq!(
        outcome.errors,
        vec![RowError {
            row: 30_002,
            column: Some("age".into()),
            message: "age requires an integer".into()
        }]
    );
}

#[test]
fn only_constraint_and_validation_errors_are_per_row() {
    let dir = temp_dir();
    let mut csv = String::from("name,age\n");
    for i in 1..=1_200 {
        csv.push_str(&format!("P{i},{}\n", if i == 700 { 101 } else { 30 }));
    }
    let path = write(&dir, "people.csv", &csv);
    let options = ParseOptions::default();
    let layout = layout(&path, &options).unwrap();
    let mut store = people_store(&dir);
    // A DATABASE_ERROR (an overflow here, like a full disk) stops the import; committed batches stay.
    rusqlite::Connection::open(dir.join("data.db"))
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON people WHEN NEW.age > 100 BEGIN SELECT abs(NEW.age - NEW.age - 9223372036854775807 - 1); END;",
        )
        .unwrap();
    let columns = table_fields(&mut store, "people").unwrap();
    let fields = plan_fields(
        &layout.names,
        &[map("name", "name"), map("age", "age")],
        &columns,
    )
    .unwrap();
    let outcome = write_file(&mut store, "people", &fields, &path, &options, &layout);
    assert_eq!(outcome.imported, 500);
    assert_eq!(outcome.failed, 0);
    assert!(
        outcome
            .aborted
            .as_deref()
            .is_some_and(|e| e.contains("overflow")),
        "{:?}",
        outcome.aborted
    );
    let count = store.query_internal("SELECT count(*) FROM people").unwrap();
    assert_eq!(count, vec![vec![Some("500".into())]]);
}

#[test]
fn files_over_the_size_caps_are_refused() {
    let dir = temp_dir();
    let path = write(&dir, "big.csv", &"a\n1\n".repeat(400_000));
    assert!(check_size(&path, 4 << 20).is_ok());
    let error = check_size(&path, 1 << 20).unwrap_err();
    assert_eq!(
        error,
        "The file is 2 MB; files over 1 MB cannot be imported"
    );
    assert!(check_size(&dir, 1 << 20)
        .unwrap_err()
        .contains("not a readable file"));
}

#[test]
fn xlsx_sheets_stream_and_refuse_too_many_columns() {
    // The used range claims A1:XFD1048576; only the cells that exist are read.
    let sparse = fixture("sparse.xlsx");
    let preview = parse(&sparse, &ParseOptions::default(), 50).unwrap();
    assert_eq!(
        types(&preview),
        [("name", "text"), ("age", "integer")].map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(preview.total_rows, 2);
    assert_eq!(
        preview.rows,
        vec![
            vec![text("Ada"), DataValue::Integer(36)],
            vec![text("Zed"), DataValue::Null]
        ]
    );
    assert_eq!(file_rows(&sparse, &ParseOptions::default()), preview.rows);
    let one = parse(&sparse, &ParseOptions::default(), 1).unwrap();
    assert_eq!((one.rows.len(), one.total_rows), (1, 2));
    let wide = fixture("wide.xlsx");
    for error in [
        parse(&wide, &ParseOptions::default(), 50).unwrap_err(),
        layout(&wide, &ParseOptions::default()).unwrap_err(),
    ] {
        assert!(error.contains("more than 1600 columns"), "{error}");
    }
}

#[test]
fn file_sources_validate_and_stay_inside_the_workspace() {
    let source = |name: &str, asset: &str, format| FileSource {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        asset_id: asset.into(),
        format,
        csv: CsvOptions::default(),
    };
    let asset = uuid::Uuid::now_v7().to_string();
    let config = DocumentConfig {
        file_sources: vec![
            source("sales", &asset, FileFormat::Csv),
            source("Sales", &asset, FileFormat::Csv),
            source("bad name", &asset, FileFormat::Csv),
            source("sheet", &asset, FileFormat::Xlsx),
            source("escape", "../../etc", FileFormat::Csv),
        ],
        ..Default::default()
    };
    let messages: Vec<String> = validate(&config).into_iter().map(|i| i.message).collect();
    assert_eq!(messages.len(), 4, "{messages:?}");
    assert!(messages[0].contains("Duplicate"));
    assert!(messages[1].contains("must start with a letter"));
    assert!(messages[2].contains("XLSX"));
    assert!(messages[3].contains("does not refer to an asset"));
    let workspace = Path::new("/work");
    let views = views(workspace, &config.file_sources);
    assert_eq!(
        views.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(),
        vec!["sales", "Sales"]
    );
    assert_eq!(
        views[0].path,
        crate::archive_io::asset_content(workspace, &asset)
    );
    // A document without sources keeps its config JSON unchanged.
    let json = serde_json::to_value(DocumentConfig::default()).unwrap();
    assert!(json.get("fileSources").is_none());
}
