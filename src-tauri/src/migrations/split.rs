//! Splits migration SQL into statements the way SQLite does, so the preview
//! matches what executes: semicolons inside string literals, comments, and
//! `CREATE TRIGGER ... END` bodies do not end a statement.
use std::ffi::CString;

fn complete(sql: &str) -> bool {
    CString::new(sql)
        // SAFETY: `c` is a valid NUL-terminated string for the duration of the call.
        .map(|c| unsafe { rusqlite::ffi::sqlite3_complete(c.as_ptr()) != 0 })
        .unwrap_or(false)
}

/// Statements in order, each trimmed and ending with `;`.
pub fn statements(sql: &str) -> Vec<String> {
    let mut out = vec![];
    let mut start = 0;
    for (i, ch) in sql.char_indices() {
        if ch == ';' && complete(&sql[start..=i]) {
            out.push(sql[start..=i].trim().to_string());
            start = i + 1;
        }
    }
    let rest = sql[start..].trim();
    if !rest.is_empty() {
        out.push(format!("{rest};"));
    }
    out.retain(|s| s != ";");
    out
}
