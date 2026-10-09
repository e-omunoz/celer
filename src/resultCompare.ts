// Comparing query results (#119): what a ResultRef points at (a console's result, a pinned one, a table tab's rows),
// the results that can be picked in «Comparar con…», the primary key of the table a side reads, and the export of
// the differences. The comparison itself is compare.ts (the same engine as «Comparar datos» of two tables).
import { api, errorText, isTauri } from "./api";
import { columnIndex, comparisonTable, keyFits, singleTableOf, type Comparison } from "./compare";
import { connectionById, kindOf, notify, openComparison, openMenu, patchCompare, shownResultRef, state, type ResultRef, type SqlTab, type TableTab } from "./state";
import { exportStatement, resultToText } from "./sql";
import { raw } from "./raw";
import type { Cell, ResultSet } from "./types";

/** Rows compared on each side at most: more loaded rows than this are left out (and the view says so). */
export const COMPARE_LIMIT = 200_000;

export interface ResolvedSide {
  ref: ResultRef;
  /** Short name: «Resultado 2», «Fijado 1», the table's name. */
  title: string;
  /** Where it is: the console or table tab and its connection. */
  place: string;
  result: ResultSet;
  connId: string | null;
  /** Rows not loaded yet that «Cargar todo» brings (a console's result or a table tab with more pages). */
  more: boolean;
  /** A pinned result made before every page was loaded: it stays with what it had. */
  partial: boolean;
  /** The console or table tab it lives in, to load the rest of its rows. */
  tabId: string;
  /** Rows beyond COMPARE_LIMIT were left out. */
  capped: boolean;
  /** The rows behind it (all of them, plain) and how many there are: what tells whether it changed. */
  source: Cell[][];
  loaded: number;
}

const placeOf = (tab: SqlTab | TableTab) => {
  const conn = connectionById(tab.connId)?.name;
  return conn && conn !== tab.title ? `${tab.title} · ${conn}` : tab.title;
};

/** Number of a console's result among those with rows («Resultado 2»), as the result tabs call it. */
function resultTitle(tab: SqlTab, index: number) {
  return `Resultado ${tab.results.filter((r, i) => r.columns.length && i <= index).length}`;
}

/** The plain rows (not the store's proxies: 200k rows are compared), at most COMPARE_LIMIT of them. */
const capped = (result: ResultSet): [ResultSet, boolean] => {
  const rows = raw(result.rows);
  const columns = raw(result.columns);
  return rows.length > COMPARE_LIMIT ? [{ ...result, columns, rows: rows.slice(0, COMPARE_LIMIT) }, true] : [{ ...result, columns, rows }, false];
};

/** Whether two resolutions of a side hold the same data (the comparison is not worked out again for nothing). */
export function sameSide(a: ResolvedSide | null, b: ResolvedSide | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.title === b.title &&
    a.place === b.place &&
    a.more === b.more &&
    a.result.columns === b.result.columns &&
    a.source === b.source &&
    a.loaded === b.loaded
  );
}

/** What `ref` points at now, or null when it is gone (its tab closed, the pinned result removed, no rows yet). */
export function resolveRef(ref: ResultRef): ResolvedSide | null {
  const tab = state.tabs.find((item) => item.id === ref.tabId);
  if (!tab) return null;
  const side = (title: string, found: ResultSet, more: boolean, partial: boolean): ResolvedSide => {
    const [result, cut] = capped(found);
    return { ref, title, place: placeOf(tab), result, connId: tab.connId, more, partial, tabId: tab.id, capped: cut, source: raw(found.rows), loaded: found.rows.length };
  };
  if (ref.kind === "table") {
    if (tab.kind !== "table" || !tab.gridCols.length) return null;
    return side(tab.obj.name, { columns: tab.gridCols, rows: tab.rows, hasMore: tab.hasMore, rowsAffected: null }, tab.hasMore, false);
  }
  if (tab.kind !== "sql") return null;
  if (ref.kind === "pin") {
    const pin = tab.pinned.find((item) => item.id === ref.pinId);
    return pin ? side(pin.title, pin.result, false, Boolean(pin.partial)) : null;
  }
  const index = ref.index >= 0 ? ref.index : tab.activeResult >= 0 && tab.results[tab.activeResult]?.columns.length ? tab.activeResult : tab.results.findIndex((r) => r.columns.length);
  const found = tab.results[index];
  if (!found?.columns.length) return null;
  return side(ref.index >= 0 ? resultTitle(tab, index) : "Resultado actual", found, found.hasMore, false);
}

