import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { gib, kindOf, notify, reloadTable, state as appState } from "./state";
import type { DbKind, ObjectRef, TableColumn } from "./types";
import {
  blankRow,
  cellDisplay,
  columnLetters,
  detectDelimiter,
  detectHeader,
  importBatch,
  importFormat,
  importStatements,
  parseCellRange,
  parseCsv,
  parseJsonRows,
  pastedCells,
  type ImportFormat,
  type SheetCell,
} from "./importFormats";

export { detectDelimiter, importFormat, parseCsv, parseJsonRows, type ImportFormat };

/** Rows asked of the core at a time while a sheet is imported (the sheet itself stays there). */
const SHEET_CHUNK = 5_000;
/** Data rows shown as examples in the mapping. */
const PREVIEW = 200;

export interface ImportState {
  open: boolean;
  connId: string;
  obj: ObjectRef | null;
  qualified: string;
  columns: TableColumn[];
  quoted: string[];
  fileName: string;
  /** The file's full path (to read another sheet of the same workbook). */
  filePath: string;
  format: ImportFormat;
  /** JSON as cells (CSV is parsed from `text`). */
  grid: string[][];
  /** JSON objects: the header comes from their keys, always. */
  keyedHeader: boolean;
  sheets: string[];
  sheet: string;
  text: string;
  delimiter: string;
  hasHeader: boolean;
  emptyAsNull: boolean;
  /** For each table column, the source column index that feeds it (-1 = not imported). */
  mapping: number[];
  running: boolean;
  done: number;
  total: number;
  // ---- a sheet (or a pasted block), read by position: rows and columns are sheet positions (0 = row 1 / column A)
  /** The open sheet in the core (0: none; a pasted block lives in `pasted`). */
  handle: number;
  /** Its used area. */
  area: { r1: number; c1: number; r2: number; c2: number };
  /** The first rows of the used area, typed (for the header choice). */
  head: SheetCell[][];
  /** The range typed by the user ("": the used area). */
  range: string;
  /** Header row (sheet position), -1: none. */
  headerRow: number;
  /** The header row found when the sheet was opened (-1: none), to label it «detectada». */
  detectedHeader: number;
  /** First data row when there is no header and no range (a title above the data is skipped). */
  autoStart: number;
  /** The header cells and the first data rows of the import area, typed. */
  headerCells: SheetCell[];
  previewRows: SheetCell[][];
  /** A pasted block, whole (it is small: it came through the clipboard). */
  pasted: SheetCell[][];
  /** A workbook being read: rows so far and in all (0: not known yet). */
  reading: { rows: number; total: number } | null;
}

const NO_AREA = { r1: 0, c1: 0, r2: -1, c2: -1 };

export const [importer, setImporter] = createStore<ImportState>({
  open: false,
  connId: "",
  obj: null,
  qualified: "",
  columns: [],
  quoted: [],
  fileName: "",
  filePath: "",
  format: "csv",
  grid: [],
  keyedHeader: false,
  sheets: [],
  sheet: "",
  text: "",
  delimiter: ",",
  hasHeader: true,
  emptyAsNull: true,
  mapping: [],
  running: false,
  done: 0,
  total: 0,
  handle: 0,
  area: NO_AREA,
  head: [],
  range: "",
  headerRow: -1,
  detectedHeader: -1,
  autoStart: 0,
  headerCells: [],
  previewRows: [],
  pasted: [],
  reading: null,
});

let cancelRequested = false;
let openSeq = 0;

/** A file is loaded (CSV text, JSON cells, a sheet or a pasted block). */
export function hasFile() {
  return Boolean(importer.fileName);
}

/** Read by position (a workbook's sheet or a block pasted from Excel). */
export const isSheetLike = () => importer.format === "sheet" || importer.format === "paste";

