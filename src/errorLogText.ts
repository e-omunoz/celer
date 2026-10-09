// An entry of the local error log (src-tauri/src/errlog.rs) and its plain-text form (copy, report attachment).

export interface ErrorEntry {
  /** Milliseconds since 1970. */
  at: number;
  version: string;
  /** panic, driver:postgres, driver:informix-drda, ui, ipc:<command>… */
  area: string;
  message: string;
  stack: string;
}

/** "2026-10-09T08:30:00Z" (UTC, to the second). */
export function entryTime(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The entries as text: a header line (time · version · area), the message, the stack indented. */
export function entriesText(entries: ErrorEntry[]): string {
  return entries
    .map((e) => {
      const stack = e.stack.trim() ? `\n${e.stack.trim().split("\n").map((line) => `    ${line.trim()}`).join("\n")}` : "";
      return `${entryTime(e.at)} · ${e.version} · ${e.area}\n${e.message}${stack}`;
    })
    .join("\n\n");
}
