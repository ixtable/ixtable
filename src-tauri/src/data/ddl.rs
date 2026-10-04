//! Store-neutral table definition model plus the SQLite `CREATE TABLE` /
//! `CREATE INDEX` parser. The DuckDB reader parses the DDL text it reads from
//! `sqlite_master`; the SQLite RecordStore parses the same text when planning
//! a rebuild, so both see one definition. PostgreSQL definitions arrive as
//! JSON from a catalog query (see `postgres.rs`).
use super::logical::LogicalType;
pub use super::model::*;

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Word(String),
    Ident(String),
    Str(String),
    Punct(char),
}
#[derive(Debug, Clone)]
struct Token {
    tok: Tok,
    start: usize,
    end: usize,
}
fn tokenize(sql: &str) -> Result<Vec<Token>, String> {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut out = vec![];
    while i < b.len() {
        let c = b[i] as char;
        let start = i;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '-' && b.get(i + 1) == Some(&b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        let quoted = |close: u8, i: &mut usize| -> Result<String, String> {
            let mut s = Vec::new();
            *i += 1;
            loop {
                if *i >= b.len() {
                    return Err("Unterminated quoted text in DDL".into());
                }
                if b[*i] == close {
                    if close != b']' && b.get(*i + 1) == Some(&close) {
                        s.push(close);
                        *i += 2;
                        continue;
                    }
                    *i += 1;
                    break;
                }
                s.push(b[*i]);
                *i += 1;
            }
            Ok(String::from_utf8_lossy(&s).into())
        };
        let tok = match c {
            '"' => Tok::Ident(quoted(b'"', &mut i)?),
            '`' => Tok::Ident(quoted(b'`', &mut i)?),
            '[' => Tok::Ident(quoted(b']', &mut i)?),
            '\'' => Tok::Str(quoted(b'\'', &mut i)?),
            _ if c.is_alphanumeric() || c == '_' || c == '$' || !c.is_ascii() => {
                while i < b.len() {
                    let ch = b[i] as char;
                    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' || b[i] >= 0x80 {
                        i += 1;
                    } else if ch == '.'
                        && b.get(i + 1).is_some_and(|n| n.is_ascii_digit())
                        && sql[start..i].chars().all(|x| x.is_ascii_digit())
                    {
                        i += 1;
                    } else {
                        break;
                    }
                }
                Tok::Word(sql[start..i].into())
            }
            _ => {
                i += c.len_utf8();
                Tok::Punct(c)
            }
        };
        out.push(Token { tok, start, end: i });
    }
    Ok(out)
}