export const sameRef = (a: ResultRef, b: ResultRef) => JSON.stringify(a) === JSON.stringify(b);

export interface Candidate {
  ref: ResultRef;
  label: string;
  hint: string;
}

/**
 * Every result of this window that can be compared with `except` (the one on show): the results and pinned ones of
 * each console (this one first) and the rows each table tab has loaded.
 */
export function compareCandidates(except: ResultRef | null, firstTabId: string): { group: string; items: Candidate[] }[] {
  const tabs = [...state.tabs].sort((a, b) => (a.id === firstTabId ? -1 : b.id === firstTabId ? 1 : 0));
  const groups: { group: string; items: Candidate[] }[] = [];
  const rows = (n: number, more: boolean) => `${n.toLocaleString()}${more ? "+" : ""} ${n === 1 && !more ? "fila" : "filas"}`;
  for (const tab of tabs) {
    const items: Candidate[] = [];
    if (tab.kind === "sql") {
      tab.results.forEach((result, index) => {
        if (!result.columns.length) return;
        items.push({ ref: { kind: "result", tabId: tab.id, index }, label: resultTitle(tab, index), hint: rows(result.rows.length, result.hasMore) });
      });
      for (const pin of tab.pinned) items.push({ ref: { kind: "pin", tabId: tab.id, pinId: pin.id }, label: pin.title, hint: rows(pin.result.rows.length, false) });
    } else if (tab.gridCols.length) {
      items.push({ ref: { kind: "table", tabId: tab.id }, label: `Filas de ${tab.obj.name}`, hint: rows(tab.rows.length, tab.hasMore) });
    }
    const kept = items.filter((item) => !except || !sameRef(item.ref, except));
    if (kept.length) groups.push({ group: `${tab.id === firstTabId ? "Esta consola" : placeOf(tab)}${tab.id === firstTabId ? "" : ` (${connectionById(tab.connId)?.kind ?? "sin conexión"})`}`, items: kept });
  }
  return groups;
}

/**
 * «Comparar con…»: the result console `tabId` has on show (B) against one picked from the menu (A): another result
 * or pinned one of this console, of another console (another connection too) or the rows of a table tab.
 */
export function pickComparison(tabId: string, event?: MouseEvent) {
  const tab = state.tabs.find((item) => item.id === tabId);
  const shown = tab?.kind === "sql" ? shownResultRef(tab) : null;
  if (!shown) {
    notify("No hay un resultado con filas para comparar", "info", "Ejecuta una consulta y compara su resultado con otro.");
    return;
  }
  const groups = compareCandidates(shown, tabId);
  if (!groups.length) {
    notify("No hay otro resultado con el que comparar", "info", "Fija este resultado y vuelve a ejecutar, ejecuta otra consulta (en esta consola u otra) o abre una tabla.");
    return;
  }
  // From the palette there is no click: the menu opens in the middle of the window.
  const at = event ?? new MouseEvent("click", { clientX: Math.round(window.innerWidth / 2 - 140), clientY: Math.round(window.innerHeight / 3) });
  openMenu(
    at,
    groups.flatMap((group, index) => [
      ...(index ? [{ separator: true }] : []),
      { label: group.group, disabled: true },
      ...group.items.map((item) => ({ label: item.label, hint: item.hint, run: () => openComparison(tabId, item.ref, shown) })),
    ]),
  );
}

