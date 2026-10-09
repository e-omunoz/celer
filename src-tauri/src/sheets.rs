//! Hojas de cálculo para importar: Excel (.xlsx, .xlsm, .xlsb, .xls) y OpenDocument (.ods).
//!
//! La hoja se lee una vez aquí (un .xlsx celda a celda, con progreso y cancelable) y se queda en memoria con un
//! identificador: la interfaz recibe solo un vistazo de las primeras filas y después pide las filas por tramos al
//! importar, con su tipo (número, fecha, booleano, texto) en lugar de texto, para que fechas y decimales lleguen tal
//! cual a las columnas de la tabla.

use anyhow::{anyhow, bail, Result};
use calamine::{open_workbook, open_workbook_auto, Cell, Data, Range, Reader, Xlsx};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

/// Filas que se envían de vistazo al abrir una hoja (cabeceras, mapeo y ejemplos).
pub const PREVIEW_ROWS: usize = 200;
/// Hojas abiertas que se guardan a la vez (las más recientes): un libro y otra hoja suya, por ejemplo.
const KEEP_OPEN: usize = 3;
pub const CANCELLED: &str = "Lectura cancelada";

/// Una celda con su tipo: así viaja a la interfaz (`null`, `true`, `12.5`, `"texto"`, `{"d": "2024-03-15"}`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum SheetCell {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    /// Fecha o fecha y hora, en ISO (AAAA-MM-DD [hh:mm:ss]).
    Date { d: String },
    /// Hora del día o duración (hh:mm:ss).
    Time { t: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    /// Identificador para pedir más filas (`rows`) y para soltarla (`close`).
    pub handle: u64,
    /// Todas las hojas del libro (para elegir otra).
    pub sheets: Vec<String>,
    /// La hoja leída.
    pub sheet: String,
    /// Primera fila y columna con datos (0 = fila 1 / columna A) y última, ambas incluidas; vacía: `rows` 0.
    pub first_row: u32,
    pub first_col: u32,
    pub last_row: u32,
    pub last_col: u32,
    /// Filas con datos (desde `first_row` hasta la última no vacía).
    pub rows: u32,
    /// Las primeras filas (hasta PREVIEW_ROWS) desde `first_row`, columnas `first_col..=last_col`.
    pub preview: Vec<Vec<SheetCell>>,
}

struct OpenSheet {
    handle: u64,
    range: Range<Data>,
}

fn open_sheets() -> &'static Mutex<Vec<OpenSheet>> {
    static OPEN: OnceLock<Mutex<Vec<OpenSheet>>> = OnceLock::new();
    OPEN.get_or_init(|| Mutex::new(Vec::new()))
}

fn opening() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static OPENING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    OPENING.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Detiene la lectura `open_id` en curso (la interfaz pulsó «Cancelar»).
pub fn cancel(open_id: &str) {
    if let Some(stop) = opening().lock().get(open_id) {
        stop.store(true, Ordering::Relaxed);
    }
}

/// Suelta una hoja abierta (el asistente se cerró o eligió otra).
pub fn close(handle: u64) {
    open_sheets().lock().retain(|s| s.handle != handle);
}

/// Lee `sheet` (o la primera hoja) de un libro y la guarda abierta. `progress(filas leídas, filas totales)` se llama
/// mientras se lee un .xlsx; `open_id` permite cancelarla con `cancel`.
pub fn open(path: &str, sheet: Option<&str>, open_id: &str, progress: &dyn Fn(u32, u32)) -> Result<SheetInfo> {
    let stop = Arc::new(AtomicBool::new(false));
    opening().lock().insert(open_id.to_string(), stop.clone());
    let res = read_range(path, sheet, &stop, progress);
    opening().lock().remove(open_id);
    let (sheets, name, range) = res?;
    let handle = NEXT.fetch_add(1, Ordering::Relaxed);
    let info = describe(handle, sheets, name, &range);
    let mut open = open_sheets().lock();
    open.push(OpenSheet { handle, range });
    while open.len() > KEEP_OPEN {
        open.remove(0);
    }
    Ok(info)
}

fn is_xlsx(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".xlsx") || lower.ends_with(".xlsm")
}