/** The area the user chose (a range), within the used area; null when the range does not parse. */
export function importArea(): { r1: number; c1: number; r2: number; c2: number } | null {
  const used = importer.area;
  if (!importer.range.trim()) return used;
  const r = parseCellRange(importer.range);
  if (!r) return null;
  return { r1: r.r1, c1: r.c1, r2: Math.min(r.r2 ?? used.r2, used.r2), c2: Math.min(r.c2 ?? used.c2, used.c2) };
}

/** First data row of a sheet: after the header, from the range's top (or the data found, without a range). */
function dataStart(area: { r1: number }) {
  const top = importer.range.trim() ? area.r1 : Math.max(area.r1, importer.autoStart);
  return importer.headerRow >= 0 ? Math.max(importer.headerRow + 1, top) : top;
}

/** Rows that will be imported (a sheet's are counted by position; blank lines in it are skipped when importing). */
export function importRowCount(): number {
  if (!hasFile()) return 0;
  if (isSheetLike()) {
    const area = importArea();
    return area ? Math.max(0, area.r2 - dataStart(area) + 1) : 0;
  }
  return parsed().rows.length;
}

export function parsed() {
  if (!hasFile()) return { header: [] as string[], rows: [] as string[][] };
  if (isSheetLike()) {
    const area = importArea();
    if (!area) return { header: [] as string[], rows: [] as string[][] };
    const width = Math.max(0, area.c2 - area.c1 + 1);
    const header = Array.from({ length: width }, (_, i) => cellDisplay(importer.headerCells[i] ?? null).trim() || `columna ${columnLetters(area.c1 + i)}`);
    return { header, rows: importer.previewRows.map((row) => row.map(cellDisplay)) };
  }
  const all = importer.format === "csv" ? parseCsv(importer.text, importer.delimiter) : importer.grid;
  if (!importer.hasHeader && !importer.keyedHeader) return { header: (all[0] ?? []).map((_, index) => `columna ${index + 1}`), rows: all };
  return { header: all[0] ?? [], rows: all.slice(1) };
}

function autoMap(header: string[], columns: TableColumn[]) {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return columns.map((col) => header.findIndex((name) => norm(name) === norm(col.name)));
}

/** Lets go of the sheet kept in the core for this wizard. */
function releaseSheet() {
  if (importer.handle) void api().sheetClose(importer.handle).catch(() => {});
}

export async function startImport(connId: string, obj: ObjectRef) {
  try {
    const opened = await api().openSession(connId, appState.passwords[connId]);
    try {
      if (obj.database) await api().useDatabase(opened.sessionId, obj.database).catch(() => {});
      const [columns, info] = await Promise.all([api().tableColumns(opened.sessionId, obj), api().objectSql(opened.sessionId, obj)]);
      const quoted = await api().quoteIdents(opened.sessionId, columns.map((col) => col.name));
      releaseSheet();
      setImporter({ open: true, connId, obj, qualified: info.qualified, columns, quoted, fileName: "", filePath: "", format: "csv", grid: [], keyedHeader: false, sheets: [], sheet: "", text: "", mapping: columns.map(() => -1), running: false, done: 0, total: 0, ...emptySheet() });
    } finally {
      void api().closeSession(opened.sessionId).catch(() => {});
    }
  } catch (err) {
    notify(errorText(err), "error");
  }
}

const emptySheet = () => ({ handle: 0, area: NO_AREA, head: [] as SheetCell[][], range: "", headerRow: -1, detectedHeader: -1, autoStart: 0, headerCells: [] as SheetCell[], previewRows: [] as SheetCell[][], pasted: [] as SheetCell[][], reading: null });

