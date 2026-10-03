use super::logical::*;
use super::DataValue;

#[test]
fn logical_types_round_trip_through_their_names_and_physical_types() {
    for name in LOGICAL_TYPE_NAMES {
        let t: LogicalType = name.parse().unwrap();
        assert_eq!(&t.to_string(), name);
        assert_eq!(LogicalType::from_sqlite_declared(&t.sqlite_declared()), t);
        assert_eq!(LogicalType::from_postgres(&t.postgres_type()), t);
    }
    let d: LogicalType = "decimal(12, 3)".parse().unwrap();
    assert_eq!(d.to_string(), "decimal(12,3)");
    assert_eq!(LogicalType::from_sqlite_declared("DECIMAL(12,3)"), d);
    assert_eq!(LogicalType::from_postgres("numeric(12,3)"), d);
    assert_eq!(
        LogicalType::from_postgres("timestamp without time zone"),
        LogicalType::Timestamp
    );
    assert_eq!(
        LogicalType::from_postgres("time without time zone"),
        LogicalType::Time
    );
    assert!("decimal(3,4)".parse::<LogicalType>().is_err());
    assert!("money".parse::<LogicalType>().is_err());
    assert_eq!(
        LogicalType::from_sqlite_declared("VARCHAR(20)"),
        LogicalType::Text
    );
}

#[test]
fn decimals_are_validated_and_canonical() {
    assert_eq!(canonical_decimal("12.3", Some(10), 2).unwrap(), "12.30");
    assert_eq!(canonical_decimal("-0.00", Some(10), 2).unwrap(), "0.00");
    assert_eq!(canonical_decimal("1.5e2", Some(10), 2).unwrap(), "150.00");
    assert_eq!(canonical_decimal("007", None, 0).unwrap(), "7");
    assert_eq!(canonical_decimal(".5", None, 0).unwrap(), "0.5");
    assert!(canonical_decimal("1.234", Some(10), 2).is_err());
    assert!(canonical_decimal("123456789", Some(10), 2).is_err());
    assert!(canonical_decimal("abc", None, 0).is_err());
}

#[test]
fn normalization_accepts_typed_text_and_rejects_bad_values() {
    let ts = LogicalType::Timestamp;
    assert_eq!(
        ts.normalize("at", &DataValue::Text("2024-01-31 13:05:09.120".into()))
            .unwrap(),
        DataValue::Timestamp("2024-01-31T13:05:09.12".into())
    );
    assert_eq!(
        ts.normalize("at", &DataValue::Text("2024-01-31T15:05:09+02:00".into()))
            .unwrap(),
        DataValue::Timestamp("2024-01-31T13:05:09".into())
    );
    assert_eq!(
        LogicalType::Boolean
            .normalize("ok", &DataValue::Text("TRUE".into()))
            .unwrap(),
        DataValue::Boolean(true)
    );
    assert!(LogicalType::Date
        .normalize("d", &DataValue::Text("2024-02-30".into()))
        .is_err());
    assert!(LogicalType::Integer
        .normalize("n", &DataValue::Text("x".into()))
        .is_err());
    assert_eq!(
        LogicalType::Uuid
            .normalize(
                "u",
                &DataValue::Text("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11".into())
            )
            .unwrap(),
        DataValue::Text("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into())
    );
    assert!(LogicalType::Json
        .normalize("j", &DataValue::Text("{bad".into()))
        .is_err());
}

#[test]
fn reads_are_coerced_to_canonical_forms() {
    let d = LogicalType::Decimal {
        precision: Some(10),
        scale: 2,
    };
    assert_eq!(
        d.coerce_read(DataValue::Real(12.3)),
        DataValue::Decimal("12.30".into())
    );
    assert_eq!(
        d.coerce_read(DataValue::Integer(4)),
        DataValue::Decimal("4.00".into())
    );
    assert_eq!(
        LogicalType::Boolean.coerce_read(DataValue::Integer(1)),
        DataValue::Boolean(true)
    );
    assert_eq!(
        LogicalType::Time.coerce_read(DataValue::Text("10:30:00".into())),
        DataValue::Time("10:30:00".into())
    );
}
