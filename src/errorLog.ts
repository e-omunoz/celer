// Ayuda › Registro de errores: the window's side of the local error log (src-tauri/src/errlog.rs). Unhandled errors
// of the interface and failed calls to the core are written there (the core scrubs them); the viewer lists, copies and
// clears it. Nothing is sent anywhere.
import { createStore } from "solid-js/store";
import { api, errorText, isTauri, onFailedCall } from "./api";
import { entriesText, type ErrorEntry } from "./errorLogText";
import { copyText, notify, revealPath } from "./state";

export const [errorLog, setErrorLog] = createStore({
  open: false,
  loading: false,
  entries: [] as ErrorEntry[],
});

/** Entries the viewer shows (the file keeps more until it rotates). */
const SHOWN = 300;

/** The same error again within this time is written once (a failing render loop would fill the log). */
const REPEAT_MS = 5000;
const recent = new Map<string, number>();

/** Writes an entry to the local log; never throws. */
export function logError(area: string, message: string, stack = "") {
  const key = `${area}\u0000${message}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - REPEAT_MS) return;
  recent.set(key, now);
  if (recent.size > 200) recent.clear();
  void api()
    .errorLogAdd(area, message, stack)
    .catch(() => {});
}

/** Errors the browser raises that are not failures (a resize observer catching up), never logged. */
const BENIGN = [/ResizeObserver loop/i, /^Script error\.?$/];

let lastNotice = 0;
/** What to do after an unexpected error (the report window sets it: «Reportar…»). */
let afterUnexpected: { label: string; run: () => void } | null = null;
export function onUnexpectedError(action: { label: string; run: () => void }) {
  afterUnexpected = action;
}

function unexpected(message: string, stack: string) {
  if (BENIGN.some((re) => re.test(message))) return;
  logError("ui", message, stack);
  // One notice at most every 30 s: the log has every occurrence.
  if (Date.now() - lastNotice < 30_000) return;
  lastNotice = Date.now();
  notify("Algo ha fallado en Celer", "error", "Queda anotado en Ayuda › Registro de errores, solo en este equipo.", afterUnexpected ?? { label: "Ver registro", run: () => void openErrorLog() });
}

/** Unhandled errors and rejections of this window, and failed calls to the core, go to the log. */
export function installErrorCapture() {
  window.addEventListener("error", (event) => {
    const err = event.error as Error | undefined;
    unexpected(err?.message || event.message || "Error", err?.stack ?? (event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : ""));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as unknown;
    unexpected(reason instanceof Error ? reason.message : errorText(reason), reason instanceof Error ? (reason.stack ?? "") : "");
  });
  onFailedCall((cmd, err) => logError(`ipc:${cmd}`, errorText(err)));
}

export async function openErrorLog() {
  setErrorLog("open", true);
  await refreshErrorLog();
}

export async function refreshErrorLog() {
  setErrorLog("loading", true);
  try {
    setErrorLog("entries", await api().errorLogList(SHOWN));
  } catch (err) {
    notify("No se pudo leer el registro de errores", "error", errorText(err));
  } finally {
    setErrorLog("loading", false);
  }
}

/** The newest `n` entries (for the report window's «adjuntar últimos errores»). */
export async function latestErrors(n: number): Promise<ErrorEntry[]> {
  return api()
    .errorLogList(n)
    .catch(() => []);
}

export async function copyErrorLog() {
  await copyText(entriesText(errorLog.entries), `Copiadas ${errorLog.entries.length} ${errorLog.entries.length === 1 ? "entrada" : "entradas"}`);
}

export async function clearErrorLog() {
  try {
    await api().errorLogClear();
    setErrorLog("entries", []);
    notify("Registro de errores vaciado", "success");
  } catch (err) {
    notify("No se pudo vaciar el registro", "error", errorText(err));
  }
}

export async function revealErrorLog() {
  if (!isTauri()) {
    notify("En el navegador el registro se guarda en el almacenamiento de la página", "info");
    return;
  }
  try {
    await revealPath(await api().errorLogPath());
  } catch (err) {
    notify("No se pudo abrir la carpeta", "error", errorText(err));
  }
}
