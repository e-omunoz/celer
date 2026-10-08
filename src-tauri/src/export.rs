//! Exportación de resultados a CSV, TSV, JSON, SQL (INSERT), Markdown, HTML, XML y Excel, en streaming.

use std::fs::File;
use std::io::{BufWriter, Write};

use anyhow::{bail, Result};
use serde::Deserialize;

use crate::model::*;
use crate::session::Driver;

const PAGE: usize = 5000;
const XLSX_MAX_ROWS: u32 = 1_048_575;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// csv | tsv | json | sql | markdown | html | xml | xlsx
    pub format: String,
    pub path: String,
    pub delimiter: String,
    pub header: bool,
    pub bom: bool,
    pub table_name: String,
    pub null_text: String,
    /// SQL: rows per INSERT statement (1 = one statement per row).
    pub sql_batch: usize,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions {
            format: "csv".into(),
            path: String::new(),
            delimiter: ";".into(),
            header: true,
            bom: true,
            table_name: "tabla".into(),
            null_text: String::new(),
            sql_batch: 1,
        }
    }
}

enum Sink {
    Text {
        w: BufWriter<File>,
        first: bool,
        /// Rows written in the current multi-row INSERT.
        batch: usize,
    },
    Xlsx {
        wb: rust_xlsxwriter::Workbook,
        row: u32,
    },
}

/// Ejecuta `sql` y escribe todas las filas del primer resultado en el fichero.
pub fn export(
    d: &mut dyn Driver,
    sql: &str,
    o: &ExportOptions,
    engine: DbKind,
    progress: &dyn Fn(u64),
) -> Result<u64> {
    // Whole binary values, not the grid's 4 KB preview.
    crate::model::set_full_binary(true);
    let written = export_rows(d, sql, o, engine, progress);
    crate::model::set_full_binary(false);
    written
}

