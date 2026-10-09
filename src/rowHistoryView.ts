// «Historial de la fila»: what the dialog shows, as pure functions (dev/rowhistory-check.ts tests them). The values
// come from the server's logs through src-tauri/src/rowhistory.rs; nothing here fills in a value that is not there.
import type { DbKind, RowHistory, RowHistoryEvent } from "./types";

const ENGINES: Record<DbKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  mssql: "SQL Server",
  sqlite: "SQLite",
  odbc: "ODBC",
  informix: "Informix",
};

/**
 * Why the row's history cannot be read on this connection (the menu entry is disabled with it), or null when it can
 * be tried. "auto" may end up on JDBC: the core says so if it does not. Mirrors `rowhistory::unavailable`.
 */
export function rowHistoryBlocked(kind: DbKind, informixMode: string): string | null {
  if (kind !== "informix") return `No disponible en ${ENGINES[kind]}`;
  if (informixMode === "jdbc" || informixMode === "auto") return null;
  if (informixMode === "sqli") return "No disponible por el Client SDK (ODBC): solo por JDBC";
  return "No disponible por DRDA: solo por JDBC";
}

export const OP_LABEL: Record<RowHistoryEvent["op"], string> = {
  insert: "Alta",
  update: "Modificación",
  delete: "Borrado",
  truncate: "Tabla vaciada (TRUNCATE)",
};

export interface ColumnChange {
  column: string;
  before: string | null;
  after: string | null;
  /** The value changed (or appeared, or went away) in this event. */
  changed: boolean;
}

/** Each column of an event with its value before and after; `all` false keeps only what changed. */
export function columnChanges(columns: string[], event: RowHistoryEvent, all: boolean): ColumnChange[] {
  const out: ColumnChange[] = [];
  columns.forEach((column, index) => {
    const before = event.before ? (event.before[index] ?? null) : null;
    const after = event.after ? (event.after[index] ?? null) : null;
    const changed = event.op === "update" ? !event.before || before !== after : event.op !== "truncate";
    if (all || changed) out.push({ column, before, after, changed });
  });
  return out;
}

/** A value as the dialog writes it: NULL apart from an empty text. */
export function valueText(value: string | null): string {
  return value === null ? "NULL" : value === "" ? "''" : value;
}

/** Local date and time of a Unix-seconds instant. */
export function timeText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "medium" });
}

/** Who made the change: the user name when known, and always the uid the log has. */
export function userText(event: RowHistoryEvent): string {
  if (event.uid === null) return "usuario desconocido";
  return event.user ? `${event.user} (uid ${event.uid})` : `uid ${event.uid}`;
}

/** The logs the history covers, in words. */
export function rangeText(range: NonNullable<RowHistory["range"]>): string {
  const logs = range.firstLog === range.currentLog ? `log ${range.firstLog}` : `logs ${range.firstLog} a ${range.currentLog}`;
  const filled = range.firstLogFilled ? `; el ${range.firstLog}, el más antiguo, se llenó el ${timeText(range.firstLogFilled)}` : "";
  return `Leído de los ${logs} que quedan en disco (posición ${range.fromLsn} a ${range.readUntil})${filled}. Lo anterior ya no está en los logs.`;
}

/** The text of an unavailable history: the engine reasons already say «No disponible…»; the rest get the prefix. */
export function unavailableText(reason: string): string {
  return reason.startsWith("No disponible") ? reason : `No se puede reconstruir: ${reason}`;
}

/** The key of the row in words: "id = 7, linea = 2". */
export function keyText(key: { column: string; value: string }[]): string {
  return key.map((part) => `${part.column} = ${part.value}`).join(", ");
}

/** Newest change first, as the dialog lists them. */
export function newestFirst(events: RowHistoryEvent[]): RowHistoryEvent[] {
  return [...events].reverse();
}