fn read_range(path: &str, sheet: Option<&str>, stop: &AtomicBool, progress: &dyn Fn(u32, u32)) -> Result<(Vec<String>, String, Range<Data>)> {
    let pick = |sheets: &[String]| -> Result<String> {
        Ok(match sheet {
            Some(s) if sheets.iter().any(|n| n == s) => s.to_string(),
            _ => sheets.first().cloned().ok_or_else(|| anyhow!("El libro no tiene hojas"))?,
        })
    };
    if is_xlsx(path) {
        // Celda a celda: progreso por filas y se puede cancelar entre celdas.
        let mut book: Xlsx<_> = open_workbook(path).map_err(|e| anyhow!("No se pudo abrir el libro: {e}"))?;
        let sheets = book.sheet_names().to_vec();
        let name = pick(&sheets)?;
        let mut reader = book.worksheet_cells_reader(&name).map_err(|e| anyhow!("No se pudo leer la hoja «{name}»: {e}"))?;
        let dims = reader.dimensions();
        let total = dims.end.0.saturating_sub(dims.start.0) + 1;
        let mut cells: Vec<Cell<Data>> = Vec::new();
        let mut last_report = 0u32;
        let mut count = 0u64;
        while let Some(cell) = reader.next_cell().map_err(|e| anyhow!("No se pudo leer la hoja «{name}»: {e}"))? {
            count += 1;
            if count % 4096 == 0 && stop.load(Ordering::Relaxed) {
                bail!(CANCELLED);
            }
            let (row, col) = cell.get_position();
            let value: Data = cell.get_value().clone().into();
            if matches!(value, Data::Empty) {
                continue;
            }
            let done = row.saturating_sub(dims.start.0);
            if done >= last_report + 2000 {
                last_report = done;
                progress(done, total);
            }
            cells.push(Cell::new((row, col), value));
        }
        progress(total, total);
        return Ok((sheets, name, Range::from_sparse(cells)));
    }
    let mut book = open_workbook_auto(path).map_err(|e| anyhow!("No se pudo abrir el libro: {e}"))?;
    let sheets = book.sheet_names().to_vec();
    let name = pick(&sheets)?;
    let range = book.worksheet_range(&name).map_err(|e| anyhow!("No se pudo leer la hoja «{name}»: {e}"))?;
    if stop.load(Ordering::Relaxed) {
        bail!(CANCELLED);
    }
    Ok((sheets, name, range))
}

/// The used area of a range, without trailing empty rows (formatted but blank) and its first rows.
fn describe(handle: u64, sheets: Vec<String>, sheet: String, range: &Range<Data>) -> SheetInfo {
    let (Some(start), Some(end)) = (range.start(), range.end()) else {
        return SheetInfo { handle, sheets, sheet, first_row: 0, first_col: 0, last_row: 0, last_col: 0, rows: 0, preview: Vec::new() };
    };
    let mut last_row = end.0;
    while last_row > start.0 && (start.1..=end.1).all(|c| range.get_value((last_row, c)).is_none_or(|v| matches!(v, Data::Empty))) {
        last_row -= 1;
    }
    let empty = (start.1..=end.1).all(|c| range.get_value((last_row, c)).is_none_or(|v| matches!(v, Data::Empty)));
    let rows = if empty { 0 } else { last_row - start.0 + 1 };
    let preview = if rows == 0 { Vec::new() } else { cells(range, start.0, (start.0 + PREVIEW_ROWS as u32 - 1).min(last_row), start.1, end.1) };
    SheetInfo { handle, sheets, sheet, first_row: start.0, first_col: start.1, last_row, last_col: end.1, rows, preview }
}

/// Rows `row0..=row1`, columns `col0..=col1` (sheet positions, 0-based) of a range, typed.
fn cells(range: &Range<Data>, row0: u32, row1: u32, col0: u32, col1: u32) -> Vec<Vec<SheetCell>> {
    (row0..=row1)
        .map(|r| (col0..=col1).map(|c| range.get_value((r, c)).map(typed).unwrap_or(SheetCell::Null)).collect())
        .collect()
}