export async function pickImportFile() {
  const path = await api().pickOpenPath([
    { name: "Datos (CSV, JSON, Excel, OpenDocument)", extensions: ["csv", "tsv", "txt", "json", "jsonl", "ndjson", "xlsx", "xlsm", "xlsb", "xls", "ods"] },
    { name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] },
    { name: "JSON", extensions: ["json", "jsonl", "ndjson"] },
    { name: "Hojas de cálculo", extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods"] },
  ]);
  if (!path) return;
  try {
    const fileName = path.split(/[\\/]/).pop() ?? path;
    const format = importFormat(path);
    if (format === "sheet") {
      await openSheet(path, null, fileName);
      return;
    }
    releaseSheet();
    if (format === "json") {
      const { text } = await api().readTextFile(path);
      const json = parseJsonRows(text);
      setImporter({ fileName, filePath: path, format, grid: json.rows, sheets: [], sheet: "", keyedHeader: json.objects, hasHeader: true, text: "", ...emptySheet() });
    } else {
      const { text } = await api().readTextFile(path);
      const delimiter = path.toLowerCase().endsWith(".tsv") ? "\t" : detectDelimiter(text);
      setImporter({ fileName, filePath: path, format, grid: [], sheets: [], sheet: "", keyedHeader: false, text, delimiter, ...emptySheet() });
    }
    remap();
  } catch (err) {
    notify(errorText(err), "error");
  }
}

/**
 * Reads a sheet of a workbook in the core (with progress, and «Cancelar» stops it): the wizard gets its first
 * rows, typed, finds the header row and where the data starts, and maps the columns.
 */
async function openSheet(path: string, sheet: string | null, fileName = importer.fileName) {
  const seq = ++openSeq;
  const openId = `sheet-${Date.now()}-${seq}`;
  setImporter("reading", { rows: 0, total: 0 });
  const stopListening = await api()
    .onSheetProgress((p) => p.openId === openId && seq === openSeq && setImporter("reading", { rows: p.rows, total: p.total }))
    .catch(() => () => {});
  readingId = openId;
  try {
    const info = await api().sheetOpen(path, sheet, openId);
    if (seq !== openSeq) {
      void api().sheetClose(info.handle).catch(() => {});
      return;
    }
    releaseSheet();
    const found = detectHeader(info.preview);
    const area = info.rows ? { r1: info.firstRow, c1: info.firstCol, r2: info.firstRow + info.rows - 1, c2: info.lastCol } : NO_AREA;
    setImporter({
      fileName,
      filePath: path,
      format: "sheet",
      grid: [],
      text: "",
      keyedHeader: false,
      sheets: info.sheets,
      sheet: info.sheet,
      handle: info.handle,
      area,
      head: info.preview.slice(0, 30),
      range: "",
      headerRow: found.header >= 0 ? info.firstRow + found.header : -1,
      detectedHeader: found.header >= 0 ? info.firstRow + found.header : -1,
      autoStart: info.firstRow + found.start,
      pasted: [],
      reading: null,
    });
    await refreshPreview(info.preview, info.firstRow);
    remap();
  } catch (err) {
    if (seq === openSeq) {
      setImporter("reading", null);
      if (!/cancelada/i.test(errorText(err))) notify(errorText(err), "error");
    }
  } finally {
    stopListening();
    if (readingId === openId) readingId = "";
  }
}

let readingId = "";

/** Another sheet of the workbook. */
export async function pickSheet(sheet: string) {
  await openSheet(importer.filePath, sheet);
}

/**
 * The header cells and first data rows of the area to import, from the rows at hand (`known`, starting at sheet
 * row `knownFrom`) or asked of the core.
 */
