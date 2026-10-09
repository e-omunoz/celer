//! Variables `${name}` (src/variables.ts) for what runs outside a console: the MCP tools. The interface keeps them in
//! `variables.json`: the global ones and those of each connection. A connection's value wins over the global one (the
//! console scope only exists in the interface). Nothing inside strings, quoted identifiers or comments is replaced; a
//! value goes in as a literal (numbers, NULL, TRUE and FALSE as they are, the rest quoted) unless it is marked as SQL.
//! The lexing follows `scan` in src/sql.ts, so the interface and the MCP server replace the same `${name}`.

use std::collections::HashMap;

use crate::model::DbKind;
use crate::store::Store;

#[derive(Clone, Debug, PartialEq)]
pub struct Var {
    pub value: String,
    /// Written as typed (a table name, a list for IN…), not as a quoted literal.
    pub raw: bool,
}

const FILE: &str = "variables.json";

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_') && name.len() <= 63
}

/// The variables that apply on `conn_id`: its own, then the global ones. A missing or damaged file gives none.
pub fn for_connection(store: &Store, conn_id: &str) -> HashMap<String, Var> {
    let Some(text) = store.read(FILE) else { return HashMap::new() };
    let Ok(file) = serde_json::from_str::<serde_json::Value>(&text) else { return HashMap::new() };
    let mut out = HashMap::new();
    let mut add = |list: Option<&serde_json::Value>| {
        for item in list.and_then(|l| l.as_array()).into_iter().flatten() {
            let Some(name) = item.get("name").and_then(|n| n.as_str()) else { continue };
            if !valid_name(name) {
                continue;
            }
            let value = match item.get("value") {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Number(n)) => n.to_string(),
                _ => String::new(),
            };
            let raw = item.get("raw").and_then(|r| r.as_bool()).unwrap_or(false);
            out.entry(name.to_string()).or_insert(Var { value, raw });
        }
    };
    add(file.get("connections").and_then(|c| c.get(conn_id)));
    add(file.get("global"));
    out
}

/// What a value becomes in the SQL (paramLiteral in src/snippets.ts).
pub fn literal(var: &Var, kind: DbKind) -> String {
    if var.raw {
        return var.value.clone();
    }
    let v = var.value.trim();
    if is_number(v) || ["null", "true", "false"].contains(&v.to_ascii_lowercase().as_str()) {
        return v.to_string();
    }
    let escaped = if kind == DbKind::Mysql { var.value.replace('\\', "\\\\").replace('\'', "''") } else { var.value.replace('\'', "''") };
    format!("'{escaped}'")
}

/// -?(0|[1-9]\d*)(\.\d+)?: digits with leading zeros (a postcode, "007") are text.
fn is_number(v: &str) -> bool {
    let v = v.strip_prefix('-').unwrap_or(v);
    let (int, frac) = match v.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (v, None),
    };
    let int_ok = int == "0" || (!int.is_empty() && !int.starts_with('0') && int.chars().all(|c| c.is_ascii_digit()));
    int_ok && frac.is_none_or(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()))
}

