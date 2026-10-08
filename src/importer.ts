import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { sqlLiteral } from "./sql";
import { fitValue } from "./sqlgen";
import { gib, kindOf, notify, reloadTable, state as appState } from "./state";
import type { DbKind, ObjectRef, TableColumn } from "./types";
import { detectDelimiter, importFormat, parseCsv, parseJsonRows, type ImportFormat } from "./importFormats";

export { detectDelimiter, importFormat, parseCsv, parseJsonRows, type ImportFormat };

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
  /** JSON or a sheet, already as cells (CSV is parsed from `text`). */
  grid: string[][];
  /** JSON objects: the header comes from their keys, always. */
  keyedHeader: boolean;
  sheets: string[];
  sheet: string;
  text: string;
  delimiter: string;
  hasHeader: boolean;
  emptyAsNull: boolean;
  /** For each table column, the CSV column index that feeds it (-1 = not imported). */
  mapping: number[];
  running: boolean;
  done: number;
  total: number;
}

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
});

let cancelRequested = false;

/** A file is loaded (CSV text, or JSON / sheet cells). */
export function hasFile() {
  return Boolean(importer.fileName);
}

export function parsed() {
  if (!hasFile()) return { header: [] as string[], rows: [] as string[][] };
  const all = importer.format === "csv" ? parseCsv(importer.text, importer.delimiter) : importer.grid;
  if (!importer.hasHeader && !importer.keyedHeader) return { header: (all[0] ?? []).map((_, index) => `columna ${index + 1}`), rows: all };
  return { header: all[0] ?? [], rows: all.slice(1) };
}

function autoMap(header: string[], columns: TableColumn[]) {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return columns.map((col) => header.findIndex((name) => norm(name) === norm(col.name)));
}

export async function startImport(connId: string, obj: ObjectRef) {
  try {
    const opened = await api().openSession(connId, appState.passwords[connId]);
    try {
      if (obj.database) await api().useDatabase(opened.sessionId, obj.database).catch(() => {});
      const [columns, info] = await Promise.all([api().tableColumns(opened.sessionId, obj), api().objectSql(opened.sessionId, obj)]);
      const quoted = await api().quoteIdents(opened.sessionId, columns.map((col) => col.name));
      setImporter({ open: true, connId, obj, qualified: info.qualified, columns, quoted, fileName: "", filePath: "", format: "csv", grid: [], keyedHeader: false, sheets: [], sheet: "", text: "", mapping: columns.map(() => -1), running: false, done: 0, total: 0 });
    } finally {
      void api().closeSession(opened.sessionId).catch(() => {});
    }
  } catch (err) {
    notify(errorText(err), "error");
  }
}

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
      const book = await api().readSpreadsheet(path);
      setImporter({ fileName, filePath: path, format, grid: book.rows, sheets: book.sheets, sheet: book.sheet, keyedHeader: false, hasHeader: true, text: "" });
    } else if (format === "json") {
      const { text } = await api().readTextFile(path);
      const json = parseJsonRows(text);
      setImporter({ fileName, filePath: path, format, grid: json.rows, sheets: [], sheet: "", keyedHeader: json.objects, hasHeader: true, text: "" });
    } else {
      const { text } = await api().readTextFile(path);
      const delimiter = path.toLowerCase().endsWith(".tsv") ? "\t" : detectDelimiter(text);
      setImporter({ fileName, filePath: path, format, grid: [], sheets: [], sheet: "", keyedHeader: false, text, delimiter });
    }
    remap();
  } catch (err) {
    notify(errorText(err), "error");
  }
}

/** Another sheet of the workbook. */
export async function pickSheet(sheet: string) {
  try {
    const book = await api().readSpreadsheet(importer.filePath, sheet);
    setImporter({ grid: book.rows, sheet: book.sheet });
    remap();
  } catch (err) {
    notify(errorText(err), "error");
  }
}

export function remap() {
  setImporter("mapping", autoMap(parsed().header, importer.columns));
}

export function importSql(rows: string[][], dialect: DbKind): string[] {
  const used = importer.columns.map((col, index) => ({ col, index, source: importer.mapping[index] })).filter((item) => item.source >= 0);
  const names = used.map((item) => importer.quoted[item.index]).join(", ");
  const batch = dialect === "mssql" ? 900 : 500;
  const out: string[] = [];
  for (let start = 0; start < rows.length; start += batch) {
    const values = rows.slice(start, start + batch).map((row) => {
      const cells = used.map((item) => {
        const raw = row[item.source] ?? "";
        if (raw === "" && importer.emptyAsNull) return "NULL";
        if (/^null$/i.test(raw) && item.col.nullable) return "NULL";
        return sqlLiteral(fitValue(raw, item.col, dialect), item.col.kind, dialect);
      });
      return `(${cells.join(", ")})`;
    });
    out.push(`INSERT INTO ${importer.qualified} (${names}) VALUES\n${values.join(",\n")}`);
  }
  return out;
}

/** Imports every row in one transaction; any failure rolls the whole import back. */
export async function runImport() {
  const { rows } = parsed();
  if (!rows.length || !importer.mapping.some((value) => value >= 0)) return;
  const dialect = kindOf(importer.connId);
  const statements = importSql(rows, dialect);
  cancelRequested = false;
  setImporter({ running: true, done: 0, total: rows.length });
  const opened = await api().openSession(importer.connId, appState.passwords[importer.connId]).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) {
    setImporter("running", false);
    return;
  }
  const session = opened.sessionId;
  const batch = dialect === "mssql" ? 900 : 500;
  try {
    if (importer.obj?.database) await api().useDatabase(session, importer.obj.database).catch(() => {});
    await api().setAutocommit(session, false);
    for (let i = 0; i < statements.length; i++) {
      if (cancelRequested) throw new Error("Importación cancelada");
      try {
        await api().execute(session, statements[i], 1);
      } catch (err) {
        throw new Error(`Filas ${i * batch + 1}–${Math.min(rows.length, (i + 1) * batch)}: ${errorText(err)}`);
      }
      setImporter("done", Math.min(rows.length, (i + 1) * batch));
    }
    await api().commit(session);
    notify(`Importadas ${rows.length.toLocaleString()} filas en ${importer.obj?.name}`, "success");
    gib("saved");
    setImporter({ open: false, running: false });
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
  else setImporter("open", false);
}