/** The SQL behind a console's result (the statement of a script that produced it), or a pinned result's. */
function sqlOf(ref: ResultRef): string | null {
  const tab = state.tabs.find((item) => item.id === ref.tabId);
  if (tab?.kind !== "sql") return null;
  if (ref.kind === "pin") return tab.pinned.find((pin) => pin.id === ref.pinId)?.sql ?? null;
  if (ref.kind !== "result") return null;
  const grids = tab.results.filter((r) => r.columns.length);
  const index = ref.index >= 0 ? ref.index : tab.activeResult;
  const result = tab.results[index];
  const source = tab.resultsSql || tab.lastSql;
  return exportStatement(source, kindOf(tab.connId), result ? grids.indexOf(result) : 0, grids.length) ?? source;
}

/** The primary key of the table a side reads: a table tab's, or that of a plain single-table SELECT. */
async function primaryKeyOf(ref: ResultRef): Promise<string[]> {
  const tab = state.tabs.find((item) => item.id === ref.tabId);
  if (!tab) return [];
  if (tab.kind === "table") return tab.columnsMeta.filter((col) => col.primaryKey).map((col) => col.name);
  const sql = sqlOf(ref);
  const table = sql ? singleTableOf(sql) : null;
  if (!table || !tab.sessionId || tab.running) return [];
  // The schema as the explorer knows it when the query did not name one.
  const known = tab.completion?.tables.find((t) => t.name.toLowerCase() === table.name.toLowerCase() && (!table.schema || t.schema.toLowerCase() === table.schema.toLowerCase()));
  const schema = known?.schema ?? table.schema;
  // Unknown schema: the engine's default one is tried too (SQL Server needs it named; others take "" as the current).
  const schemas = schema ? [schema] : kindOf(tab.connId) === "mssql" ? ["", "dbo"] : [""];
  for (const candidate of schemas) {
    try {
      const columns = await api().tableColumns(tab.sessionId, { database: tab.database || "", schema: candidate, name: known?.name ?? table.name, kind: "table" });
      if (columns.length) return columns.filter((col) => col.primaryKey).map((col) => col.name);
    } catch {
      /* not this one */
    }
  }
  return [];
}

/**
 * Looks for a primary key to match the rows by (the first side's table, else the second's) and keeps it in the
 * comparison when both results have its columns; the view uses it while the key is automatic.
 */
export async function detectCompareKey(tabId: string) {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (tab?.kind !== "sql" || !tab.compare) return;
  const { base, other } = tab.compare;
  const a = resolveRef(base);
  const b = resolveRef(other);
  if (!a || !b) return;
  for (const ref of [base, other]) {
    const pk = await primaryKeyOf(ref).catch(() => []);
    const now = state.tabs.find((item) => item.id === tabId);
    // The comparison changed meanwhile (other sides, or closed): this answer is not for it.
    if (now?.kind !== "sql" || !now.compare || !sameRef(now.compare.base, base) || !sameRef(now.compare.other, other)) return;
    if (pk.length && keyFits(a.result, b.result, pk)) {
      patchCompare(tabId, { pk: pk.map((name) => b.result.columns[columnIndex(b.result.columns, name)]?.name ?? name) });
      return;
    }
  }
}

/** Writes the comparison on show (all rows, or only the differences) as CSV or JSON. */
export async function exportComparison(c: Comparison, labels: { before: string; after: string }, format: "csv" | "json") {
  const table = comparisonTable(c, labels);
  const text = resultToText(table, format, "diferencias");
  const name = `diferencias.${format}`;
  try {
    const path = isTauri() ? await api().pickSavePath([{ name: format === "csv" ? "CSV" : "JSON", extensions: [format] }], name) : name;
    if (!path) return;
    await api().writeTextFile(path, format === "csv" ? `﻿${text}` : text);
    notify(`Comparación exportada · ${table.rows.length.toLocaleString()} filas`, "success", isTauri() ? path : undefined);
  } catch (err) {
    notify("No se pudo exportar la comparación", "error", errorText(err));
  }
}