/// The SQL with every `${name}` that `vars` defines replaced, outside strings, quoted identifiers and comments.
pub fn substitute(sql: &str, kind: DbKind, vars: &HashMap<String, Var>) -> String {
    if vars.is_empty() || !sql.contains("${") {
        return sql.to_string();
    }
    let c: Vec<char> = sql.chars().collect();
    let n = c.len();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    // `${name}` at i: the name and the index after the "}".
    let var_at = |i: usize| -> Option<(String, usize)> {
        if c.get(i) != Some(&'$') || c.get(i + 1) != Some(&'{') {
            return None;
        }
        let mut j = i + 2;
        while j < n && (c[j].is_ascii_alphanumeric() || c[j] == '_') {
            j += 1;
        }
        let name: String = c[i + 2..j].iter().collect();
        (c.get(j) == Some(&'}') && valid_name(&name)).then_some((name, j + 1))
    };
    let copy = |out: &mut String, from: usize, to: usize| out.extend(&c[from..to.min(n)]);
    while i < n {
        let ch = c[i];
        let next = c.get(i + 1).copied();
        let start = i;
        if ch == '-' && next == Some('-') {
            while i < n && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '#' && kind == DbKind::Mysql {
            while i < n && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '{' && kind == DbKind::Informix && !(i > 0 && c[i - 1] == '$' && var_at(i - 1).is_some()) {
            // Informix comments between braces.
            while i < n && c[i] != '}' {
                i += 1;
            }
            i = (i + 1).min(n);
        } else if ch == '/' && next == Some('*') {
            i += 2;
            while i < n && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i = (i + 2).min(n);
        } else if ch == '$' && kind != DbKind::Mysql && kind != DbKind::Mssql && dollar_tag(&c, i).is_some() {
            let end = dollar_tag(&c, i).unwrap_or(i);
            let tag = &c[i..=end];
            let mut j = end + 1;
            while j + tag.len() <= n && &c[j..j + tag.len()] != tag {
                j += 1;
            }
            i = if j + tag.len() <= n { j + tag.len() } else { n };
        } else if let Some(close) = match ch {
            '\'' | '"' | '`' => Some(ch),
            '[' if kind == DbKind::Mssql => Some(']'),
            _ => None,
        } {
            i += 1;
            while i < n {
                if kind == DbKind::Mysql && c[i] == '\\' && close != '`' {
                    i += 2;
                    continue;
                }
                if c[i] == close {
                    if c.get(i + 1) == Some(&close) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i = (i + 1).min(n);
        } else if let Some((name, after)) = var_at(i) {
            match vars.get(&name) {
                Some(var) => out.push_str(&literal(var, kind)),
                None => copy(&mut out, i, after),
            }
            i = after;
            continue;
        } else {
            i += 1;
        }
        copy(&mut out, start, i);
    }
    out
}

/// `$tag$` (PostgreSQL dollar quoting) starting at i, not right after a word: the index of its closing `$`.
fn dollar_tag(c: &[char], i: usize) -> Option<usize> {
    if i > 0 && (c[i - 1].is_alphanumeric() || c[i - 1] == '_' || c[i - 1] == '$') {
        return None;
    }
    let mut j = i + 1;
    while j < c.len() && j < i + 64 && (c[j].is_ascii_alphabetic() || c[j] == '_') {
        j += 1;
    }
    (c.get(j) == Some(&'$')).then_some(j)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str, bool)]) -> HashMap<String, Var> {
        list.iter().map(|(n, v, r)| (n.to_string(), Var { value: v.to_string(), raw: *r })).collect()
    }

    #[test]
    fn substitutes_in_code_only() {
        let v = vars(&[("id", "5", false), ("pais", "O'Neil", false), ("tabla", "ventas.pedidos", true)]);
        let pg = DbKind::Postgres;
        assert_eq!(
            substitute("SELECT * FROM ${tabla} WHERE id = ${id} AND p = ${pais} AND n <> '${id}' -- ${id}\n/* ${id} */ AND x = ${falta}", pg, &v),
            "SELECT * FROM ventas.pedidos WHERE id = 5 AND p = 'O''Neil' AND n <> '${id}' -- ${id}\n/* ${id} */ AND x = ${falta}"
        );
        assert_eq!(substitute("SELECT $$ ${id} $$, ${id}, $1, :id, ?, @id", pg, &v), "SELECT $$ ${id} $$, 5, $1, :id, ?, @id");
        assert_eq!(substitute("SELECT `${id}`, ${id} # ${id}", DbKind::Mysql, &v), "SELECT `${id}`, 5 # ${id}");
        assert_eq!(substitute("SELECT [${id}], ${id}", DbKind::Mssql, &v), "SELECT [${id}], 5");
        assert_eq!(substitute("SELECT ${id} FROM t { ${id} }", DbKind::Informix, &v), "SELECT 5 FROM t { ${id} }");
        assert_eq!(substitute("SELECT 'a\\'${id}', ${id}", DbKind::Mysql, &v), "SELECT 'a\\'${id}', 5", "MySQL backslash escapes");
        assert_eq!(substitute("SELECT 'ñ', ${pais}", DbKind::Sqlite, &v), "SELECT 'ñ', 'O''Neil'");
        assert_eq!(substitute("SELECT ${id}", DbKind::Odbc, &HashMap::new()), "SELECT ${id}");
        assert_eq!(substitute("SELECT ${ id }, ${1x}, ${", pg, &v), "SELECT ${ id }, ${1x}, ${");
    }

    #[test]
    fn literals_like_the_interface() {
        let lit = |v: &str, raw: bool, kind: DbKind| literal(&Var { value: v.into(), raw }, kind);
        assert_eq!(lit("42", false, DbKind::Postgres), "42");
        assert_eq!(lit("-1.5", false, DbKind::Postgres), "-1.5");
        assert_eq!(lit("007", false, DbKind::Postgres), "'007'");
        assert_eq!(lit("1.", false, DbKind::Postgres), "'1.'");
        assert_eq!(lit("NULL", false, DbKind::Mssql), "NULL");
        assert_eq!(lit("a\\b", false, DbKind::Mysql), "'a\\\\b'");
        assert_eq!(lit("a\\b", false, DbKind::Postgres), "'a\\b'");
        assert_eq!(lit("(1, 2)", true, DbKind::Postgres), "(1, 2)");
    }

    #[test]
    fn reads_the_scopes_from_the_file() {
        let dir = std::env::temp_dir().join(format!("celer-vars-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::new(dir.clone());
        assert!(for_connection(&store, "c1").is_empty(), "no file: none");
        std::fs::write(
            dir.join(FILE),
            r#"{"version":1,"global":[{"name":"a","value":"g"},{"name":"b","value":7},{"name":"mal nombre","value":"x"}],"connections":{"c1":[{"name":"a","value":"c","raw":true}]}}"#,
        )
        .unwrap();
        let c1 = for_connection(&store, "c1");
        assert_eq!(c1.get("a"), Some(&Var { value: "c".into(), raw: true }), "the connection's wins");
        assert_eq!(c1.get("b"), Some(&Var { value: "7".into(), raw: false }));
        assert!(!c1.contains_key("mal nombre"));
        assert_eq!(for_connection(&store, "c2").get("a").unwrap().value, "g");
        std::fs::write(dir.join(FILE), "{ roto").unwrap();
        assert!(for_connection(&store, "c1").is_empty(), "a damaged file: none");
        std::fs::remove_dir_all(&dir).ok();
    }
}
