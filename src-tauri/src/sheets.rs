//! Hojas de cálculo para importar: Excel (.xlsx, .xlsm, .xls), OpenDocument (.ods). Devuelve las hojas del libro
//! y las filas de una de ellas como texto, listo para el mismo asistente que importa CSV.

use anyhow::{anyhow, Result};
use calamine::{open_workbook_auto, Data, Reader};
use serde::Serialize;

#[derive(Serialize)]
pub struct Sheet {
    /// Every sheet of the workbook (to choose another one).
    pub sheets: Vec<String>,
    /// The sheet read.
    pub sheet: String,
    pub rows: Vec<Vec<String>>,
}

/// Lee `sheet` (o la primera hoja) de un libro. Fechas en ISO (AAAA-MM-DD [hh:mm:ss]), números enteros sin
/// decimales, booleanos como true/false; celdas vacías y errores como texto vacío.
pub fn read(path: &str, sheet: Option<&str>) -> Result<Sheet> {
    let mut book = open_workbook_auto(path).map_err(|e| anyhow!("No se pudo abrir el libro: {e}"))?;
    let sheets = book.sheet_names().to_vec();
    let name = match sheet {
        Some(s) if sheets.iter().any(|n| n == s) => s.to_string(),
        _ => sheets.first().cloned().ok_or_else(|| anyhow!("El libro no tiene hojas"))?,
    };
    let range = book.worksheet_range(&name).map_err(|e| anyhow!("No se pudo leer la hoja «{name}»: {e}"))?;
    let mut rows: Vec<Vec<String>> = range.rows().map(|row| row.iter().map(cell_text).collect()).collect();
    // Trailing empty rows (formatted but blank) are not data.
    while rows.last().is_some_and(|r| r.iter().all(String::is_empty)) {
        rows.pop();
    }
    Ok(Sheet { sheets, sheet: name, rows })
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty | Data::Error(_) => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", *f as i64),
        Data::Float(f) => f.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => match d.as_datetime() {
            Some(dt) if dt.time() == chrono::NaiveTime::MIN => dt.date().format("%Y-%m-%d").to_string(),
            Some(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
            None => d.as_f64().to_string(),
        },
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::read;

    #[test]
    fn reads_a_workbook_written_by_excel_writer() {
        let path = std::env::temp_dir().join(format!("celer-sheet-{}.xlsx", std::process::id()));
        let mut book = rust_xlsxwriter::Workbook::new();
        let date = rust_xlsxwriter::Format::new().set_num_format("yyyy-mm-dd");
        let ws = book.add_worksheet().set_name("Clientes").unwrap();
        ws.write_string(0, 0, "id").unwrap();
        ws.write_string(0, 1, "nombre").unwrap();
        ws.write_string(0, 2, "alta").unwrap();
        ws.write_string(0, 3, "activo").unwrap();
        ws.write_string(0, 4, "saldo").unwrap();
        ws.write_number(1, 0, 1.0).unwrap();
        ws.write_string(1, 1, "Ana Ruiz").unwrap();
        ws.write_datetime_with_format(1, 2, &rust_xlsxwriter::ExcelDateTime::from_ymd(2024, 3, 15).unwrap(), &date).unwrap();
        ws.write_boolean(1, 3, true).unwrap();
        ws.write_number(1, 4, 12.5).unwrap();
        book.add_worksheet().set_name("Otra").unwrap();
        book.save(&path).unwrap();
        let sheet = read(path.to_str().unwrap(), None).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(sheet.sheets, vec!["Clientes", "Otra"]);
        assert_eq!(sheet.sheet, "Clientes");
        assert_eq!(sheet.rows[0], vec!["id", "nombre", "alta", "activo", "saldo"]);
        assert_eq!(sheet.rows[1], vec!["1", "Ana Ruiz", "2024-03-15", "true", "12.5"]);
    }

    #[test]
    fn reads_the_import_fixture_by_sheet_name() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev/fixtures/import/clientes.xlsx");
        let first = read(path, None).unwrap();
        assert_eq!(first.sheets, vec!["Notas", "Clientes"]);
        assert_eq!(first.rows.len(), 1);
        let sheet = read(path, Some("Clientes")).unwrap();
        assert_eq!(sheet.rows.len(), 4);
        assert_eq!(sheet.rows[1], vec!["1", "Ana Ruiz", "2024-03-15", "true", "12.5"]);
        assert_eq!(sheet.rows[2], vec!["2", "Luis Peña", "2023-03-15", "false", ""]);
        assert_eq!(sheet.rows[3], vec!["3", "Marta Gil", "", "true", "-3"]);
        // An unknown sheet name falls back to the first one.
        assert_eq!(read(path, Some("Nope")).unwrap().sheet, "Notas");
    }
}