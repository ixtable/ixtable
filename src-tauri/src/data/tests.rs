use super::*;
use std::sync::{Arc, Mutex};

#[test]
fn duckdb_reader_is_session_serializable_and_keeps_full_width_values() {
    // The session runtime is moved to another thread behind its mutex.
    let runtime = Arc::new(Mutex::new(ReadRuntime::isolated_for_test().unwrap()));
    let worker = Arc::clone(&runtime);
    let result = std::thread::spawn(move || {
        let guard = worker.lock().unwrap();
        guard
            .connection()
            .query_row(
                "SELECT CAST(9223372036854775807 AS BIGINT), CAST(-9223372036854775808 AS BIGINT), CAST('00FF' AS BLOB)",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, Vec<u8>>(2)?)),
            )
            .unwrap()
    })
    .join()
    .unwrap();
    assert_eq!(result.0, i64::MAX);
    assert_eq!(result.1, i64::MIN);
    assert_eq!(result.2, b"00FF");
}

#[test]
fn duckdb_reader_rejects_extension_autoload() {
    let runtime = ReadRuntime::isolated_for_test().unwrap();
    let error = runtime
        .connection()
        .execute_batch("LOAD definitely_not_an_installed_extension")
        .unwrap_err()
        .to_string();
    assert!(error.to_ascii_lowercase().contains("extension"));
}

#[test]
fn duckdb_values_convert_losslessly_to_canonical_forms() {
    let runtime = ReadRuntime::isolated_for_test().unwrap();
    let row: Vec<DataValue> = runtime
        .connection()
        .query_row(
            "SELECT CAST('12345678901234567890.12' AS DECIMAL(22,2)), DATE '2024-02-29', TIME '13:05:09.25', \
             TIMESTAMP '2024-01-31 13:05:09.000123', CAST(-0.5 AS DECIMAL(4,2)), [1,2], {'a': 1}, \
             CAST(18446744073709551615 AS UBIGINT), true, NULL",
            [],
            |r| Ok((0..10).map(|i| duck_value(r.get(i).unwrap())).collect()),
        )
        .unwrap();
    assert_eq!(
        row,
        vec![
            DataValue::Decimal("12345678901234567890.12".into()),
            DataValue::Date("2024-02-29".into()),
            DataValue::Time("13:05:09.25".into()),
            DataValue::Timestamp("2024-01-31T13:05:09.000123".into()),
            DataValue::Decimal("-0.50".into()),
            DataValue::Text("[1,2]".into()),
            DataValue::Text("{\"a\":1}".into()),
            DataValue::Decimal("18446744073709551615".into()),
            DataValue::Boolean(true),
            DataValue::Null,
        ]
    );
}

#[test]
fn read_only_guard_rejects_writes_and_scanner_functions() {
    for sql in [
        "DELETE FROM item",
        "SELECT * FROM read_csv('/tmp/x.csv')",
        "SELECT * FROM postgres_query('data', 'DELETE FROM t')",
        "SELECT 1; SELECT 2",
    ] {
        assert!(read_only_guard(sql).is_err(), "{sql}");
    }
    assert!(read_only_guard("WITH x AS (SELECT 1) SELECT * FROM x").is_ok());
}