struct Parser<'a> {
    sql: &'a str,
    toks: Vec<Token>,
    pos: usize,
}
impl<'a> Parser<'a> {
    fn new(sql: &'a str) -> Result<Self, String> {
        Ok(Self {
            sql,
            toks: tokenize(sql)?,
            pos: 0,
        })
    }
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos).map(|t| &t.tok)
    }
    fn kw(&self, word: &str) -> bool {
        matches!(self.peek(), Some(Tok::Word(w)) if w.eq_ignore_ascii_case(word))
    }
    fn eat_kw(&mut self, word: &str) -> bool {
        if self.kw(word) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn punct(&self, c: char) -> bool {
        matches!(self.peek(), Some(Tok::Punct(p)) if *p == c)
    }
    fn eat_punct(&mut self, c: char) -> bool {
        if self.punct(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn name(&mut self) -> Result<String, String> {
        let t = self.toks.get(self.pos).ok_or("Unexpected end of DDL")?;
        let out = match &t.tok {
            Tok::Word(w) | Tok::Ident(w) | Tok::Str(w) => w.clone(),
            Tok::Punct(p) => return Err(format!("Expected a name, found {p:?}")),
        };
        self.pos += 1;
        // schema-qualified names: keep the last part
        if self.punct('.') {
            self.pos += 1;
            return self.name();
        }
        Ok(out)
    }
    /// Consumes a balanced parenthesised group and returns its inner source text.
    fn group(&mut self) -> Result<String, String> {
        if !self.punct('(') {
            return Err("Expected (".into());
        }
        let open = self.toks[self.pos].end;
        let mut depth = 0;
        while let Some(t) = self.toks.get(self.pos) {
            match t.tok {
                Tok::Punct('(') => depth += 1,
                Tok::Punct(')') => {
                    depth -= 1;
                    if depth == 0 {
                        let close = t.start;
                        self.pos += 1;
                        return Ok(self.sql[open..close].trim().into());
                    }
                }
                _ => {}
            }
            self.pos += 1;
        }
        Err("Unbalanced parentheses in DDL".into())
    }
    fn name_list(&mut self) -> Result<Vec<String>, String> {
        let inner = self.group()?;
        let mut p = Parser::new(&inner)?;
        let mut out = vec![];
        while p.peek().is_some() {
            out.push(p.name()?);
            // skip COLLATE x / ASC / DESC / expressions up to next comma
            while p.peek().is_some() && !p.punct(',') {
                if p.punct('(') {
                    p.group()?;
                } else {
                    p.pos += 1;
                }
            }
            p.eat_punct(',');
        }
        Ok(out)
    }
    fn skip_conflict_clause(&mut self) {
        if self.kw("ON") {
            if let Some(Tok::Word(w)) = self.toks.get(self.pos + 1).map(|t| &t.tok) {
                if w.eq_ignore_ascii_case("CONFLICT") {
                    self.pos += 3;
                }
            }
        }
    }
    fn fk_tail(
        &mut self,
        columns: Vec<String>,
        name: Option<String>,
    ) -> Result<ForeignKeyDef, String> {
        let target_table = self.name()?;
        let target_columns = if self.punct('(') {
            self.name_list()?
        } else {
            vec![]
        };
        let mut fk = ForeignKeyDef {
            name,
            columns,
            target_table,
            target_columns,
            on_update: "NO ACTION".into(),
            on_delete: "NO ACTION".into(),
        };
        loop {
            if self.eat_kw("ON") {
                let update = self.eat_kw("UPDATE");
                if !update {
                    self.eat_kw("DELETE");
                }
                let action = if self.eat_kw("SET") {
                    if self.eat_kw("NULL") {
                        "SET NULL"
                    } else {
                        self.eat_kw("DEFAULT");
                        "SET DEFAULT"
                    }
                } else if self.eat_kw("CASCADE") {
                    "CASCADE"
                } else if self.eat_kw("RESTRICT") {
                    "RESTRICT"
                } else {
                    self.eat_kw("NO");
                    self.eat_kw("ACTION");
                    "NO ACTION"
                };
                if update {
                    fk.on_update = action.into()
                } else {
                    fk.on_delete = action.into()
                }
            } else if self.eat_kw("MATCH") {
                self.pos += 1;
            } else if self.kw("NOT") || self.kw("DEFERRABLE") {
                self.eat_kw("NOT");
                self.eat_kw("DEFERRABLE");
                if self.eat_kw("INITIALLY") {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
        Ok(fk)
    }
    fn expression_until_constraint(&mut self) -> String {
        // a bare DEFAULT literal: signed number, string, word (CURRENT_TIMESTAMP, NULL, TRUE)
        let start = self.toks[self.pos].start;
        if self.punct('-') || self.punct('+') {
            self.pos += 1;
        }
        let end = self.toks.get(self.pos).map(|t| t.end).unwrap_or(start);
        self.pos += 1;
        self.sql[start..end].trim().into()
    }
}

fn is_column_constraint_start(p: &Parser) -> bool {
    [
        "CONSTRAINT",
        "PRIMARY",
        "NOT",
        "NULL",
        "UNIQUE",
        "CHECK",
        "DEFAULT",
        "COLLATE",
        "REFERENCES",
        "GENERATED",
        "AS",
    ]
    .iter()
    .any(|k| p.kw(k))
}

/// Parses one SQLite `CREATE TABLE` statement.
pub fn parse_sqlite_create_table(sql: &str) -> Result<TableDef, String> {
    let mut p = Parser::new(sql)?;
    if !p.eat_kw("CREATE") {
        return Err("Expected CREATE TABLE".into());
    }
    p.eat_kw("TEMP");
    p.eat_kw("TEMPORARY");
    if !p.eat_kw("TABLE") {
        return Err("Expected CREATE TABLE".into());
    }
    if p.eat_kw("IF") {
        p.eat_kw("NOT");
        p.eat_kw("EXISTS");
    }
    let name = p.name()?;
    let body = p.group()?;
    let mut table = TableDef {
        name,
        ..Default::default()
    };
    while let Some(Tok::Word(w)) = p.peek() {
        if w.eq_ignore_ascii_case("ROWID") {
            table.without_rowid = true;
        }
        p.pos += 1;
        p.eat_punct(',');
    }
    let mut b = Parser::new(&body)?;
    while b.peek().is_some() {
        let mut constraint_name = None;
        if b.eat_kw("CONSTRAINT") {
            constraint_name = Some(b.name()?);
        }
        if b.eat_kw("PRIMARY") {
            b.eat_kw("KEY");
            table.primary_key = b.name_list()?;
            table.primary_key_name = constraint_name;
            b.skip_conflict_clause();
        } else if b.eat_kw("UNIQUE") {
            let columns = b.name_list()?;
            b.skip_conflict_clause();
            table.uniques.push(UniqueDef {
                name: constraint_name,
                columns,
            });
        } else if b.eat_kw("CHECK") {
            let expression = b.group()?;
            push_check(&mut table, constraint_name, expression);
        } else if b.eat_kw("FOREIGN") {
            b.eat_kw("KEY");
            let columns = b.name_list()?;
            if !b.eat_kw("REFERENCES") {
                return Err("Expected REFERENCES".into());
            }
            let fk = b.fk_tail(columns, constraint_name)?;
            table.foreign_keys.push(fk);
        } else {
            parse_column(&mut b, &mut table)?;
        }
        // skip anything unrecognised up to the next top-level comma
        while b.peek().is_some() && !b.punct(',') {
            if b.punct('(') {
                b.group()?;
            } else {
                b.pos += 1;
            }
        }
        b.eat_punct(',');
    }
    Ok(table)
}

fn push_check(table: &mut TableDef, name: Option<String>, expression: String) {
    // Generated logical-type CHECKs stay out of the model; a rebuild regenerates them.
    if name.as_deref().is_some_and(|n| n.starts_with("ixt_type_")) {
        return;
    }
    table.checks.push(CheckDef { name, expression });
}

fn parse_column(b: &mut Parser, table: &mut TableDef) -> Result<(), String> {
    let name = b.name()?;
    let type_start = b.toks.get(b.pos).map(|t| t.start);
    let mut type_end = None;
    while b.peek().is_some() && !b.punct(',') && !is_column_constraint_start(b) {
        if b.punct('(') {
            b.group()?;
        } else {
            b.pos += 1;
        }
        type_end = b.toks.get(b.pos - 1).map(|t| t.end);
    }
    let declared_type = match (type_start, type_end) {
        (Some(s), Some(e)) => b.sql[s..e].trim().to_string(),
        _ => String::new(),
    };
    let mut column = ColumnDef {
        logical_type: LogicalType::from_sqlite_declared(&declared_type),
        name: name.clone(),
        declared_type,
        nullable: true,
        default_expression: None,
        generated_expression: None,
        identity: false,
    };
    while b.peek().is_some() && !b.punct(',') {
        let mut constraint_name = None;
        if b.eat_kw("CONSTRAINT") {
            constraint_name = Some(b.name()?);
        }
        if b.eat_kw("PRIMARY") {
            b.eat_kw("KEY");
            b.eat_kw("ASC");
            b.eat_kw("DESC");
            b.skip_conflict_clause();
            if b.eat_kw("AUTOINCREMENT") {
                table.autoincrement = true;
            }
            table.primary_key = vec![name.clone()];
            table.primary_key_name = constraint_name;
        } else if b.eat_kw("NOT") {
            b.eat_kw("NULL");
            b.skip_conflict_clause();
            column.nullable = false;
        } else if b.eat_kw("NULL") {
            b.skip_conflict_clause();
        } else if b.eat_kw("UNIQUE") {
            b.skip_conflict_clause();
            table.uniques.push(UniqueDef {
                name: constraint_name,
                columns: vec![name.clone()],
            });
        } else if b.eat_kw("CHECK") {
            let expression = b.group()?;
            push_check(table, constraint_name, expression);
        } else if b.eat_kw("DEFAULT") {
            column.default_expression = Some(if b.punct('(') {
                format!("({})", b.group()?)
            } else {
                b.expression_until_constraint()
            });
        } else if b.eat_kw("COLLATE") {
            b.name()?;
        } else if b.eat_kw("REFERENCES") {
            let fk = b.fk_tail(vec![name.clone()], constraint_name)?;
            table.foreign_keys.push(fk);
        } else if b.kw("GENERATED") || b.kw("AS") {
            b.eat_kw("GENERATED");
            b.eat_kw("ALWAYS");
            b.eat_kw("AS");
            column.generated_expression = Some(b.group()?);
            b.eat_kw("STORED");
            b.eat_kw("VIRTUAL");
        } else {
            b.pos += 1;
        }
    }
    table.columns.push(column);
    Ok(())
}

/// Parses `CREATE [UNIQUE] INDEX name ON table (columns)`.
pub fn parse_sqlite_create_index(sql: &str) -> Result<IndexDef, String> {
    let mut p = Parser::new(sql)?;
    if !p.eat_kw("CREATE") {
        return Err("Expected CREATE INDEX".into());
    }
    let unique = p.eat_kw("UNIQUE");
    if !p.eat_kw("INDEX") {
        return Err("Expected CREATE INDEX".into());
    }
    if p.eat_kw("IF") {
        p.eat_kw("NOT");
        p.eat_kw("EXISTS");
    }
    let name = p.name()?;
    if !p.eat_kw("ON") {
        return Err("Expected ON".into());
    }
    let table = p.name()?;
    let columns = p.name_list()?;
    Ok(IndexDef {
        name,
        table,
        columns,
        unique,
        sql: Some(sql.trim().into()),
    })
}
