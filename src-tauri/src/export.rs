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
    mssql: bool,
    progress: &dyn Fn(u64),
) -> Result<u64> {
    let out = d.execute(sql, PAGE)?;
    let Some(first) = out.results.into_iter().find(|r| !r.columns.is_empty()) else {
        bail!("La consulta no devuelve filas para exportar");
    };
    let cols = first.columns;
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
            write_row(&mut sink, &cols, r, o, &sql_cols, &xml_tags, mssql)?;
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

fn sql_literal(c: &Cell, kind: ColKind, mssql: bool) -> String {
    match c {
        Cell::Null => "NULL".into(),
        Cell::Bool(b) if mssql => (if *b { "1" } else { "0" }).into(),
        Cell::Bool(b) => (if *b { "TRUE" } else { "FALSE" }).into(),
        Cell::Int(i) => i.to_string(),
        Cell::Num(f) => f.to_string(),
        Cell::Text(s) if kind == ColKind::Number && s.parse::<f64>().is_ok() => s.clone(),
        Cell::Text(s) if kind == ColKind::Binary && s.starts_with("0x") && mssql => s.clone(),
        Cell::Text(s) => format!(
            "{}'{}'",
            if mssql { "N" } else { "" },
            s.replace('\'', "''")
        ),
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
    mssql: bool,
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
                    .map(|(c, col)| sql_literal(c, col.kind, mssql))
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
        assert_eq!(sql_literal(&Cell::Bool(true), ColKind::Bool, false), "TRUE");
        assert_eq!(sql_literal(&Cell::Bool(false), ColKind::Bool, true), "0");
        assert_eq!(sql_literal(&Cell::Text("O'Hara".into()), ColKind::Text, false), "'O''Hara'");
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
}