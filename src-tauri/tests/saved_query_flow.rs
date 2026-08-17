use ixtable_lib::{data::DataValue, manager::DocumentManager};
use std::fs;

#[test]
fn creates_saves_executes_and_updates_a_saved_query() {
    let root = std::env::temp_dir().join(format!("ixtable-saved-query-{}", uuid::Uuid::new_v4()));
    let manager = DocumentManager::new(root.join("data"), root.join("cache")).unwrap();
    manager.new_session("integration").unwrap();

    let created = manager
        .save_query(
            "integration",
            None,
            "Initial value".into(),
            "SELECT 42 AS value".into(),
            None,
        )
        .unwrap();
    assert_eq!(created.saved_queries.len(), 1);
    let query_id = created.saved_queries[0].id.clone();
    assert_eq!(created.saved_queries[0].name, "Initial value");
    assert_eq!(created.saved_queries[0].sql, "SELECT 42 AS value");

    let initial_result = manager
        .read_query("integration", &created.saved_queries[0].sql)
        .unwrap();
    assert_eq!(initial_result.columns, ["value"]);
    assert_eq!(initial_result.rows, vec![vec![DataValue::Integer(42)]]);

    let updated = manager
        .save_query(
            "integration",
            Some(query_id.clone()),
            "Updated value".into(),
            "SELECT 84 AS value".into(),
            None,
        )
        .unwrap();
    assert_eq!(updated.saved_queries.len(), 1);
    assert_eq!(updated.saved_queries[0].id, query_id);
    assert_eq!(updated.saved_queries[0].name, "Updated value");
    assert_eq!(updated.saved_queries[0].sql, "SELECT 84 AS value");
    assert_eq!(manager.config("integration").unwrap(), updated);

    let updated_result = manager
        .read_query("integration", &updated.saved_queries[0].sql)
        .unwrap();
    assert_eq!(updated_result.columns, ["value"]);
    assert_eq!(updated_result.rows, vec![vec![DataValue::Integer(84)]]);

    manager.close("integration", true).unwrap();
    fs::remove_dir_all(root).unwrap();
}
