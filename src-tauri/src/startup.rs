//! Script de inicio de una conexión: sentencias que se ejecutan en cada sesión nueva nada más conectar
//! (SET search_path…, SET LOCK_TIMEOUT…) y otra vez cada vez que el driver abre una conexión nueva por su
//! cuenta (cambio de base de datos, conexión perdida).

use anyhow::{anyhow, bail, Result};

use crate::model::*;
use crate::session::{Canceller, Driver};

/// Sentencias del script, separadas por `;` fuera de cadenas, identificadores entre comillas, comentarios
/// (`--`, `/* */`, `{ }` de Informix) y cadenas con dólar de PostgreSQL.
pub fn split_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        // Comments: kept out of the statement text.
        if c == '-' && next == Some('-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        if c == '{' {
            while i < chars.len() && chars[i] != '}' {
                i += 1;
            }
            i = (i + 1).min(chars.len());
            continue;
        }
        if c == '$' {
            let tag_end = chars[i + 1..].iter().position(|&ch| ch == '$').map(|p| i + 1 + p);
            if let Some(end) = tag_end {
                let tag: String = chars[i..=end].iter().collect();
                if tag[1..tag.len() - 1].chars().all(|ch| ch.is_alphanumeric() || ch == '_') {
                    let rest: String = chars[end + 1..].iter().collect();
                    let close = rest.find(&tag).map(|p| rest[..p].chars().count());
                    let stop = match close {
                        Some(n) => end + 1 + n + tag.chars().count(),
                        None => chars.len(),
                    };
                    current.extend(&chars[i..stop]);
                    i = stop;
                    continue;
                }
            }
        }
        if c == '\'' || c == '"' || c == '`' || c == '[' {
            let close = if c == '[' { ']' } else { c };
            current.push(c);
            i += 1;
            while i < chars.len() {
                current.push(chars[i]);
                if chars[i] == close {
                    if chars.get(i + 1) == Some(&close) && close != ']' {
                        current.push(close);
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == ';' {
            if !current.trim().is_empty() {
                out.push(current.trim().to_string());
            }
            current.clear();
        } else {
            current.push(c);
        }
        i += 1;
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// Ejecuta cada sentencia hasta el final (leyendo todas sus filas), para que ninguna quede a medias.
fn run(driver: &mut dyn Driver, statements: &[String]) -> Result<()> {
    for sql in statements {
        let out = driver
            .execute(sql, 10_000)
            .map_err(|e| anyhow!("El script de inicio de la conexión falló en «{}»: {e}", short(sql)))?;
        let mut more = out.results.iter().any(|r| r.has_more);
        while more {
            more = driver.fetch(10_000)?.has_more;
        }
        let _ = driver.close_cursor();
    }
    Ok(())
}

fn short(sql: &str) -> String {
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 60 {
        format!("{}…", one_line.chars().take(60).collect::<String>())
    } else {
        one_line
    }
}

/// Envuelve un driver para ejecutar el script de inicio de `cfg` al conectar y tras cada reconexión.
/// Sin script devuelve el driver tal cual. En una conexión de solo lectura, un script que modifica datos se
/// rechaza (también desde el servidor MCP y al probar la conexión).
pub fn wrap(mut driver: Box<dyn Driver>, cfg: &ConnConfig) -> Result<Box<dyn Driver>> {
    let statements = split_statements(&cfg.startup_sql);
    if statements.is_empty() {
        return Ok(driver);
    }
    if cfg.read_only {
        if let Some(write) = statements.iter().find(|s| crate::session::is_mutating(s) || crate::mcp::batch_writes(s, cfg.kind)) {
            bail!("El script de inicio modifica datos («{}») y la conexión es de solo lectura", short(write));
        }
    }
    run(driver.as_mut(), &statements)?;
    let _ = driver.take_reconnected();
    Ok(Box::new(StartupDriver { inner: driver, statements }))
}

struct StartupDriver {
    inner: Box<dyn Driver>,
    statements: Vec<String>,
}

impl StartupDriver {
    /// Tras cada operación: si el driver abrió una conexión nueva, el script vuelve a ejecutarse en ella.
    fn after<T>(&mut self, result: Result<T>) -> Result<T> {
        if self.inner.take_reconnected() {
            run(self.inner.as_mut(), &self.statements)?;
            let _ = self.inner.take_reconnected();
        }
        result
    }
}

impl Driver for StartupDriver {
    fn execute(&mut self, sql: &str, fetch: usize) -> Result<ExecOutput> {
        let r = self.inner.execute(sql, fetch);
        self.after(r)
    }
    fn fetch(&mut self, n: usize) -> Result<FetchOutput> {
        let r = self.inner.fetch(n);
        self.after(r)
    }
    fn close_cursor(&mut self) -> Result<()> {
        self.inner.close_cursor()
    }
    fn set_autocommit(&mut self, on: bool) -> Result<bool> {
        let r = self.inner.set_autocommit(on);
        self.after(r)
    }
    fn commit(&mut self) -> Result<bool> {
        let r = self.inner.commit();
        self.after(r)
    }
    fn rollback(&mut self) -> Result<bool> {
        let r = self.inner.rollback();
        self.after(r)
    }
    fn children(&mut self, path: &[String]) -> Result<Vec<MetaNode>> {
        let r = self.inner.children(path);
        self.after(r)
    }
    fn table_columns(&mut self, obj: &ObjectRef) -> Result<Vec<TableColumn>> {
        let r = self.inner.table_columns(obj);
        self.after(r)
    }
    fn ddl(&mut self, obj: &ObjectRef) -> Result<String> {
        let r = self.inner.ddl(obj);
        self.after(r)
    }
    fn completion(&mut self, database: &str) -> Result<CompletionSchema> {
        let r = self.inner.completion(database);
        self.after(r)
    }
    fn databases(&mut self) -> Result<Vec<String>> {
        let r = self.inner.databases();
        self.after(r)
    }
    fn current_database(&mut self) -> Result<String> {
        let r = self.inner.current_database();
        self.after(r)
    }
    fn use_database(&mut self, db: &str) -> Result<()> {
        let r = self.inner.use_database(db);
        self.after(r)
    }
    fn qualified_name(&self, obj: &ObjectRef) -> String {
        self.inner.qualified_name(obj)
    }
    fn quote_ident(&self, s: &str) -> String {
        self.inner.quote_ident(s)
    }
    fn server_info(&mut self) -> Result<String> {
        let r = self.inner.server_info();
        self.after(r)
    }
    fn canceller(&self) -> Canceller {
        self.inner.canceller()
    }
    fn take_reconnected(&mut self) -> bool {
        // Handled here: the script already ran on the new connection.
        false
    }
}

#[cfg(test)]
mod tests {
    use super::split_statements;

    #[test]
    fn splits_outside_quotes_and_comments() {
        assert_eq!(split_statements("SET a = 1; SET b = 'x;y';"), vec!["SET a = 1", "SET b = 'x;y'"]);
        assert_eq!(split_statements("-- c;\nSET a = 1 /* ; */; { ; } SET b = 2"), vec!["SET a = 1", "SET b = 2"]);
        assert_eq!(split_statements("DO $$ BEGIN PERFORM 1; END $$; SET c = 3"), vec!["DO $$ BEGIN PERFORM 1; END $$", "SET c = 3"]);
        assert_eq!(split_statements("SELECT \"a;b\", [c;d] FROM t"), vec!["SELECT \"a;b\", [c;d] FROM t"]);
        assert!(split_statements("  ;  ; -- nada").is_empty());
    }
}
