//! Token-aware SQL text helpers shared by the read guard and migration checks.
//!
//! `mask` blanks the contents of string literals (`'..'`, `E'..'`, `$tag$..$tag$`),
//! quoted identifiers (`".."`) and comments, so keyword and `;` checks only see
//! SQL code. The scanning rules match `queries::rewrite_placeholders`.

fn ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `sql` with literal, quoted-identifier and comment contents replaced by spaces.
/// Quote characters are kept. Byte offsets are preserved (each masked character
/// becomes as many spaces as its UTF-8 length), so positions in the mask index
/// the original text.
pub fn mask(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let blank = |out: &mut String, c: char| {
        for _ in 0..c.len_utf8() {
            out.push(if c == '\n' { '\n' } else { ' ' });
        }
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\'' | '"' => {
                let escapes = c == '\''
                    && i > 0
                    && matches!(chars[i - 1], 'e' | 'E')
                    && (i < 2 || !ident_char(chars[i - 2]));
                out.push(c);
                i += 1;
                while i < chars.len() {
                    let d = chars[i];
                    i += 1;
                    if escapes && d == '\\' {
                        blank(&mut out, d);
                        if let Some(&e) = chars.get(i) {
                            blank(&mut out, e);
                            i += 1;
                        }
                    } else if d == c {
                        if chars.get(i) == Some(&c) {
                            blank(&mut out, d);
                            blank(&mut out, c);
                            i += 1;
                        } else {
                            out.push(c);
                            break;
                        }
                    } else {
                        blank(&mut out, d);
                    }
                }
            }
            '-' if next == Some('-') => {
                while i < chars.len() && chars[i] != '\n' {
                    blank(&mut out, chars[i]);
                    i += 1;
                }
            }
            '/' if next == Some('*') => {
                let mut end = i + 2;
                while end < chars.len() && !(chars[end] == '*' && chars.get(end + 1) == Some(&'/'))
                {
                    end += 1;
                }
                let end = (end + 2).min(chars.len());
                for &d in &chars[i..end] {
                    blank(&mut out, d);
                }
                i = end;
            }
            '$' => {
                let mut j = i + 1;
                while j < chars.len() && ident_char(chars[j]) {
                    j += 1;
                }
                let tag_ok = chars.get(i + 1).is_none_or(|c| !c.is_ascii_digit());
                if chars.get(j) == Some(&'$') && tag_ok {
                    let tag: String = chars[i..=j].iter().collect();
                    let rest: String = chars[j + 1..].iter().collect();
                    let end = rest
                        .find(&tag)
                        .map(|p| j + 1 + rest[..p].chars().count() + tag.chars().count())
                        .unwrap_or(chars.len());
                    out.push('\'');
                    for &d in &chars[i + 1..end.saturating_sub(1).max(i + 1)] {
                        blank(&mut out, d);
                    }
                    if end > i + 1 {
                        out.push('\'');
                    }
                    i = end;
                } else {
                    out.extend(&chars[i..j]);
                    i = j;
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Upper-cased words of masked SQL, with `;` as its own token.
fn tokens(masked: &str) -> Vec<String> {
    let mut out = vec![];
    let mut word = String::new();
    for c in masked.chars() {
        if ident_char(c) {
            word.push(c.to_ascii_uppercase());
            continue;
        }
        if !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        if c == ';' {
            out.push(";".into());
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// Keywords that open, end or nest a transaction.
const TRANSACTION_CONTROL: [&str; 8] = [
    "BEGIN",
    "START",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT",
    "RELEASE",
];

/// The first statement in `sql` that controls transactions (`BEGIN`, `COMMIT`,
/// `ROLLBACK`, `END`, `SAVEPOINT`, `RELEASE`, ...), as its leading keyword.
/// Strings, quoted identifiers and comments are ignored, and the `BEGIN ... END`
/// bodies of `CREATE TRIGGER` / `BEGIN ATOMIC` functions are not statements.
pub fn transaction_control(sql: &str) -> Option<String> {
    let tokens = tokens(&mask(sql));
    let statements = tokens.split(|t| t == ";").filter(|s| !s.is_empty());
    let mut in_body = false;
    for statement in statements {
        let first = statement[0].as_str();
        if in_body {
            if first == "END" {
                in_body = false;
            }
            continue;
        }
        if first == "CREATE" && statement.iter().skip(1).any(|t| t == "BEGIN") {
            // A body whose last statement ends this one is closed by `END` here.
            in_body = statement.last().is_none_or(|t| t != "END");
            continue;
        }
        if TRANSACTION_CONTROL.contains(&first) {
            return Some(first.to_string());
        }
    }
    None
}

/// Error message for migration SQL that controls transactions itself.
pub fn transaction_control_error(sql: &str) -> Option<String> {
    transaction_control(sql).map(|word| {
        format!("{word} is not allowed in migration SQL: ixtable runs each migration in its own transaction")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_blanks_literals_identifiers_and_comments() {
        let sql = "SELECT 'a;b', \"update\", E'x\\'y' -- delete;\n/* drop; */ FROM t WHERE x = $$;$$ AND y = $1";
        let m = mask(sql);
        assert_eq!(m.len(), sql.len());
        assert!(!m.contains(';'), "{m}");
        assert!(!m.to_ascii_uppercase().contains("UPDATE"), "{m}");
        assert!(!m.to_ascii_uppercase().contains("DELETE"), "{m}");
        assert!(!m.to_ascii_uppercase().contains("DROP"), "{m}");
        assert!(m.contains("$1"), "{m}");
        assert!(m.contains("FROM t"), "{m}");
        assert_eq!(mask("SELECT 'é;'"), "SELECT '   '");
    }

    #[test]
    fn transaction_control_is_found_outside_strings_and_bodies() {
        for (sql, word) in [
            ("BEGIN; CREATE TABLE a(x INT); COMMIT;", "BEGIN"),
            ("CREATE TABLE a(x INT);\ncommit", "COMMIT"),
            ("SAVEPOINT s; CREATE TABLE a(x INT); RELEASE s", "SAVEPOINT"),
            ("CREATE TABLE a(x INT); ROLLBACK", "ROLLBACK"),
            ("CREATE TABLE a(x INT); END", "END"),
            ("start transaction; select 1", "START"),
        ] {
            assert_eq!(transaction_control(sql).as_deref(), Some(word), "{sql}");
        }
        for sql in [
            "CREATE TABLE a(x INT); INSERT INTO a VALUES (1)",
            "INSERT INTO log(msg) VALUES ('BEGIN; COMMIT')",
            "-- begin\nCREATE TABLE \"commit\"(x INT) /* ROLLBACK; */",
            "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1; INSERT INTO b VALUES (CASE WHEN 1 THEN 2 END); END; CREATE TABLE c(x INT)",
            "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$; SELECT 1",
            "CREATE TABLE a(begin_at TEXT, ended INT)",
        ] {
            assert_eq!(transaction_control(sql), None, "{sql}");
        }
        assert!(transaction_control(
            "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END; COMMIT"
        )
        .is_some());
    }
}