fn export_rows(
    d: &mut dyn Driver,
    sql: &str,
    o: &ExportOptions,
    engine: DbKind,
    progress: &dyn Fn(u64),
) -> Result<u64> {
    let out = d.execute(sql, PAGE)?;
    let Some(first) = out.results.into_iter().find(|r| !r.columns.is_empty()) else {
        bail!("La consulta no devuelve filas para exportar");
    };
    let mut cols = first.columns;
    // JSON: one key per column, so columns that share a name (a join's two `id`) become id, id_2…
    if o.format == "json" {
        let keys = unique_names(cols.iter().map(|c| c.name.as_str()));
        for (c, key) in cols.iter_mut().zip(keys) {
            c.name = key;
        }
    }
    let mut has_more = first.has_more;
    let mut sink = match o.format.as_str() {
        "xlsx" => Sink::Xlsx {
            wb: rust_xlsxwriter::Workbook::new(),
            row: 0,
        },
        _ => {
            let mut w = BufWriter::with_capacity(1 << 20, File::create(&o.path)?);
            if o.bom && matches!(o.format.as_str(), "csv" | "tsv") {
                w.write_all("\u{feff}".as_bytes())?;
            }
            Sink::Text { w, first: true, batch: 0 }
        }
    };
    let sql_cols = cols
        .iter()
        .map(|c| d.quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    // XML: one element per column, named after it when the name is a valid XML name.
    let xml_tags = cols.iter().map(|c| xml_name(&c.name)).collect::<Vec<_>>();
    write_header(&mut sink, &cols, o)?;
    let mut total = 0u64;
    let mut rows = first.rows;
    loop {
        for r in &rows {
            write_row(&mut sink, &cols, r, o, &sql_cols, &xml_tags, engine)?;
        }
        total += rows.len() as u64;
        progress(total);
        if !has_more {
            break;
        }
        let f = d.fetch(PAGE)?;
        rows = f.rows;
        has_more = f.has_more;
    }
    let _ = d.close_cursor();
    match sink {
        Sink::Text { mut w, batch, .. } => {
            match o.format.as_str() {
                "json" => w.write_all(b"\n]\n")?,
                "html" => w.write_all(b"</tbody>\n</table>\n</body>\n</html>\n")?,
                "xml" => writeln!(w, "</{}>", xml_root(&o.table_name))?,
                "sql" if batch > 0 => w.write_all(b";\n")?,
                _ => {}
            }
            w.flush()?;
        }
        Sink::Xlsx { mut wb, row } => {
            if row > XLSX_MAX_ROWS {
                bail!("Excel admite como máximo {XLSX_MAX_ROWS} filas");
            }
            if let Ok(ws) = wb.worksheet_from_index(0) {
                ws.autofit();
            }
            wb.save(&o.path)?;
        }
    }
    Ok(total)
}

fn csv_field(s: &str, delim: &str) -> String {
    if s.contains(delim) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn text_of(c: &Cell, null_text: &str) -> String {
    match c {
        Cell::Null => null_text.to_string(),
        Cell::Bool(b) => (if *b { "true" } else { "false" }).into(),
        Cell::Int(i) => i.to_string(),
        Cell::Num(f) => f.to_string(),
        Cell::Text(s) => s.clone(),
    }
}

/// The names made unique: a repeated name gets `_2`, `_3`… (skipping names already taken).
fn unique_names<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let names: Vec<&str> = names.collect();
    let mut taken: std::collections::HashSet<String> = names.iter().map(|n| n.to_string()).collect();
    let mut seen = std::collections::HashSet::new();
    names
        .iter()
        .map(|&name| {
            if seen.insert(name) {
                return name.to_string();
            }
            let mut n = 2;
            while taken.contains(&format!("{name}_{n}")) {
                n += 1;
            }
            let key = format!("{name}_{n}");
            taken.insert(key.clone());
            key
        })
        .collect()
}

fn json_value(c: &Cell) -> serde_json::Value {
    match c {
        Cell::Null => serde_json::Value::Null,
        Cell::Bool(b) => (*b).into(),
        Cell::Int(i) => (*i).into(),
        Cell::Num(f) => serde_json::Number::from_f64(*f)
            .map(Into::into)
            .unwrap_or(serde_json::Value::Null),
        Cell::Text(s) => s.clone().into(),
    }
}

/// A value as a literal the same engine reads back as it was.
fn sql_literal(c: &Cell, kind: ColKind, engine: DbKind) -> String {
    let mssql = engine == DbKind::Mssql;
    match c {
        Cell::Null => "NULL".into(),
        Cell::Bool(b) if mssql => (if *b { "1" } else { "0" }).into(),
        Cell::Bool(b) => (if *b { "TRUE" } else { "FALSE" }).into(),
        Cell::Int(i) => i.to_string(),
        Cell::Num(f) if f.is_finite() => f.to_string(),
        // NaN and the infinities (PostgreSQL) only as quoted text: bare they are column names.
        Cell::Text(s) if kind == ColKind::Number && s.parse::<f64>().is_ok_and(f64::is_finite) => s.clone(),
        Cell::Text(s) if kind == ColKind::Binary => match binary_literal(s, engine) {
            Some(lit) => lit,
            None => text_literal(s, engine),
        },
        Cell::Num(f) => text_literal(&f.to_string(), engine),
        Cell::Text(s) => text_literal(s, engine),
    }
}

fn text_literal(s: &str, engine: DbKind) -> String {
    match engine {
        DbKind::Mssql => format!("N'{}'", s.replace('\'', "''")),
        // MySQL reads \ as an escape in a string (unless NO_BACKSLASH_ESCAPES), as mysqldump writes it.
        DbKind::Mysql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        _ => format!("'{}'", s.replace('\'', "''")),
    }
}

/// A binary value as the grid shows it (0x…) as the engine's binary literal; None for a cut preview or an engine
/// without one.
fn binary_literal(s: &str, engine: DbKind) -> Option<String> {
    let hex = s.strip_prefix("0x")?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match engine {
        DbKind::Mssql => Some(s.to_string()),
        DbKind::Mysql | DbKind::Sqlite => Some(format!("X'{hex}'")),
        DbKind::Postgres => Some(format!("decode('{hex}', 'hex')")),
        _ => None,
    }
}

fn write_header(sink: &mut Sink, cols: &[ColumnInfo], o: &ExportOptions) -> Result<()> {
    match sink {
        Sink::Text { w, .. } => match o.format.as_str() {
            "csv" | "tsv" => {
                if o.header {
                    let delim = if o.format == "tsv" {
                        "\t"
                    } else {
                        o.delimiter.as_str()
                    };
                    let line = cols
                        .iter()
                        .map(|c| csv_field(&c.name, delim))
                        .collect::<Vec<_>>()
                        .join(delim);
                    w.write_all(line.as_bytes())?;
                    w.write_all(b"\r\n")?;
                }
            }
            "json" => w.write_all(b"[")?,
            "markdown" => {
                let head = cols.iter().map(|c| md_cell(&c.name)).collect::<Vec<_>>().join(" | ");
                let rule = cols
                    .iter()
                    .map(|c| if c.kind == ColKind::Number { "---:" } else { "---" })
                    .collect::<Vec<_>>()
                    .join(" | ");
                writeln!(w, "| {head} |\n| {rule} |")?;
            }
            "xml" => {
                writeln!(w, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<{}>", xml_root(&o.table_name))?;
            }
            "html" => {
                w.write_all(HTML_HEAD.as_bytes())?;
                w.write_all(b"<thead><tr>")?;
                for c in cols {
                    write!(w, "<th>{}</th>", html_escape(&c.name))?;
                }
                w.write_all(b"</tr></thead>\n<tbody>\n")?;
            }
            _ => {}
        },
        Sink::Xlsx { wb, row } => {
            let ws = wb.add_worksheet();
            let bold = rust_xlsxwriter::Format::new().set_bold();
            for (i, c) in cols.iter().enumerate() {
                ws.write_string_with_format(0, i as u16, &c.name, &bold)?;
            }
            ws.set_freeze_panes(1, 0)?;
            *row = 1;
        }
    }
    Ok(())
}

fn write_row(
    sink: &mut Sink,
    cols: &[ColumnInfo],
    r: &[Cell],
    o: &ExportOptions,
    sql_cols: &str,
    xml_tags: &[String],
    engine: DbKind,
) -> Result<()> {
    match sink {
        Sink::Text { w, first, batch } => match o.format.as_str() {
            "csv" | "tsv" => {
                let delim = if o.format == "tsv" {
                    "\t"
                } else {
                    o.delimiter.as_str()
                };
                let line = r
                    .iter()
                    .map(|c| csv_field(&text_of(c, &o.null_text), delim))
                    .collect::<Vec<_>>()
                    .join(delim);
                w.write_all(line.as_bytes())?;
                w.write_all(b"\r\n")?;
            }
            "json" => {
                let mut m = serde_json::Map::new();
                for (c, v) in cols.iter().zip(r) {
                    m.insert(c.name.clone(), json_value(v));
                }
                w.write_all(if *first { b"\n  " } else { b",\n  " })?;
                serde_json::to_writer(&mut *w, &m)?;
                *first = false;
            }
            "sql" => {
                let vals = r
                    .iter()
                    .zip(cols)
                    .map(|(c, col)| sql_literal(c, col.kind, engine))
                    .collect::<Vec<_>>()
                    .join(", ");
                let per = o.sql_batch.clamp(1, 1000);
                if per == 1 {
                    writeln!(w, "INSERT INTO {} ({}) VALUES ({});", o.table_name, sql_cols, vals)?;
                } else {
                    if *batch == 0 {
                        write!(w, "INSERT INTO {} ({}) VALUES\n  ({})", o.table_name, sql_cols, vals)?;
                    } else {
                        write!(w, ",\n  ({})", vals)?;
                    }
                    *batch += 1;
                    if *batch >= per {
                        w.write_all(b";\n")?;
                        *batch = 0;
                    }
                }
            }
            "markdown" => {
                let line = r.iter().map(|c| md_cell(&text_of(c, if o.null_text.is_empty() { "NULL" } else { &o.null_text }))).collect::<Vec<_>>().join(" | ");
                writeln!(w, "| {line} |")?;
            }
            "xml" => {
                w.write_all(b"  <row>")?;
                for (c, (tag, col)) in r.iter().zip(xml_tags.iter().zip(cols)) {
                    // A column whose name is not a valid XML name keeps it in an attribute.
                    let open = if *tag == col.name { tag.clone() } else { format!("{tag} name=\"{}\"", xml_escape(&col.name)) };
                    match c {
                        Cell::Null => write!(w, "<{open} null=\"true\"/>")?,
                        _ => write!(w, "<{open}>{}</{tag}>", xml_escape(&text_of(c, "")))?,
                    }
                }
                w.write_all(b"</row>\n")?;
            }
            "html" => {
                w.write_all(b"<tr>")?;
                for (c, col) in r.iter().zip(cols) {
                    match c {
                        Cell::Null => w.write_all(b"<td class=\"null\">NULL</td>")?,
                        _ if col.kind == ColKind::Number => write!(w, "<td class=\"num\">{}</td>", html_escape(&text_of(c, "")))?,
                        _ => write!(w, "<td>{}</td>", html_escape(&text_of(c, "")))?,
                    }
                }
                w.write_all(b"</tr>\n")?;
            }
            _ => {}
        },
        Sink::Xlsx { wb, row } => {
            if *row > XLSX_MAX_ROWS {
                return Ok(());
            }
            let ws = wb.worksheet_from_index(0)?;
            for (i, c) in r.iter().enumerate() {
                let col = i as u16;
                match c {
                    Cell::Null => {}
                    Cell::Bool(b) => {
                        ws.write_boolean(*row, col, *b)?;
                    }
                    Cell::Int(v) => {
                        ws.write_number(*row, col, *v as f64)?;
                    }
                    Cell::Num(v) => {
                        ws.write_number(*row, col, *v)?;
                    }
                    Cell::Text(s) => {
                        if cols[i].kind == ColKind::Number {
                            if let Ok(v) = s.parse::<f64>() {
                                ws.write_number(*row, col, v)?;
                                continue;
                            }
                        }
                        let s = if s.len() > 32_000 {
                            &s[..s.char_indices().nth(32_000).map(|x| x.0).unwrap_or(s.len())]
                        } else {
                            s.as_str()
                        };
                        ws.write_string(*row, col, s)?;
                    }
                }
            }
            *row += 1;
        }
    }
    Ok(())
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace(['\r', '\n'], " ")
}

/// Escapes text for XML and drops what XML 1.0 does not allow (control characters, U+FFFE, U+FFFF).
fn xml_escape(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}'))
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A column name as an XML element name: kept when valid, otherwise "column" (the real name goes in an
/// attribute).
fn xml_name(name: &str) -> String {
    // XML 1.0 name characters (without ":"): º, ª, ² are not allowed although Unicode calls them letters.
    fn start(c: char) -> bool {
        matches!(c, 'A'..='Z' | '_' | 'a'..='z' | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{2FF}'
            | '\u{370}'..='\u{37D}' | '\u{37F}'..='\u{1FFF}' | '\u{200C}'..='\u{200D}' | '\u{2070}'..='\u{218F}'
            | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}'
            | '\u{10000}'..='\u{EFFFF}')
    }
    fn rest(c: char) -> bool {
        start(c) || matches!(c, '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}'..='\u{2040}')
    }
    let mut chars = name.chars();
    let valid_start = chars.next().is_some_and(start);
    let valid_rest = name.chars().all(rest);
    if valid_start && valid_rest && !name.to_ascii_lowercase().starts_with("xml") {
        name.to_string()
    } else {
        "column".to_string()
    }
}

/// The root element: the table name when it is a valid XML name, else "rows".
fn xml_root(table: &str) -> String {
    let name = xml_name(table.rsplit('.').next().unwrap_or(table).trim_matches(['"', '`', '[', ']']));
    if name == "column" { "rows".into() } else { name }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const HTML_HEAD: &str = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<title>Celer export</title>\n<style>\nbody{font:13px/1.45 system-ui,sans-serif;margin:24px;color:#1f1e1c;background:#faf9f5}\ntable{border-collapse:collapse;font-size:12.5px}\nth,td{border:1px solid #e5e2d8;padding:5px 9px;text-align:left;vertical-align:top}\nth{background:#f1efe8;font-weight:600;position:sticky;top:0}\ntd.num{text-align:right;font-variant-numeric:tabular-nums}\ntd.null{color:#9f9b8f;font-style:italic}\ntr:nth-child(even) td{background:#f8f7f3}\n</style>\n</head>\n<body>\n<table>\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_and_escaping() {
        assert_eq!(sql_literal(&Cell::Bool(true), ColKind::Bool, DbKind::Postgres), "TRUE");
        assert_eq!(sql_literal(&Cell::Bool(false), ColKind::Bool, DbKind::Mssql), "0");
        assert_eq!(sql_literal(&Cell::Text("O'Hara".into()), ColKind::Text, DbKind::Postgres), "'O''Hara'");
        // Round trip in the same engine: MySQL backslashes, binary values, PostgreSQL NaN and infinities.
        let path = Cell::Text(r"C:\dir\new".into());
        assert_eq!(sql_literal(&path, ColKind::Text, DbKind::Mysql), r"'C:\\dir\\new'");
        assert_eq!(sql_literal(&path, ColKind::Text, DbKind::Postgres), r"'C:\dir\new'");
        let bin = Cell::Text("0x00FF10AB".into());
        assert_eq!(sql_literal(&bin, ColKind::Binary, DbKind::Mysql), "X'00FF10AB'");
        assert_eq!(sql_literal(&bin, ColKind::Binary, DbKind::Sqlite), "X'00FF10AB'");
        assert_eq!(sql_literal(&bin, ColKind::Binary, DbKind::Postgres), "decode('00FF10AB', 'hex')");
        assert_eq!(sql_literal(&bin, ColKind::Binary, DbKind::Mssql), "0x00FF10AB");
        assert_eq!(sql_literal(&Cell::Text("NaN".into()), ColKind::Number, DbKind::Postgres), "'NaN'");
        assert_eq!(sql_literal(&Cell::Text("-Infinity".into()), ColKind::Number, DbKind::Postgres), "'-Infinity'");
        assert_eq!(sql_literal(&Cell::Text("12.50".into()), ColKind::Number, DbKind::Postgres), "12.50");
        assert_eq!(md_cell("a|b\nc"), "a\\|b c");
        assert_eq!(html_escape("<b>&\"</b>"), "&lt;b&gt;&amp;&quot;&lt;/b&gt;");
    }

    #[test]
    fn xml_names_and_escaping() {
        assert_eq!(xml_name("customer_id"), "customer_id");
        assert_eq!(xml_name("Año"), "Año");
        assert_eq!(xml_name("first name"), "column");
        assert_eq!(xml_name("1st"), "column");
        assert_eq!(xml_name("xmlns"), "column");
        assert_eq!(xml_name("nº"), "column");
        assert_eq!(xml_name("m²"), "column");
        assert_eq!(xml_name("año"), "año");
        assert_eq!(xml_root("public.events"), "events");
        assert_eq!(xml_root("\"Mixed Case\""), "rows");
        assert_eq!(xml_escape("a<b & \"c\"\u{1}"), "a&lt;b &amp; &quot;c&quot;");
    }

    #[test]
    fn exports_whole_binary_values() {
        let mut cfg = ConnConfig::default();
        cfg.kind = DbKind::Sqlite;
        cfg.file_path = ":memory:".into();
        let mut d = crate::sqlite::SqliteDriver::connect(cfg).unwrap();
        d.execute("CREATE TABLE b (v BLOB); INSERT INTO b VALUES (zeroblob(5000))", 10).unwrap();
        let path = std::env::temp_dir().join(format!("celer-export-bin-{}.csv", std::process::id()));
        let o = ExportOptions { path: path.to_string_lossy().into_owned(), header: false, bom: false, ..ExportOptions::default() };
        export(&mut d, "SELECT v FROM b", &o, DbKind::Sqlite, &|_| {}).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(text.trim_end().len(), 2 + 10_000, "{}…", &text[..40]);
        // The grid still gets the preview afterwards.
        let out = d.execute("SELECT v FROM b", 10).unwrap();
        assert!(matches!(&out.results[0].rows[0][0], Cell::Text(s) if s.ends_with('…')));
    }

    #[test]
    fn json_keys_are_unique() {
        assert_eq!(unique_names(["id", "name", "id", "id"].into_iter()), ["id", "name", "id_2", "id_3"]);
        assert_eq!(unique_names(["id", "id", "id_2"].into_iter()), ["id", "id_3", "id_2"]);
        assert_eq!(unique_names(["a", "b"].into_iter()), ["a", "b"]);
    }
}