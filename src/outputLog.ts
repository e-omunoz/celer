// A SQL console's «Salida» log: kept oldest first (as it is saved with the session), shown newest first so that the
// run you just made is the top line.

export interface OutputEntry {
  at: number;
  sql: string;
  ok: boolean;
  text: string;
  elapsedMs: number | null;
}

/** How many entries a console keeps; the oldest go first. */
export const OUTPUT_CAP = 200;

/** The log with `entry` added as the newest, capped to the last OUTPUT_CAP entries. */
export function appendOutput(log: readonly OutputEntry[], entry: OutputEntry): OutputEntry[] {
  return [...log.slice(-(OUTPUT_CAP - 1)), entry];
}

export interface OutputRow {
  entry: OutputEntry;
  /** The newest entry (the top line). */
  latest: boolean;
  /** «✦ Corregir con IA» goes on it: the newest entry, when it is an error. */
  fixable: boolean;
}

/** The log as shown: newest first, the top one marked as the latest. */
export function outputRows(log: readonly OutputEntry[]): OutputRow[] {
  const rows: OutputRow[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const latest = i === log.length - 1;
    rows.push({ entry: log[i], latest, fixable: latest && !log[i].ok });
  }
  return rows;
}

/** «Copiar todo»: every entry in the order shown (newest first), time, SQL and what it said. */
export function outputText(log: readonly OutputEntry[], time: (at: number) => string = (at) => new Date(at).toLocaleTimeString()): string {
  return outputRows(log)
    .map(({ entry }) => `[${time(entry.at)}] ${entry.ok ? "" : "ERROR "}${entry.sql.trim()}\n${entry.text}`)
    .join("\n\n");
}
