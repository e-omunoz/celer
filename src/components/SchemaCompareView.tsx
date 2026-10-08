import { ArrowLeftRight, ArrowRight, ExternalLink, FileCode2, LoaderCircle } from "lucide-solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { compareCounts, type TableDiff } from "../schemaCompare";
import { closeSchemaCompare, openSyncScript, schemaCompare, schemaTitle, setSchemaCompare, swapCompare } from "../schemaCompareRun";
import { Dialog } from "./Modals";
import { isTauri } from "../api";
import { detachPanel, isPanelWindow } from "../windows";

type Filter = "all" | TableDiff["status"];

const STATUS: Record<TableDiff["status"], { label: string; short: string }> = {
  different: { label: "Diferentes", short: "≠" },
  "only-source": { label: "Solo en el origen", short: "+" },
  "only-target": { label: "Solo en el destino", short: "−" },
  same: { label: "Iguales", short: "=" },
};

const CHANGE: Record<string, string> = {
  "only-source": "Falta en el destino",
  "only-target": "Solo en el destino",
  type: "Otro tipo",
  nullable: "Otra nulabilidad",
};

/** Two schemas side by side: tables only on one side, columns that differ, and a script to align the target. */
export function SchemaCompareView() {
  const [filter, setFilter] = createSignal<Filter>("all");
  const counts = createMemo(() => compareCounts(schemaCompare.diffs));
  const shown = createMemo(() => schemaCompare.diffs.filter((d) => filter() === "all" || d.status === filter()));
  const selected = () => schemaCompare.diffs.find((d) => d.name === schemaCompare.selected) ?? null;
  const changes = () => counts().different + counts().onlySource + counts().onlyTarget;
  const count = (status: TableDiff["status"]) => ({ different: counts().different, "only-source": counts().onlySource, "only-target": counts().onlyTarget, same: counts().same })[status];

  return (
    <Dialog title="Comparar esquemas" wide class="schema-compare" onClose={closeSchemaCompare}>
      <div class="sc-sides">
        <div class="sc-side">
          <small>Origen (el modelo)</small>
          <b>{schemaCompare.source ? schemaTitle(schemaCompare.source) : ""}</b>
        </div>
        <button type="button" class="icon-btn" title="Intercambiar origen y destino" disabled={schemaCompare.loading} onClick={swapCompare}>
          <ArrowLeftRight size={15} />
        </button>
        <div class="sc-side">
          <small>Destino (lo que cambiaría)</small>
          <b>{schemaCompare.target ? schemaTitle(schemaCompare.target) : ""}</b>
        </div>
        <Show when={isTauri() && !isPanelWindow()}>
          <button type="button" class="icon-btn sc-detach" title="Abrir la comparación en su propia ventana" onClick={() => void detachPanel("schema-compare")}>
            <ExternalLink size={14} />
          </button>
        </Show>
      </div>
      <Show when={!schemaCompare.loading} fallback={
        <div class="export-progress sc-progress">
          <LoaderCircle size={15} class="spin" />
          <span>Leyendo tablas y columnas… <b>{schemaCompare.done.toLocaleString()}</b>{schemaCompare.total ? ` de ${schemaCompare.total.toLocaleString()}` : ""}</span>
          <span class="spacer" />
          <div class="mini-progress"><i style={{ width: `${schemaCompare.total ? (schemaCompare.done / schemaCompare.total) * 100 : 4}%` }} /></div>
        </div>
      }>
        <Show when={!schemaCompare.error} fallback={<p class="import-warn">{schemaCompare.error}</p>}>
          <div class="sc-filters seg small">
            <button type="button" classList={{ on: filter() === "all" }} onClick={() => setFilter("all")}>Todas <small>{schemaCompare.diffs.length}</small></button>
            <For each={["different", "only-source", "only-target", "same"] as TableDiff["status"][]}>
              {(status) => (
                <button type="button" classList={{ on: filter() === status }} onClick={() => setFilter(status)}>
                  <i class={`sc-dot ${status}`} />
                  {STATUS[status].label} <small>{count(status)}</small>
                </button>
              )}
            </For>
          </div>
          <div class="sc-body">
            <div class="sc-list" role="listbox" aria-label="Tablas">
              <For each={shown()} fallback={<p class="inspector-empty">Nada en este grupo.</p>}>
                {(d) => (
                  <button type="button" role="option" aria-selected={schemaCompare.selected === d.name} class="sc-item" classList={{ on: schemaCompare.selected === d.name }} onClick={() => setSchemaCompare("selected", d.name)}>
                    <i class={`sc-dot ${d.status}`} title={STATUS[d.status].label} />
                    <span>{d.name}</span>
                    <Show when={d.status === "different"}><small>{d.columns.length}</small></Show>
                  </button>
                )}
              </For>
            </div>
            <div class="sc-detail">
              <Show when={selected()} fallback={<p class="inspector-empty">{changes() ? "Elige una tabla para ver sus diferencias." : "Los dos esquemas tienen la misma estructura."}</p>}>
                {(d) => (
                  <>
                    <h4>
                      <i class={`sc-dot ${d().status}`} /> {d().name}
                      <Show when={d().targetName}><span class="muted"> (en el destino: {d().targetName})</span></Show>
                    </h4>
                    <Show when={d().status === "only-source"}><p class="settings-note">El destino no tiene esta tabla: el script la crea con la definición del origen.</p></Show>
                    <Show when={d().status === "only-target"}><p class="settings-note">Solo existe en el destino. El script deja su DROP comentado: borrarla eliminaría sus datos.</p></Show>
                    <Show when={d().status === "same"}><p class="settings-note">Mismas columnas, tipos y nulabilidad.</p></Show>
                    <Show when={d().columns.length}>
                      <table class="sc-cols">
                        <thead><tr><th>Columna</th><th>Origen</th><th /><th>Destino</th><th>Cambio</th></tr></thead>
                        <tbody>
                          <For each={d().columns}>
                            {(c) => (
                              <tr class={c.change}>
                                <td><code>{c.name}</code></td>
                                <td>{c.source ? `${c.source.typeName}${c.source.nullable ? "" : " NOT NULL"}` : "—"}</td>
                                <td><ArrowRight size={12} /></td>
                                <td>{c.target ? `${c.target.typeName}${c.target.nullable ? "" : " NOT NULL"}` : "—"}</td>
                                <td>{CHANGE[c.change]}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </Show>
      <footer>
        <span class="muted small">Compara tablas, columnas, tipos y nulabilidad. No ejecuta nada: el script se abre en una consola del destino.</span>
        <span class="spacer" />
        <button type="button" class="btn" onClick={closeSchemaCompare}>Cerrar</button>
        <button type="button" class="btn primary" disabled={schemaCompare.loading || Boolean(schemaCompare.error) || !changes()} onClick={openSyncScript}>
          <FileCode2 size={14} /> Script para igualar el destino
        </button>
      </footer>
    </Dialog>
  );
}
