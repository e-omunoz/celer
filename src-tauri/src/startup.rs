//! Script de inicio de una conexión: sentencias que cada driver ejecuta en toda conexión nueva que abre (la
//! primera y las que abre por su cuenta al cambiar de base o recuperar una conexión perdida), antes que
//! cualquier sentencia del usuario y antes de activar el modo manual de transacciones.

use anyhow::{bail, Result};

use crate::model::{ConnConfig, DbKind};

/// Las sentencias del script de `cfg`, separadas por `;` fuera de cadenas, identificadores entre comillas y
/// comentarios del dialecto. Los comentarios se conservan (MySQL ejecuta `/*!… */`).
pub fn statements(cfg: &ConnConfig) -> Vec<String> {
    split(&cfg.startup_sql, cfg.kind)
}

/// En una conexión de solo lectura, un script que modifica datos no se acepta.
pub fn check(cfg: &ConnConfig) -> Result<()> {
    if !cfg.read_only {
        return Ok(());
    }
    if let Some(write) = statements(cfg).iter().find(|s| crate::session::is_mutating(s) || crate::mcp::batch_writes(s, cfg.kind)) {
        bail!("El script de inicio modifica datos («{}») y la conexión es de solo lectura", short(write));
    }
    Ok(())
}

/// Mensaje de error de una sentencia del script.
pub fn failed(sql: &str, e: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("El script de inicio de la conexión falló en «{}»: {e}", short(sql))
}

fn short(sql: &str) -> String {
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 60 {
        format!("{}…", one_line.chars().take(60).collect::<String>())
    } else {
        one_line
    }
}

/// Separa `sql` en sentencias para `kind`. `#` comenta en MySQL, `{ }` en Informix, `$tag$` es una cadena en
/// PostgreSQL, y la barra invertida escapa dentro de las cadenas de MySQL.
pub fn split(sql: &str, kind: DbKind) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    let push_until = |current: &mut String, i: &mut usize, end: usize| {
        current.extend(&chars[*i..end.min(chars.len())]);
        *i = end.min(chars.len());
    };
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '-' && next == Some('-') || c == '#' && kind == DbKind::Mysql {
            let end = chars[i..].iter().position(|&ch| ch == '\n').map_or(chars.len(), |p| i + p);
            push_until(&mut current, &mut i, end);
            continue;
        }
        if c == '/' && next == Some('*') {
            let end = (i + 2..chars.len().saturating_sub(1)).find(|&k| chars[k] == '*' && chars[k + 1] == '/').map_or(chars.len(), |k| k + 2);
            push_until(&mut current, &mut i, end);
            continue;
        }
        if c == '{' && kind == DbKind::Informix {
            let end = chars[i..].iter().position(|&ch| ch == '}').map_or(chars.len(), |p| i + p + 1);
            push_until(&mut current, &mut i, end);
            continue;
        }
        if c == '$' && kind == DbKind::Postgres && !chars.get(i.wrapping_sub(1)).is_some_and(|p| i > 0 && (p.is_alphanumeric() || *p == '_' || *p == '$')) {
            if let Some(tag_len) = chars[i + 1..].iter().position(|&ch| ch == '$') {
                let tag: String = chars[i..=i + 1 + tag_len].iter().collect();
                if tag[1..tag.len() - 1].chars().all(|ch| ch.is_alphanumeric() || ch == '_') {
                    let body_start = i + tag.chars().count();
                    let rest: String = chars[body_start..].iter().collect();
                    let end = rest.find(&tag).map_or(chars.len(), |p| body_start + rest[..p].chars().count() + tag.chars().count());
                    push_until(&mut current, &mut i, end);
                    continue;
                }
            }
        }
        if c == '\'' || c == '"' || c == '`' || (c == '[' && kind == DbKind::Mssql) {
            let close = if c == '[' { ']' } else { c };
            let mut k = i + 1;
            while k < chars.len() {
                if chars[k] == '\\' && kind == DbKind::Mysql && close != '`' {
                    k += 2;
                    continue;
                }
                if chars[k] == close {
                    if chars.get(k + 1) == Some(&close) && close != ']' {
                        k += 2;
                        continue;
                    }
                    break;
                }
                k += 1;
            }
            push_until(&mut current, &mut i, k + 1);
            continue;
        }
        if c == ';' {
            if has_code(&current) {
                out.push(current.trim().to_string());
            }
            current.clear();
        } else {
            current.push(c);
        }
        i += 1;
    }
    if has_code(&current) {
        out.push(current.trim().to_string());
    }
    out
}

/// Something besides blanks and line comments (a statement made only of comments is not sent).
fn has_code(s: &str) -> bool {
    s.lines().map(|l| l.trim()).any(|l| !l.is_empty() && !l.starts_with("--") && !l.starts_with('#'))
}

#[cfg(test)]
mod tests {
    use super::split;
    use crate::model::DbKind;

    #[test]
    fn splits_per_dialect() {
        assert_eq!(split("SET a = 1; SET b = 'x;y';", DbKind::Postgres), vec!["SET a = 1", "SET b = 'x;y'"]);
        assert_eq!(split("DO $$ BEGIN PERFORM 1; END $$; SET c = 3", DbKind::Postgres), vec!["DO $$ BEGIN PERFORM 1; END $$", "SET c = 3"]);
        // MySQL: executable comments are kept, # comments and backslash escapes are understood.
        assert_eq!(split("/*!40101 SET NAMES utf8mb4 */;\n# comment; here\nSET @x = 'it\\'s; ok'", DbKind::Mysql), vec!["/*!40101 SET NAMES utf8mb4 */", "# comment; here\nSET @x = 'it\\'s; ok'"]);
        // Informix braces are comments; ODBC escapes elsewhere stay as they are.
        assert_eq!(split("{ c; } SET LOCK MODE TO WAIT 10", DbKind::Informix), vec!["{ c; } SET LOCK MODE TO WAIT 10"]);
        assert_eq!(split("SELECT {fn NOW()}; SET x = 1", DbKind::Odbc), vec!["SELECT {fn NOW()}", "SET x = 1"]);
        // A $ inside an identifier is not a dollar quote.
        assert_eq!(split("SELECT a$b$c FROM t; SET y = 2", DbKind::Postgres), vec!["SELECT a$b$c FROM t", "SET y = 2"]);
        assert_eq!(split("SELECT [a;b] FROM t", DbKind::Mssql), vec!["SELECT [a;b] FROM t"]);
        assert!(split("  ;  ; -- nada", DbKind::Postgres).is_empty());
    }
}
