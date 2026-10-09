import { LoaderCircle } from "lucide-solid";
import { For, Show } from "solid-js";
import { isTauri } from "../api";
import { cancelExport, runExport, setState, state, type ExportFormat } from "../state";
import { Dialog } from "./Modals";

const FORMATS: [ExportFormat, string, string][] = [
  ["csv", "CSV", "Separado por comas"],
  ["tsv", "TSV", "Separado por tabuladores"],
  ["xlsx", "Excel", "Libro .xlsx"],
  ["json", "JSON", "Array de objetos"],
  ["sql", "SQL", "Sentencias INSERT"],
  ["markdown", "Markdown", "Tabla para docs"],
  ["html", "HTML", "Página con tabla"],
  ["xml", "XML", "Un elemento por fila"],
];

type Opts = typeof state.exportOpts;

export function ExportDialog() {
  const opts = () => state.exportOpts;
  const setOpt = <K extends keyof Opts>(key: K, value: Opts[K]) => setState("exportOpts", key, value as never);
  const format = () => state.exportFormat;
  return (
    <Dialog title={`Exportar ${state.exportSource?.label ?? "datos"}`} class="export-dialog" onClose={() => !state.exportRunning && setState("exportOpen", false)}>
      <p class="dialog-lead">
        Las filas se leen del servidor y se escriben en streaming: no se cargan en memoria, aunque sean millones.
        <Show when={state.exportSource?.columnOrder}> Las columnas salen en el orden en que las tienes en la rejilla.</Show>
      </p>
      <div class="format-grid">
        <For each={FORMATS}>
          {([id, label, hint]) => (
            <button type="button" class="format-card" classList={{ on: format() === id }} disabled={state.exportRunning || (id === "xlsx" && !isTauri())} onClick={() => setState("exportFormat", id)}>
              <b>{label}</b>
              <small>{hint}</small>
            </button>
          )}
        </For>
      </div>
      <div class="export-options">
        <Show when={format() === "csv"}>
          <div class="field">
            <span>Separador</span>
            <div class="seg">
              <For each={[[",", "Coma"], [";", "Punto y coma"], ["|", "Barra"]] as const}>
                {([value, label]) => (
                  <button type="button" classList={{ on: opts().delimiter === value }} onClick={() => setOpt("delimiter", value)}>
                    {label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={format() === "sql"}>
          <div class="form-row">
            <label class="field grow">
              <span>Tabla de destino</span>
              <input value={opts().tableName} spellcheck={false} onInput={(event) => setOpt("tableName", event.currentTarget.value)} />
            </label>
            <label class="field" style={{ width: "160px" }}>
              <span>Filas por INSERT</span>
              <select value={String(opts().sqlBatch)} onChange={(event) => setOpt("sqlBatch", Number(event.currentTarget.value))}>
                <For each={[1, 50, 100, 500, 1000]}>{(n) => <option value={n}>{n === 1 ? "1 (una por fila)" : n}</option>}</For>
              </select>
            </label>
          </div>
        </Show>
        <Show when={format() === "csv" || format() === "tsv" || format() === "markdown"}>
          <label class="field">
            <span>Texto para NULL</span>
            <input value={opts().nullText} placeholder="(vacío)" onInput={(event) => setOpt("nullText", event.currentTarget.value)} />
          </label>
        </Show>
        <Show when={format() === "csv" || format() === "tsv"}>
          <div class="checks">
            <label class="check">
              <input type="checkbox" checked={opts().header} onChange={(event) => setOpt("header", event.currentTarget.checked)} /> Fila de cabecera
            </label>
            <label class="check">
              <input type="checkbox" checked={opts().bom} onChange={(event) => setOpt("bom", event.currentTarget.checked)} /> BOM UTF-8 (para abrir en Excel)
            </label>
          </div>
        </Show>
      </div>
      <Show when={!isTauri()}>
        <label class="field">
          <span>Nombre del fichero</span>
          <input value={state.exportPath} placeholder={`export.${format() === "markdown" ? "md" : format()}`} onInput={(event) => setState("exportPath", event.currentTarget.value)} />
        </label>
      </Show>
      <details class="export-sql">
        <summary>Consulta que se exportará</summary>
        <pre>{state.exportSource?.sql}</pre>
      </details>
      <Show when={state.exportRunning}>
        <div class="export-progress">
          <LoaderCircle size={15} class="spin" />
          <span>
            Exportando… <b>{state.exportRows.toLocaleString()}</b> filas
          </span>
          <span class="spacer" />
          <button type="button" class="btn tiny" onClick={() => void cancelExport()}>Detener</button>
        </div>
      </Show>
      <footer>
        <button type="button" class="btn" disabled={state.exportRunning} onClick={() => setState("exportOpen", false)}>Cancelar</button>
        <button type="button" class="btn primary" disabled={state.exportRunning} onClick={() => void runExport()}>{isTauri() ? "Elegir destino y exportar" : "Exportar"}</button>
      </footer>
    </Dialog>
  );
}