async function refreshPreview(known: SheetCell[][] = importer.format === "paste" ? importer.pasted : [], knownFrom = 0) {
  const area = importArea();
  if (!area || area.r2 < 0) {
    setImporter({ headerCells: [], previewRows: [] });
    return;
  }
  const start = dataStart(area);
  const last = Math.min(area.r2, start + PREVIEW - 1);
  const slice = (row: SheetCell[]) => Array.from({ length: area.c2 - area.c1 + 1 }, (_, i) => row[area.c1 + i - importer.area.c1] ?? null);
  const fromKnown = (r: number) => (r >= knownFrom && r - knownFrom < known.length ? known[r - knownFrom] : undefined);
  const header = importer.headerRow >= 0 ? fromKnown(importer.headerRow) : undefined;
  const rows: SheetCell[][] = [];
  let complete = true;
  for (let r = start; r <= last; r++) {
    const row = fromKnown(r);
    if (!row) {
      complete = false;
      break;
    }
    rows.push(slice(row));
  }
  if (complete && (header || importer.headerRow < 0)) {
    setImporter({ headerCells: header ? slice(header) : [], previewRows: rows });
    return;
  }
  if (!importer.handle) return;
  try {
    const [head, data] = await Promise.all([
      importer.headerRow >= 0 ? api().sheetRows(importer.handle, importer.headerRow, importer.headerRow, area.c1, area.c2) : Promise.resolve([] as SheetCell[][]),
      last >= start ? api().sheetRows(importer.handle, start, last, area.c1, area.c2) : Promise.resolve([] as SheetCell[][]),
    ]);
    setImporter({ headerCells: head[0] ?? [], previewRows: data });
  } catch (err) {
    notify(errorText(err), "error");
  }
}

/** A range typed in the wizard ("" for the whole used area): the header and examples follow it. */
export async function setImportRange(text: string) {
  setImporter("range", text.trim().toUpperCase());
  const area = importArea();
  if (!area) return;
  // A header above the new range stays only if it is right above it; otherwise the range's first row may be it.
  if (text.trim() && importer.headerRow >= 0 && (importer.headerRow < area.r1 - 1 || importer.headerRow > area.r2)) setImporter("headerRow", area.r1);
  await refreshPreview(importer.format === "paste" ? importer.pasted : importer.head, importer.format === "paste" ? 0 : importer.area.r1);
  remap();
}

/** The header row (sheet position), or -1 for none. */
export async function setHeaderRow(row: number) {
  setImporter("headerRow", row);
  await refreshPreview(importer.format === "paste" ? importer.pasted : importer.head, importer.format === "paste" ? 0 : importer.area.r1);
  remap();
}

/** Rows offered as the header: the first non-empty rows of the used area (or of the range). */
export function headerChoices(): { row: number; label: string }[] {
  const source = importer.format === "paste" ? importer.pasted : importer.head;
  const from = importer.format === "paste" ? 0 : importer.area.r1;
  const out: { row: number; label: string }[] = [];
  source.slice(0, 30).forEach((row, i) => {
    const texts = row.map(cellDisplay).filter((text) => text.trim());
    if (texts.length) out.push({ row: from + i, label: `Fila ${from + i + 1}: ${texts.slice(0, 4).join(", ")}${texts.length > 4 ? "…" : ""}` });
  });
  return out;
}

/**
 * A block pasted from Excel (or any tab-separated text): read like a sheet, with its header found and its values
 * typed, then mapped as a file would be.
 */
export async function pasteImport(text: string) {
  if (importer.running || !text.trim()) return;
  const cells = pastedCells(text);
  if (!cells.length) return;
  releaseSheet();
  openSeq++;
  const found = detectHeader(cells);
  const width = Math.max(0, ...cells.map((row) => row.length));
  setImporter({
    fileName: "Pegado del portapapeles",
    filePath: "",
    format: "paste",
    grid: [],
    text: "",
    keyedHeader: false,
    sheets: [],
    sheet: "",
    ...emptySheet(),
    pasted: cells,
    head: cells.slice(0, 30),
    area: { r1: 0, c1: 0, r2: cells.length - 1, c2: width - 1 },
    headerRow: found.header,
    detectedHeader: found.header,
    autoStart: found.start,
  });
  await refreshPreview(cells, 0);
  remap();
}

export function remap() {
  setImporter("mapping", autoMap(parsed().header, importer.columns));
}

