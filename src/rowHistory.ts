// «Historial de la fila» (Informix): the dialog's state and the read through the core (src-tauri/src/rowhistory.rs).
import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { cellText } from "./sql";
import { connectionById, state as appState } from "./state";
import { rowHistoryBlocked } from "./rowHistoryView";
import type { RowHistory, RowHistoryRequest } from "./types";
import type { TableTab } from "./state";

export interface RowHistoryState {
  open: boolean;
  connId: string;
  title: string;
  request: RowHistoryRequest | null;
  loading: boolean;
  /** The read failed (connection, driver…): the message. */
  error: string;
  result: RowHistory | null;
  /** The running read, for `cancel`. */
  historyId: string;
  /** Every column of each change, not only the ones that changed. */
  allColumns: boolean;
}

export const [rowHistory, setRowHistory] = createStore<RowHistoryState>({
  open: false,
  connId: "",
  title: "",
  request: null,
  loading: false,
  error: "",
  result: null,
  historyId: "",
  allColumns: false,
});

/** Why a table tab's rows have no history (engine or protocol), or null. */
export function tableHistoryBlocked(tab: TableTab): string | null {
  const conn = connectionById(tab.connId);
  if (!conn) return "Conexión no encontrada";
  const blocked = rowHistoryBlocked(conn.kind, conn.informixMode);
  if (blocked) return blocked;
  const pk = tab.columnsMeta.filter((col) => col.primaryKey);
  if (!pk.length) return "La tabla no tiene clave primaria";
  if (pk.some((col) => !tab.gridCols.some((shown) => shown.name.toLowerCase() === col.name.toLowerCase()))) return "La clave primaria no está entre las columnas cargadas";
  return null;
}

/**
 * A query result's rows: the engine's reason, or, on Informix, that the history is read from the table's own view (a
 * query result does not say which table row each line is).
 */
export function resultHistoryBlocked(connId: string | null | undefined): string {
  const conn = connectionById(connId);
  if (!conn) return "Sin conexión";
  return rowHistoryBlocked(conn.kind, conn.informixMode) ?? "Ábrelo desde la tabla: un resultado de consulta no dice de qué fila sale cada línea";
}

/**
 * Opens the history of a row of a table tab (`source`: its index in the loaded rows). The key is taken from the row
 * as it is in the database (not a pending edit); a new row has no history yet.
 */
export function openRowHistory(tab: TableTab, source: number) {
  const row = tab.rows[source];
  if (!row) return;
  const at = (name: string) => tab.gridCols.findIndex((col) => col.name.toLowerCase() === name.toLowerCase());
  const pk = tab.columnsMeta.filter((col) => col.primaryKey);
  if (pk.some((col) => at(col.name) < 0)) return;
  const key = pk.map((col) => ({ column: col.name, value: cellText(row[at(col.name)] ?? null) }));
  const request: RowHistoryRequest = { database: tab.obj.database || tab.database, owner: tab.obj.schema, table: tab.obj.name, key, enableFullRowLogging: false };
  setRowHistory({ open: true, connId: tab.connId, title: tab.obj.name, request, result: null, error: "", allColumns: false });
  void loadRowHistory(false);
}

/** Reads the history; `enable`: the user agreed to turn on full row logging for the read. */
export async function loadRowHistory(enable: boolean) {
  const request = rowHistory.request;
  if (!request) return;
  const historyId = `row-history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setRowHistory({ loading: true, error: "", result: null, historyId, request: { ...request, enableFullRowLogging: enable } });
  try {
    const result = await api().rowHistory(rowHistory.connId, appState.passwords[rowHistory.connId], historyId, { ...request, enableFullRowLogging: enable });
    if (rowHistory.historyId === historyId) setRowHistory({ result, loading: false });
  } catch (err) {
    if (rowHistory.historyId === historyId) setRowHistory({ error: errorText(err), loading: false });
  }
}

/** Stops a read in progress: the core ends it between two reads of the CDC session and shows what it had. */
export function cancelRowHistory() {
  if (rowHistory.loading && rowHistory.historyId) void api().cancel(rowHistory.historyId).catch(() => {});
}

export function closeRowHistory() {
  if (rowHistory.loading) {
    cancelRowHistory();
    // A late answer to a closed dialog is dropped.
    setRowHistory({ historyId: "" });
  }
  setRowHistory({ open: false, loading: false });
}
