//! Local diagnostic log (PRD §27.5): `<state>/logs/ixtable.log`, rotated at ~5 MB,
//! with secrets redacted before anything reaches disk (PRD §27.2).
//!
//! Every module may call [`log`]. Logging never fails the caller: I/O errors are dropped.
use crate::manager::AppError;
use chrono::Utc;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const LOG_FILE: &str = "ixtable.log";
/// Keys whose values are masked wherever they appear as `key=value` or `"key": value`.
const SECRET_KEYS: [&str; 9] = [
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "authorization",
    "passphrase",
];
const MASK: &str = "***";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub area: String,
    pub message: String,
}

/// A size-capped log file with one rotated generation (`<file>.1`).
pub struct Logger {
    path: PathBuf,
    max_bytes: u64,
}
impl Logger {
    pub fn new(path: PathBuf, max_bytes: u64) -> Self {
        Self { path, max_bytes }
    }
    fn rotated(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".1");
        PathBuf::from(name)
    }
    pub fn write(&self, level: &str, area: &str, message: &str) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let line = format!(
            "{}\t{}\t{}\t{}\n",
            Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            one_line(&level.to_ascii_uppercase()),
            one_line(area),
            one_line(&redact(message))
        );
        let size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size + line.len() as u64 > self.max_bytes {
            fs::rename(&self.path, self.rotated())?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(line.as_bytes())
    }
    /// The newest `limit` entries, oldest first, spanning the rotated file when needed.
    pub fn read(&self, limit: usize) -> Vec<LogEntry> {
        let mut lines: Vec<String> = Vec::new();
        for file in [self.rotated(), self.path.clone()] {
            if let Ok(text) = fs::read_to_string(&file) {
                lines.extend(text.lines().map(str::to_owned));
            }
        }
        let start = lines.len().saturating_sub(limit);
        lines[start..].iter().filter_map(|l| parse(l)).collect()
    }
}

fn parse(line: &str) -> Option<LogEntry> {
    let mut parts = line.splitn(4, '\t');
    Some(LogEntry {
        timestamp: parts.next()?.into(),
        level: parts.next()?.into(),
        area: parts.next()?.into(),
        message: parts.next()?.into(),
    })
}
fn one_line(text: &str) -> String {
    text.replace(['\n', '\r', '\t'], " ")
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/// Points the global log at `<dir>/ixtable.log`. The first call wins.
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}
pub fn log_dir() -> PathBuf {
    DIR.get_or_init(|| crate::paths::state_dir().join("logs"))
        .clone()
}
fn global() -> Logger {
    Logger::new(log_dir().join(LOG_FILE), MAX_LOG_BYTES)
}

/// Appends one redacted line to the local diagnostic log. Never fails.
pub fn log(level: &str, area: &str, message: &str) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _ = global().write(level, area, message);
}
pub fn info(area: &str, message: &str) {
    log("info", area, message);
}
pub fn warn(area: &str, message: &str) {
    log("warn", area, message);
}
pub fn error(area: &str, message: &str) {
    log("error", area, message);
}

/// Masks URL credentials (`scheme://user:pass@`) and `key=value` / `"key": "value"` secrets.
pub fn redact(text: &str) -> String {
    redact_keys(&redact_urls(text))
}

fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        // Passwords may contain `@ / ? #`: take the whole token and split
        // user info at its LAST `@` (over-masking beats leaking).
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority
            .rfind('@')
            .and_then(|at| authority[..at].find(':').map(|colon| (at, colon)))
        {
            Some((at, colon)) => {
                out.push_str(&authority[..=colon]);
                out.push_str(MASK);
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn redact_keys(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    'scan: while i < bytes.len() {
        for key in SECRET_KEYS {
            if !lower[i..].starts_with(key) || (i > 0 && is_word(bytes[i - 1])) {
                continue;
            }
            let mut j = i + key.len();
            while j < bytes.len() && (is_word(bytes[j]) || bytes[j] == b'"' || bytes[j] == b'\'') {
                if bytes[j] == b'"' || bytes[j] == b'\'' {
                    j += 1;
                    break;
                }
                j += 1;
            }
            while j < bytes.len() && bytes[j] == b' ' {
                j += 1;
            }
            if j >= bytes.len() || !matches!(bytes[j], b'=' | b':') {
                continue;
            }
            j += 1;
            while j < bytes.len() && bytes[j] == b' ' {
                j += 1;
            }
            let (value_start, value_end) = if j < bytes.len() && matches!(bytes[j], b'"' | b'\'') {
                (j + 1, closing_quote(bytes, j))
            } else {
                let end = (j..bytes.len())
                    .find(|&k| {
                        bytes[k].is_ascii_whitespace()
                            || matches!(bytes[k], b'"' | b'\'' | b';' | b'&' | b',' | b'}')
                    })
                    .unwrap_or(bytes.len());
                (j, end)
            };
            if value_end == value_start {
                continue;
            }
            out.push_str(&text[i..value_start]);
            out.push_str(MASK);
            i = value_end;
            continue 'scan;
        }
        let ch = text[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}
/// Index of the quote closing the value opened at `open` (or the end of the
/// text): honors backslash escapes (`'it\\'s'`) and doubled quotes (`'it''s'`).
fn closing_quote(bytes: &[u8], open: usize) -> usize {
    let quote = bytes[open];
    let mut k = open + 1;
    while k < bytes.len() {
        match bytes[k] {
            b'\\' => k += 2,
            b if b == quote && bytes.get(k + 1) == Some(&quote) => k += 2,
            b if b == quote => return k,
            _ => k += 1,
        }
    }
    bytes.len()
}
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The newest `limit` (default 200, max 5000) diagnostic log entries.
#[tauri::command]
pub fn read_logs(window_label: String, limit: Option<usize>) -> Result<Vec<LogEntry>, AppError> {
    let _ = window_label;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(global().read(limit.unwrap_or(200).min(5000)))
}

/// Writes a frontend diagnostic line (level `info`/`warn`/`error`) to the local log.
#[tauri::command]
pub fn write_log(
    window_label: String,
    level: String,
    area: String,
    message: String,
) -> Result<(), AppError> {
    let _ = window_label;
    let level = match level.as_str() {
        "warn" | "error" | "debug" => level,
        _ => "info".into(),
    };
    log(&level, &format!("ui:{area}"), &message);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_connection_strings_and_password_pairs() {
        let text = "connect postgres://admin:s3cr3t@db.local:5432/app failed";
        assert_eq!(
            redact(text),
            "connect postgres://admin:***@db.local:5432/app failed"
        );
        assert_eq!(
            redact("host=db user=me password=hunter2 sslmode=require"),
            "host=db user=me password=*** sslmode=require"
        );
        assert_eq!(
            redact(r#"{"password": "hunter2", "name": "x"}"#),
            r#"{"password": "***", "name": "x"}"#
        );
        assert_eq!(redact("Server=x;Pwd=abc;Db=y"), "Server=x;Pwd=***;Db=y");
        assert_eq!(redact("API_KEY: sk-123"), "API_KEY: ***");
        assert_eq!(redact("https://example.com/a"), "https://example.com/a");
        assert_eq!(redact("passwords are fine"), "passwords are fine");
        assert_eq!(redact("über token=x ✓"), "über token=*** ✓");
    }

    #[test]
    fn redacts_quoted_values_with_spaces_and_escapes() {
        for (input, expected) in [
            ("password='ab cd' user=x", "password='***' user=x"),
            (r"password='it\'s' user=x", "password='***' user=x"),
            ("password='it''s secret' user=x", "password='***' user=x"),
            (r#"pwd="x y" db=z"#, r#"pwd="***" db=z"#),
            (
                r#"{"password": "a \"b\" c", "n": 1}"#,
                r#"{"password": "***", "n": 1}"#,
            ),
            ("password='unterminated secret", "password='***"),
            ("password='' user=x", "password='' user=x"),
        ] {
            assert_eq!(redact(input), expected, "{input}");
        }
        for (input, expected) in [
            (
                "postgres://admin:p@ss%20w@rd@db.local/app",
                "postgres://admin:***@db.local/app",
            ),
            (
                "postgres://u:pa/ss?#x@db.local/app",
                "postgres://u:***@db.local/app",
            ),
            ("'postgres://u:p@ss@h/db'", "'postgres://u:***@h/db'"),
        ] {
            assert_eq!(redact(input), expected, "{input}");
        }
        assert_eq!(
            redact("postgres://admin:p@ss@db.local:5432/app x"),
            "postgres://admin:***@db.local:5432/app x"
        );
        assert_eq!(
            redact("see https://example.com/users/@me"),
            "see https://example.com/users/@me"
        );
    }

    #[test]
    fn rotates_and_reads_across_generations() {
        let dir = std::env::temp_dir().join(format!("ixtable-log-{}", uuid::Uuid::new_v4()));
        let logger = Logger::new(dir.join("test.log"), 300);
        for n in 0..20 {
            logger
                .write("info", "save", &format!("event {n} password=pw{n}\nnext"))
                .unwrap();
        }
        assert!(fs::metadata(dir.join("test.log")).unwrap().len() <= 300);
        assert!(dir.join("test.log.1").exists());
        let entries = logger.read(3);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[2].message, "event 19 password=*** next");
        assert_eq!(entries[2].level, "INFO");
        assert_eq!(entries[2].area, "save");
        fs::remove_dir_all(dir).unwrap();
    }
}
