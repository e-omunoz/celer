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
 * Why the row's history cannot be read on this engine (the menu entry is disabled with it), or null on Informix. The
 * protocol of an Informix connection (DRDA, Client SDK) is a precondition like the others: the dialog opens and the
 * core says it as «No se puede reconstruir: …» (`rowhistory::unavailable`).
 */
export function rowHistoryBlocked(kind: DbKind): string | null {
  return kind === "informix" ? null : `No disponible en ${ENGINES[kind]}`;
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

/** The transaction of a change, by where it committed in the log. */
export function txText(event: RowHistoryEvent): string {
  return `transacción del commit ${event.tx}`;
}

/** Who made the change: the user name when known, and always the uid the log has. */
export function userText(event: RowHistoryEvent): string {
  if (event.uid === null) return "usuario desconocido";
  return event.user ? `${event.user} (uid ${event.uid})` : `uid ${event.uid}`;
}

/**
 * The logs the history covers, in words. A read cut short says how far it got (or that it read nothing), never that it
 * covered the logs on disk.
 */
export function rangeText(range: NonNullable<RowHistory["range"]>, cutShort = false): string {
  const single = range.firstLog === range.currentLog;
  const filled = range.firstLogFilled ? `; el ${range.firstLog}, el más antiguo, se llenó el ${timeText(range.firstLogFilled)}` : "";
  const onDisk = single ? `el log ${range.firstLog}` : `los logs ${range.firstLog} a ${range.currentLog}`;
  if (cutShort && range.readUntil === range.fromLsn) {
    return `La lectura se detuvo antes de leer ningún registro (desde la posición ${range.fromLsn}). En disco quedan ${onDisk}${filled}.`;
  }
  if (cutShort) {
    return `La lectura se detuvo: se leyó de la posición ${range.fromLsn} a la ${range.readUntil}. En disco quedan ${onDisk}${filled}.`;
  }
  const logs = single ? `del log ${range.firstLog}` : `de los logs ${range.firstLog} a ${range.currentLog}`;
  const read = `(posición ${range.fromLsn} a ${range.readUntil})`;
  // Why the read starts there, as the core reports it (#217): older logs still on disk are never said to be gone.
  const several = range.oldestLog < range.firstLog - 1;
  const earlier = several ? `los logs ${range.oldestLog} a ${range.firstLog - 1} siguen` : `el log ${range.oldestLog} sigue`;
  const filledAt = range.firstLogFilled ? `; el ${range.firstLog} se llenó el ${timeText(range.firstLogFilled)}` : "";
  if (range.startReason === "createdAfter") {
    const after = range.createdAfterLog ?? range.firstLog - 1;
    return `Leído ${logs} ${read}${filledAt}. Empieza en el log ${range.firstLog} porque la tabla se creó después de llenarse el log ${after}: ${earlier} en disco, sin cambios suyos.`;
  }
  if (range.startReason === "creationReplayed") {
    const filledBefore = several ? "se llenaron" : "se llenó";
    return `Leído ${logs} ${read}${filledAt}. Empieza en el log ${range.firstLog} porque la recuperación rápida de Informix reescribió la hora de creación de la tabla: ${earlier} en disco, pero ${filledBefore} antes de esa hora.`;
  }
  return `Leído ${logs}${single ? "" : " que quedan en disco"} ${read}${filled}. Lo anterior ya no está en los logs.`;
}

/** What the dialog says when no change of the row was read. */
export function noEventsText(history: Pick<RowHistory, "cutShort" | "shownFrom">): string {
  if (history.cutShort) {
    return "No se leyó ningún cambio de esta fila antes de que la lectura se detuviera: eso no dice que no los tenga.";
  }
  // After fast recovery only the changes since the rewritten creation time are shown: none of them is not «no changes».
  if (history.shownFrom) {
    return `No se leyó ningún cambio de esta fila posterior al ${timeText(history.shownFrom)}; los anteriores no se muestran (ver arriba).`;
  }
  return "Sin cambios de esta fila en los logs leídos.";
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
