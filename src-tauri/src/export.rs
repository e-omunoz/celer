//! Exportación de resultados a CSV, JSON, SQL (INSERT) y Excel, en streaming.

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
    /// csv | json | sql | xlsx | tsv
    pub format: String,
    pub path: String,
    pub delimiter: String,
    pub header: bool,
    pub bom: bool,
    pub table_name: String,
    pub null_text: String,
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
        }
    }
}

enum Sink {
    Text {
        w: BufWriter<File>,
        first: bool,
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
            Sink::Text { w, first: true }
        }
    };
    let sql_cols = cols
        .iter()
        .map(|c| d.quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    write_header(&mut sink, &cols, o)?;
    let mut total = 0u64;
    let mut rows = first.rows;
    loop {
        for r in &rows {
            write_row(&mut sink, &cols, r, o, &sql_cols, mssql)?;
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
        Sink::Text { mut w, .. } => {
            if o.format == "json" {
                w.write_all(b"\n]\n")?;
            }
            w.flush()?;
        }
        Sink::Xlsx { mut wb, row } => {
            if row > XLSX_MAX_ROWS {
                bail!("Excel admite como máximo {XLSX_MAX_ROWS} filas");
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
        Cell::Bool(b) => (if *b { "1" } else { "0" }).into(),
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
    mssql: bool,
) -> Result<()> {
    match sink {
        Sink::Text { w, first } => match o.format.as_str() {
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
                writeln!(
                    w,
                    "INSERT INTO {} ({}) VALUES ({});",
                    o.table_name, sql_cols, vals
                )?;
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