/// Rows of an open sheet: `row0..=row1` and columns `col0..=col1`, sheet positions (0 = row 1 / column A).
pub fn rows(handle: u64, row0: u32, row1: u32, col0: u32, col1: u32) -> Result<Vec<Vec<SheetCell>>> {
    let open = open_sheets().lock();
    let sheet = open.iter().find(|s| s.handle == handle).ok_or_else(|| anyhow!("La hoja ya no está abierta: vuelve a elegir el fichero"))?;
    if row1 < row0 || col1 < col0 {
        return Ok(Vec::new());
    }
    Ok(cells(&sheet.range, row0, row1, col0, col1))
}

/// Una celda con su tipo. Errores (#N/A…) y vacías son NULL; las fechas, en ISO; una hora del día o una duración
/// (un valor de menos de un día, o un formato [h]:mm) no es una fecha de 1899.
pub fn typed(cell: &Data) -> SheetCell {
    match cell {
        Data::Empty | Data::Error(_) => SheetCell::Null,
        Data::String(s) => SheetCell::Text(s.clone()),
        Data::Int(i) => SheetCell::Int(*i),
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => SheetCell::Int(*f as i64),
        Data::Float(f) => SheetCell::Float(*f),
        Data::Bool(b) => SheetCell::Bool(*b),
        Data::DateTime(d) if d.is_duration() || (0.0..1.0).contains(&d.as_f64()) => {
            let secs = (d.as_f64() * 86_400.0).round() as i64;
            SheetCell::Time { t: format!("{:02}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60) }
        }
        Data::DateTime(d) => match d.as_datetime() {
            Some(dt) if dt.time() == chrono::NaiveTime::MIN => SheetCell::Date { d: dt.date().format("%Y-%m-%d").to_string() },
            Some(dt) => SheetCell::Date { d: dt.format("%Y-%m-%d %H:%M:%S").to_string() },
            None => SheetCell::Float(d.as_f64()),
        },
        Data::DateTimeIso(s) => SheetCell::Date { d: s.replacen('T', " ", 1) },
        Data::DurationIso(s) => SheetCell::Time { t: s.clone() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &str, sheet: Option<&str>) -> SheetInfo {
        open(path, sheet, "test", &|_, _| {}).unwrap()
    }

    fn text(s: &str) -> SheetCell {
        SheetCell::Text(s.into())
    }

    #[test]
    fn reads_a_workbook_written_by_excel_writer_typed() {
        let path = std::env::temp_dir().join(format!("celer-sheet-{}.xlsx", std::process::id()));
        let mut book = rust_xlsxwriter::Workbook::new();
        let date = rust_xlsxwriter::Format::new().set_num_format("yyyy-mm-dd");
        let stamp = rust_xlsxwriter::Format::new().set_num_format("yyyy-mm-dd hh:mm");
        let ws = book.add_worksheet().set_name("Clientes").unwrap();
        // A title, a blank row, then the header in row 3 from column B.
        ws.write_string(0, 1, "Informe de clientes").unwrap();
        for (i, h) in ["id", "nombre", "alta", "activo", "saldo", "hora", "visto"].iter().enumerate() {
            ws.write_string(2, 1 + i as u16, *h).unwrap();
        }
        ws.write_number(3, 1, 1.0).unwrap();
        ws.write_string(3, 2, "Ana Ruiz").unwrap();
        ws.write_datetime_with_format(3, 3, &rust_xlsxwriter::ExcelDateTime::from_ymd(2024, 3, 15).unwrap(), &date).unwrap();
        ws.write_boolean(3, 4, true).unwrap();
        ws.write_number(3, 5, 12.5).unwrap();
        let time = rust_xlsxwriter::Format::new().set_num_format("hh:mm");
        ws.write_number_with_format(3, 6, 8.5 / 24.0, &time).unwrap();
        ws.write_datetime_with_format(3, 7, &rust_xlsxwriter::ExcelDateTime::from_ymd(2024, 3, 15).unwrap().and_hms(10, 20, 0).unwrap(), &stamp).unwrap();
        ws.write_number(4, 1, 2.0).unwrap();
        ws.write_string(4, 2, "Luis").unwrap();
        ws.write_number(4, 5, 0.1).unwrap();
        book.add_worksheet().set_name("Otra").unwrap();
        book.save(&path).unwrap();
        let sheet = read(path.to_str().unwrap(), None);
        assert_eq!(sheet.sheets, vec!["Clientes", "Otra"]);
        assert_eq!(sheet.sheet, "Clientes");
        assert_eq!((sheet.first_row, sheet.first_col, sheet.last_row, sheet.last_col, sheet.rows), (0, 1, 4, 7, 5));
        assert_eq!(sheet.preview[0][0], text("Informe de clientes"));
        assert_eq!(sheet.preview[1], vec![SheetCell::Null; 7]);
        assert_eq!(sheet.preview[2][0], text("id"));
        assert_eq!(
            sheet.preview[3],
            vec![
                SheetCell::Int(1),
                text("Ana Ruiz"),
                SheetCell::Date { d: "2024-03-15".into() },
                SheetCell::Bool(true),
                SheetCell::Float(12.5),
                SheetCell::Time { t: "08:30:00".into() },
                SheetCell::Date { d: "2024-03-15 10:20:00".into() },
            ]
        );
        // More rows by range: only columns C..D of row 5.
        assert_eq!(rows(sheet.handle, 4, 4, 2, 3).unwrap(), vec![vec![text("Luis"), SheetCell::Null]]);
        assert_eq!(rows(sheet.handle, 4, 4, 5, 5).unwrap(), vec![vec![SheetCell::Float(0.1)]]);
        // Serialized for the interface.
        assert_eq!(serde_json::to_string(&sheet.preview[3]).unwrap(), r#"[1,"Ana Ruiz",{"d":"2024-03-15"},true,12.5,{"t":"08:30:00"},{"d":"2024-03-15 10:20:00"}]"#);
        close(sheet.handle);
        assert!(rows(sheet.handle, 0, 0, 0, 0).is_err(), "closed");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_the_import_fixture_by_sheet_name() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev/fixtures/import/clientes.xlsx");
        let first = read(path, None);
        assert_eq!(first.sheets, vec!["Notas", "Clientes"]);
        assert_eq!(first.rows, 1);
        let sheet = read(path, Some("Clientes"));
        assert_eq!(sheet.rows, 4);
        assert_eq!(sheet.preview[1], vec![SheetCell::Int(1), text("Ana Ruiz"), SheetCell::Date { d: "2024-03-15".into() }, SheetCell::Bool(true), SheetCell::Float(12.5)]);
        assert_eq!(sheet.preview[2], vec![SheetCell::Int(2), text("Luis Peña"), SheetCell::Date { d: "2023-03-15".into() }, SheetCell::Bool(false), SheetCell::Null]);
        assert_eq!(sheet.preview[3], vec![SheetCell::Int(3), text("Marta Gil"), SheetCell::Null, SheetCell::Bool(true), SheetCell::Int(-3)]);
        // An unknown sheet name falls back to the first one.
        assert_eq!(read(path, Some("Nope")).sheet, "Notas");
    }

    const TYPED_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev/fixtures/import/tipos.xlsx");

    /// Writes dev/fixtures/import/tipos.xlsx (dev/import-e2e-check.mjs imports it on every engine):
    /// `cargo test --lib write_typed_fixture -- --ignored`.
    #[test]
    #[ignore]
    fn write_typed_fixture() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        let mut book = Workbook::new();
        let date = Format::new().set_num_format("dd/mm/yyyy");
        let stamp = Format::new().set_num_format("dd/mm/yyyy hh:mm:ss");
        let money = Format::new().set_num_format("#,##0.00");
        let ws = book.add_worksheet().set_name("Datos").unwrap();
        ws.write_string(0, 0, "Clientes importados (tipos de Excel)").unwrap();
        for (i, h) in ["id", "nombre", "alta", "activo", "saldo", "momento"].iter().enumerate() {
            ws.write_string(2, 1 + i as u16, *h).unwrap();
        }
        let rows: [(f64, &str, Option<(u16, u8, u8)>, Option<bool>, f64, Option<(u16, u8, u8, u16, u8, u8)>); 4] = [
            (1.0, "Ana Ruiz", Some((2024, 3, 15)), Some(true), 12.5, Some((2024, 3, 15, 10, 20, 0))),
            (2.0, "Luis Peña", Some((2023, 1, 2)), Some(false), 0.1, None),
            (3.0, "Marta Gil", None, None, 1234.56, None),
            (4.0, "O'Neil", Some((2024, 2, 29)), Some(true), -3.0, Some((2024, 2, 29, 23, 59, 59))),
        ];
        for (n, (id, nombre, alta, activo, saldo, momento)) in rows.iter().enumerate() {
            let r = 3 + n as u32;
            ws.write_number(r, 1, *id).unwrap();
            ws.write_string(r, 2, *nombre).unwrap();
            if let Some((y, m, d)) = alta {
                ws.write_datetime_with_format(r, 3, &ExcelDateTime::from_ymd(*y, *m, *d).unwrap(), &date).unwrap();
            }
            if let Some(b) = activo {
                ws.write_boolean(r, 4, *b).unwrap();
            }
            ws.write_number_with_format(r, 5, *saldo, &money).unwrap();
            if let Some((y, mo, d, h, mi, s)) = momento {
                ws.write_datetime_with_format(r, 6, &ExcelDateTime::from_ymd(*y, *mo, *d).unwrap().and_hms(*h, *mi, *s).unwrap(), &stamp).unwrap();
            }
        }
        book.save(TYPED_FIXTURE).unwrap();
    }

    #[test]
    fn reads_the_typed_fixture() {
        let sheet = read(TYPED_FIXTURE, None);
        assert_eq!((sheet.first_row, sheet.first_col, sheet.last_row, sheet.last_col, sheet.rows), (0, 0, 6, 6, 7));
        assert_eq!(sheet.preview[2][1..], [text("id"), text("nombre"), text("alta"), text("activo"), text("saldo"), text("momento")]);
        assert_eq!(
            sheet.preview[3][1..],
            [SheetCell::Int(1), text("Ana Ruiz"), SheetCell::Date { d: "2024-03-15".into() }, SheetCell::Bool(true), SheetCell::Float(12.5), SheetCell::Date { d: "2024-03-15 10:20:00".into() }]
        );
        assert_eq!(sheet.preview[5][1..], [SheetCell::Int(3), text("Marta Gil"), SheetCell::Null, SheetCell::Null, SheetCell::Float(1234.56), SheetCell::Null]);
        assert_eq!(sheet.preview[6][6], SheetCell::Date { d: "2024-02-29 23:59:59".into() });
        close(sheet.handle);
    }

    #[test]
    fn a_big_sheet_reports_progress_and_can_be_cancelled() {
        let path = std::env::temp_dir().join(format!("celer-sheet-big-{}.xlsx", std::process::id()));
        let mut book = rust_xlsxwriter::Workbook::new();
        let ws = book.add_worksheet_with_constant_memory();
        ws.write_string(0, 0, "n").unwrap();
        ws.write_string(0, 1, "texto").unwrap();
        for r in 1..=100_000u32 {
            ws.write_number(r, 0, r as f64).unwrap();
            ws.write_string(r, 1, format!("fila {r}")).unwrap();
        }
        book.save(&path).unwrap();
        let p = path.to_str().unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let sheet = open(p, None, "big", &|done, total| seen.lock().unwrap().push((done, total))).unwrap();
        assert_eq!(sheet.rows, 100_001);
        assert_eq!(sheet.preview.len(), PREVIEW_ROWS);
        let seen = seen.into_inner().unwrap();
        assert!(seen.len() > 10, "progress while reading");
        assert_eq!(*seen.last().unwrap(), (100_001, 100_001));
        assert_eq!(rows(sheet.handle, 100_000, 100_000, 0, 1).unwrap(), vec![vec![SheetCell::Int(100_000), text("fila 100000")]]);
        close(sheet.handle);
        // Cancelled from the first progress report on.
        let res = open(p, None, "big-cancel", &|_, _| cancel("big-cancel"));
        assert_eq!(res.err().map(|e| e.to_string()).as_deref(), Some(CANCELLED));
        let _ = std::fs::remove_file(&path);
    }
}
