import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { sqlLiteral } from "./sql";
import { gib, kindOf, notify, reloadTable, state as appState } from "./state";
import type { ObjectRef, TableColumn } from "./types";

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

export interface ImportState {
  open: boolean;
  connId: string;
  obj: ObjectRef | null;
  qualified: string;
  columns: TableColumn[];
  quoted: string[];
  fileName: string;
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

export function parsed() {
  if (!importer.text) return { header: [] as string[], rows: [] as string[][] };
  const all = parseCsv(importer.text, importer.delimiter);
  if (!importer.hasHeader) return { header: (all[0] ?? []).map((_, index) => `columna ${index + 1}`), rows: all };
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
      setImporter({ open: true, connId, obj, qualified: info.qualified, columns, quoted, fileName: "", text: "", mapping: columns.map(() => -1), running: false, done: 0, total: 0 });
    } finally {
      void api().closeSession(opened.sessionId).catch(() => {});
    }
  } catch (err) {
    notify(errorText(err), "error");
  }
}

export async function pickImportFile() {
  const path = await api().pickOpenPath([{ name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] }]);
  if (!path) return;
  try {
    const text = await api().readTextFile(path);
    const delimiter = path.toLowerCase().endsWith(".tsv") ? "\t" : detectDelimiter(text);
    setImporter({ fileName: path.split(/[\\/]/).pop() ?? path, text, delimiter });
    remap();
  } catch (err) {
    notify(errorText(err), "error");
  }
}

export function remap() {
  setImporter("mapping", autoMap(parsed().header, importer.columns));
}

export function importSql(rows: string[][], dialect: string): string[] {
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
        return sqlLiteral(raw, item.col.kind, dialect);
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
