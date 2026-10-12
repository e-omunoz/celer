import { Copy, FolderOpen, RefreshCw, Trash2 } from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import { clearErrorLog, copyErrorLog, errorLog, refreshErrorLog, revealErrorLog, setErrorLog } from "../errorLog";
import { openReport } from "../reportStore";
import { entryTime } from "../errorLogText";
import { confirmDialog } from "../state";
import { Dialog } from "./Modals";

/** Friendly names of the log's areas. */
function areaLabel(area: string): string {
  if (area === "panic") return "Núcleo (pánico)";
  if (area === "ui") return "Interfaz";
  if (area.startsWith("ipc:")) return `Llamada ${area.slice(4)}`;
  if (area.startsWith("driver:")) return `Driver ${area.slice(7)}`;
  return area;
}

/** Ayuda › Registro de errores: the local log, newest first, with copy, open folder and clear. */
export function ErrorLogView() {
  const [openStack, setOpenStack] = createSignal<number | null>(null);
  const close = () => setErrorLog("open", false);
  const clear = async () => {
    if (await confirmDialog("Vaciar el registro de errores", "Se borran todas las entradas del registro de este equipo.", "Vaciar", true)) await clearErrorLog();
  };
  return (
    <Dialog title="Registro de errores" wide class="errorlog" onClose={close}>
      <p class="dialog-lead">
        Lo que ha fallado en Celer en este equipo: errores de los drivers, de la interfaz y del núcleo. Antes de guardarse se les quita el SQL, los valores,
        las contraseñas, las cadenas de conexión, los servidores y las rutas con tu usuario. No se envía nada a ningún sitio.
      </p>
      <div class="errorlog-bar">
        <button type="button" class="btn tiny" onClick={() => void refreshErrorLog()} disabled={errorLog.loading}><RefreshCw size={12} /> Actualizar</button>
        <button type="button" class="btn tiny" onClick={() => void copyErrorLog()} disabled={!errorLog.entries.length}><Copy size={12} /> Copiar</button>
        <button type="button" class="btn tiny" onClick={() => void revealErrorLog()}><FolderOpen size={12} /> Abrir carpeta</button>
        <span class="spacer" />
        <button type="button" class="btn tiny" title="Prepara un reporte con los últimos errores; ves lo que se envía antes" onClick={() => { close(); void openReport("bug", { attachErrors: true }); }} disabled={!errorLog.entries.length}>Reportar…</button>
        <button type="button" class="btn tiny" onClick={() => void clear()} disabled={!errorLog.entries.length}><Trash2 size={12} /> Vaciar</button>
      </div>
      <div class="errorlog-list" role="list">
        <For each={errorLog.entries} fallback={<p class="settings-note errorlog-empty">{errorLog.loading ? "Leyendo…" : "Sin errores anotados."}</p>}>
          {(entry, index) => (
            <div class="errorlog-entry" role="listitem">
              <div class="errorlog-head">
                <span class="errorlog-area" classList={{ panic: entry.area === "panic" }}>{areaLabel(entry.area)}</span>
                <span class="muted small" title={entryTime(entry.at)}>{new Date(entry.at).toLocaleString()}</span>
                <span class="muted small">v{entry.version}</span>
                <span class="spacer" />
                <Show when={entry.stack}>
                  <button type="button" class="link small" onClick={() => setOpenStack(openStack() === index() ? null : index())}>
                    {openStack() === index() ? "Ocultar pila" : "Ver pila"}
                  </button>
                </Show>
              </div>
              <pre class="errorlog-message">{entry.message}</pre>
              <Show when={openStack() === index()}>
                <pre class="errorlog-stack">{entry.stack}</pre>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}
