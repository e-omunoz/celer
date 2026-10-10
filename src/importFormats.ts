// Reading the files the import wizard accepts: CSV / TSV, JSON (objects, arrays, JSON Lines), a block pasted from
// Excel; the header row and cell range of a spreadsheet; and the INSERT statements, with each value as its column
// takes it. Pure, so dev/import-check.ts tests it and dev/engine-sql.ts runs its SQL on every engine; spreadsheets
// are read by the Rust side (sheets.rs), which hands over typed cells.
import { fitValue } from "./sqlgen.ts";
import { sqlLiteral } from "./sql.ts";
import type { DbKind, TableColumn } from "./types";

/** RFC 4180 CSV parser (quotes, doubled quotes, CRLF, newlines inside quotes). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Picks the delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).filter(Boolean);
  let best = ",";
  let bestScore = -1;
  for (const delimiter of [",", ";", "\t", "|"]) {
    const counts = sample.map((line) => line.split(delimiter).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.every((count) => count === counts[0]);
    const score = counts[0] * (consistent ? 2 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** A JSON value as an import cell: null as empty (NULL with «vacíos como NULL»), objects and arrays as JSON. */
function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Integers of 16 digits or more as strings before parsing: a JavaScript number would round them (ids such as
 * 9007199254740993 must arrive exactly as written). Strings are skipped whole, so their digits stay as they are.
 */
function keepBigIntegers(json: string): string {
  return json.replace(/"(?:[^"\\]|\\.)*"|(?<![\w.+-])-?\d{16,}(?![\d.eE])/g, (match) => (match.startsWith('"') ? match : `"${match}"`));
}

/**
 * JSON data as rows with a header row: an array of objects (the header is every key, in order of appearance),
 * an array of arrays (as they are), an object holding such an array ({"data": […]}) or JSON Lines.
 */
export function parseJsonRows(text: string): { rows: string[][]; objects: boolean } {
  const src = keepBigIntegers(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch (err) {
    // JSON Lines: one value per line.
    const lines = src.split(/\r?\n/).filter((line) => line.trim());
    try {
      data = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error(`El fichero no es JSON válido: ${(err as Error).message}`);
    }
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const inner = Object.values(data as Record<string, unknown>).find((value) => Array.isArray(value) && value.some((item) => item && typeof item === "object"));
    data = inner ?? [data];
  }
  if (!Array.isArray(data)) throw new Error("El JSON no contiene una lista de filas");
  const items = data.filter((item) => item !== null && item !== undefined);
  if (items.length && items.every(Array.isArray)) return { rows: (items as unknown[][]).map((row) => row.map(jsonCell)), objects: false };
  if (!items.every((item) => typeof item === "object" && !Array.isArray(item))) throw new Error("Las filas del JSON deben ser objetos o listas");
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of items as Record<string, unknown>[]) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return { rows: [keys, ...(items as Record<string, unknown>[]).map((item) => keys.map((key) => jsonCell(item[key])))], objects: true };
}

/** "paste": a block pasted from the clipboard (copied from Excel: tab-separated), read like a sheet. */
export type ImportFormat = "csv" | "json" | "sheet" | "paste";

export function importFormat(path: string): ImportFormat {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "json" || ext === "jsonl" || ext === "ndjson") return "json";
  if (["xlsx", "xlsm", "xlsb", "xls", "ods"].includes(ext)) return "sheet";
  return "csv";
}

// ---------------------------------------------------------------- typed cells (spreadsheets, pasted blocks)

/** A spreadsheet cell with its type, as sheets.rs sends it: dates as `{ d: "2024-03-15[ 10:20:00]" }`, times `{ t }`. */
export type SheetCell = null | boolean | number | string | { d: string } | { t: string };

/** A number in plain decimal notation (no exponent), integers without ".0". */
export function plainNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const text = String(n);
  if (!/e/i.test(text)) return text;
  // 1e-7 → 0.0000001, 1.5e+21 → 1500000000000000000000: the digits JavaScript keeps, without the exponent.
  const [mantissa, exp] = text.toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const unsigned = mantissa.replace(/^-/, "");
  const digits = unsigned.replace(".", "");
  const dot = unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length;
  const point = dot + Number(exp);
  const body = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + body.replace(/^0+(?=\d)/, "");
}

/** An Excel serial date (days since 1899-12-30; a fraction is the time of day) as ISO text. */
export function excelSerialDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

