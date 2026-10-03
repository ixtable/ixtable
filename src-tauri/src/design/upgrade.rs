//! Upgrades older serialized design schemas (v1, v2) to the current shape.
use super::DESIGN_SCHEMA_VERSION;
use serde_json::{json, Map, Value};

/// Rewrites a v1/v2 design value into v3. Newer versions pass through unchanged
/// so structural validation can reject them.
pub fn upgrade_value(mut value: Value) -> Value {
    let Some(design) = value.as_object_mut() else {
        return value;
    };
    let version = design
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or(DESIGN_SCHEMA_VERSION as u64);
    if version >= DESIGN_SCHEMA_VERSION as u64 {
        return value;
    }
    if let Some(forms) = design.get_mut("forms").and_then(Value::as_array_mut) {
        forms
            .iter_mut()
            .filter_map(Value::as_object_mut)
            .for_each(upgrade_form);
    }
    let mut first_nav = None;
    if let Some(items) = design.get_mut("navigation").and_then(Value::as_array_mut) {
        for item in items.iter_mut().filter_map(Value::as_object_mut) {
            if let Some(form_id) = item.remove("formId") {
                item.insert("kind".into(), json!("form"));
                item.insert("targetId".into(), form_id);
            }
            if first_nav.is_none() {
                first_nav = item.get("id").cloned();
            }
        }
    }
    if !design.contains_key("startPage") {
        design.insert("startPage".into(), first_nav.unwrap_or(Value::Null));
    }
    design.insert("version".into(), json!(DESIGN_SCHEMA_VERSION));
    value
}

fn upgrade_form(form: &mut Map<String, Value>) {
    if let Some(table) = form.remove("table") {
        if let Some(name) = table.as_str().filter(|name| !name.is_empty()) {
            form.insert("source".into(), json!({"kind": "table", "table": name}));
        }
    }
    let Some(controls) = form.get_mut("controls").and_then(Value::as_array_mut) else {
        return;
    };
    for control in controls.iter_mut().filter_map(Value::as_object_mut) {
        if control.get("kind").and_then(Value::as_str) == Some("checkbox") {
            control.insert("kind".into(), json!("boolean"));
        }
    }
}