/** The INSERT statements for `rows` with the wizard's table and mapping. */
export function importSql(rows: SheetCell[][], dialect: DbKind): string[] {
  return importStatements(rows, { qualified: importer.qualified, columns: importer.columns, quoted: importer.quoted, mapping: importer.mapping, emptyAsNull: importer.emptyAsNull }, dialect);
}

/**
 * The rows to import, a batch at a time: a sheet's come from the core in chunks (it is never all in the window
 * as text), the rest from what was read.
 */
async function* importChunks(): AsyncGenerator<{ rows: SheetCell[][]; span: number }> {
  if (importer.format === "sheet" || importer.format === "paste") {
    const area = importArea();
    if (!area) return;
    const mapping = importer.mapping.slice();
    for (let start = dataStart(area); start <= area.r2; start += SHEET_CHUNK) {
      const end = Math.min(area.r2, start + SHEET_CHUNK - 1);
      const rows =
        importer.format === "paste"
          ? importer.pasted.slice(start, end + 1).map((row) => row.slice(area.c1, area.c2 + 1))
          : await api().sheetRows(importer.handle, start, end, area.c1, area.c2);
      // `span`: the sheet rows this chunk covers (the progress), blank lines included.
      yield { rows: rows.filter((row) => !blankRow(row, mapping)), span: end - start + 1 };
    }
    return;
  }
  const rows = parsed().rows;
  yield { rows, span: rows.length };
}

/** Imports every row in one transaction; any failure rolls the whole import back. */
export async function runImport() {
  const total = importRowCount();
  if (!total || !importer.mapping.some((value) => value >= 0)) return;
  const dialect = kindOf(importer.connId);
  cancelRequested = false;
  setImporter({ running: true, done: 0, total });
  const opened = await api().openSession(importer.connId, appState.passwords[importer.connId]).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) {
    setImporter("running", false);
    return;
  }
  const session = opened.sessionId;
  const batch = importBatch(dialect);
  let imported = 0;
  let covered = 0;
  try {
    if (importer.obj?.database) await api().useDatabase(session, importer.obj.database).catch(() => {});
    await api().setAutocommit(session, false);
    for await (const { rows, span } of importChunks()) {
      if (cancelRequested) throw new Error("Importación cancelada");
      const statements = importSql(rows, dialect);
      for (let i = 0; i < statements.length; i++) {
        if (cancelRequested) throw new Error("Importación cancelada");
        try {
          await api().execute(session, statements[i], 1);
        } catch (err) {
          throw new Error(`Filas ${imported + i * batch + 1}–${imported + Math.min(rows.length, (i + 1) * batch)}: ${errorText(err)}`);
        }
        const part = rows.length ? Math.min(rows.length, (i + 1) * batch) / rows.length : 1;
        setImporter("done", Math.min(total, covered + Math.round(span * part)));
      }
      imported += rows.length;
      covered += span;
      setImporter("done", Math.min(total, covered));
    }
    await api().commit(session);
    notify(`Importadas ${imported.toLocaleString()} filas en ${importer.obj?.name}`, "success");
    gib("saved");
    releaseSheet();
    setImporter({ open: false, running: false, handle: 0 });
    for (const tab of appState.tabs) {
      if (tab.kind === "table" && tab.connId === importer.connId && tab.obj.name === importer.obj?.name) void reloadTable(tab.id);
    }
  } catch (err) {
    await api().rollback(session).catch(() => {});
    setImporter("running", false);
    notify("No se importó nada: la operación se deshizo", "error", errorText(err));
  } finally {
    void api().closeSession(session).catch(() => {});
  }
}

export function cancelImport() {
  if (importer.running) cancelRequested = true;
  else if (importer.reading) {
    // Stop reading the workbook; the wizard stays as it was before.
    if (readingId) void api().sheetCancel(readingId).catch(() => {});
    openSeq++;
    setImporter("reading", null);
  } else {
    releaseSheet();
    setImporter({ open: false, handle: 0 });
  }
}