const isDate = (cell: SheetCell): cell is { d: string } => typeof cell === "object" && cell !== null && "d" in cell;
const isTime = (cell: SheetCell): cell is { t: string } => typeof cell === "object" && cell !== null && "t" in cell;

/** What a cell shows in the wizard (mapping examples, header names). */
export function cellDisplay(cell: SheetCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return plainNumber(cell);
  if (typeof cell === "boolean") return String(cell);
  if (isDate(cell)) return cell.d;
  if (isTime(cell)) return cell.t;
  return String(cell);
}

const isEmpty = (cell: SheetCell) => cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "");

/**
 * Text pasted from a spreadsheet, read as Excel shows it in a Spanish locale: numbers (decimal comma or point,
 * thousands separators), dates (dd/mm/aaaa, aaaa-mm-dd, with a time), times, booleans (VERDADERO / FALSO, true /
 * false); anything else stays text (codes with leading zeros too). An empty field is null.
 */
export function inferCell(text: string): SheetCell {
  const s = text.trim();
  if (!s) return null;
  if (/^(verdadero|true)$/i.test(s)) return true;
  if (/^(falso|false)$/i.test(s)) return false;
  if (/^-?\d+$/.test(s)) return /^-?0\d/.test(s) || s.replace("-", "").length > 15 ? text : Number(s);
  // 1.234,56 · 1.234.567 · 1,234.56 · -12,5 · 12.5 · 0.125 (a single ".ddd" is a decimal, as Celer copies them)
  let m = /^(-?)(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/.exec(s);
  if (m && !m[3] && !/\..*\./.test(m[2])) m = null;
  if (m) return Number(`${m[1]}${m[2].replace(/\./g, "")}${m[3] ? `.${m[3]}` : ""}`);
  m = /^(-?)(\d{1,3}(?:,\d{3})+)\.(\d+)$/.exec(s);
  if (m) return Number(`${m[1]}${m[2].replace(/,/g, "")}.${m[3]}`);
  if (/^-?\d+,\d+$/.test(s)) return Number(s.replace(",", "."));
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31) {
    const date = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return { d: m[4] ? `${date} ${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}` : date };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return { d: m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? "00"}` : `${m[1]}-${m[2]}-${m[3]}` };
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return { t: `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}` };
  return text;
}

/** A block copied from Excel (tab-separated lines; quoted fields may hold tabs or line breaks), as typed cells. */
export function pastedCells(text: string): SheetCell[][] {
  const rows = parseCsv(text.replace(/\r?\n$/, ""), "\t");
  const width = Math.max(0, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, i) => inferCell(row[i] ?? "")));
}

/**
 * Pasted text as a cell of a column of `kind` (pasting into the grid): the text the editor would take, e.g.
 * "15/03/2024" → "2024-03-15" for a date, "1.234,5" → "1234.5" for a number, "VERDADERO" → "true"; an empty field
 * is NULL; text columns get the text as it is.
 */
export function pastedValue(text: string, kind: string): string | null {
  if (kind === "text" || kind === "other" || kind === "binary") return text === "" ? null : text;
  const cell = inferCell(text);
  if (cell === null) return null;
  if (kind === "bool" && typeof cell === "number") return cell !== 0 ? "true" : "false";
  if (kind === "date" && typeof cell === "number" && cell > 0) return excelSerialDate(cell);
  return cellDisplay(cell);
}

/**
 * Where the data of a sheet starts: the header row (index in `rows`, -1: none) and the first data row. The header
 * is the first row that fills half the width of the data (two cells at least) and holds only distinct text; rows
 * above it (a title, a note, blank lines) are skipped. When that first full row holds numbers, dates or booleans
 * there is no header and the data starts there.
 */
export function detectHeader(rows: SheetCell[][]): { header: number; start: number } {
  const sample = rows.slice(0, 50);
  const filled = (row: SheetCell[]) => row.filter((cell) => !isEmpty(cell)).length;
  const width = Math.max(0, ...sample.map(filled));
  if (!width) return { header: -1, start: 0 };
  for (let i = 0; i < Math.min(sample.length, 30); i++) {
    const cells = sample[i].filter((cell) => !isEmpty(cell));
    if (!cells.length || cells.length < Math.min(width, Math.max(2, Math.ceil(width / 2)))) continue;
    const texts = cells.every((cell) => typeof cell === "string" && typeof inferCell(cell) === "string");
    const distinct = new Set(cells.map((cell) => cellDisplay(cell).trim().toLowerCase())).size === cells.length;
    return texts && distinct && i + 1 < rows.length ? { header: i, start: i + 1 } : { header: -1, start: i };
  }
  return { header: -1, start: 0 };
}

/** Column letters for a 0-based column (0 → A, 26 → AA). */
export function columnLetters(col: number): string {
  let out = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/**
 * A cell range typed by hand, 0-based and inclusive: "B3:F200"; "B3:F" (to the last row); "B:F" (whole columns);
 * "B3" (from that cell on). null when it is not a range.
 */
export function parseCellRange(text: string): { r1: number; c1: number; r2: number | null; c2: number | null } | null {
  const m = /^\s*\$?([a-z]{1,3})\$?(\d*)\s*(?::\s*\$?([a-z]{1,3})\$?(\d*))?\s*$/i.exec(text);
  if (!m) return null;
  const col = (letters: string) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r1 = m[2] ? Number(m[2]) - 1 : 0;
  const c1 = col(m[1]);
  const c2 = m[3] ? col(m[3]) : null;
  const r2 = m[4] ? Number(m[4]) - 1 : null;
  if (r1 < 0 || (r2 !== null && r2 < r1) || (c2 !== null && c2 < c1)) return null;
  return { r1, c1, r2, c2 };
}

/** The columns of the import: the table's, and where each is fed from (index in the source, -1: not imported). */
export interface ImportTarget {
  qualified: string;
  columns: TableColumn[];
  quoted: string[];
  mapping: number[];
  emptyAsNull: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * A cell as the SQL literal its column takes: a typed value is written for the column's kind (no round trip
 * through locale text), text as the CSV import always did. A number into a date column is an Excel serial date; a
 * date-time into a DATE column keeps the date; an Informix DATE gets MDY(…) (its text form depends on DBDATE).
 */
export function importLiteral(cell: SheetCell, col: TableColumn, dialect: DbKind, emptyAsNull: boolean): string {
  if (cell === null || cell === undefined) return "NULL";
  const kind = col.kind;
  let text: string;
  if (typeof cell === "boolean") text = kind === "number" ? (cell ? "1" : "0") : String(cell);
  else if (typeof cell === "number") text = kind === "bool" ? (cell !== 0 ? "true" : "false") : kind === "date" && cell > 0 && cell < 2_958_466 ? excelSerialDate(cell) : plainNumber(cell);
  else if (isDate(cell)) text = cell.d;
  else if (isTime(cell)) text = cell.t;
  else {
    if (cell === "" && emptyAsNull) return "NULL";
    if (/^null$/i.test(cell) && col.nullable) return "NULL";
    text = cell;
  }
  if (kind === "date" && /^date$/i.test(col.typeName.trim())) {
    const iso = ISO_DATE.exec(text.trim());
    if (iso) {
      if (dialect === "informix") return `MDY(${Number(iso[2])}, ${Number(iso[3])}, ${iso[1]})`;
      text = `${iso[1]}-${iso[2]}-${iso[3]}`;
    }
  }
  return sqlLiteral(fitValue(text, col, dialect), kind, dialect);
}

/** A row with nothing in the mapped columns (a blank line between the data) is not imported. */
export function blankRow(row: SheetCell[], mapping: number[]): boolean {
  return mapping.every((source) => source < 0 || isEmpty(row[source] ?? null));
}

/** Rows per INSERT statement. */
export const importBatch = (dialect: DbKind) => (dialect === "mssql" ? 900 : 500);

/** The INSERT statements for `rows`, several rows each (importBatch). */
export function importStatements(rows: SheetCell[][], target: ImportTarget, dialect: DbKind): string[] {
  const used = target.columns.map((col, index) => ({ col, index, source: target.mapping[index] })).filter((item) => item.source >= 0);
  if (!used.length) return [];
  const names = used.map((item) => target.quoted[item.index]).join(", ");
  const batch = importBatch(dialect);
  const out: string[] = [];
  for (let start = 0; start < rows.length; start += batch) {
    const values = rows.slice(start, start + batch).map((row) => `(${used.map((item) => importLiteral(row[item.source] ?? null, item.col, dialect, target.emptyAsNull)).join(", ")})`);
    // Informix has no multi-row VALUES: one INSERT per row, sent together.
    out.push(dialect === "informix" ? values.map((v) => `INSERT INTO ${target.qualified} (${names}) VALUES ${v}`).join(";\n") : `INSERT INTO ${target.qualified} (${names}) VALUES\n${values.join(",\n")}`);
  }
  return out;
}
