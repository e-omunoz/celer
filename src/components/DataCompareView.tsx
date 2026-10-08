import { ArrowLeftRight, ExternalLink, FileCode2, LoaderCircle } from "lucide-solid";
import { Show } from "solid-js";
import { closeDataCompare, DATA_LIMIT, dataCompare, openDataSyncScript, swapDataCompare, tableTitle } from "../dataCompareRun";
import { kindOf } from "../state";
import { DataGrid } from "./Grid";
import { Dialog } from "./Modals";
import { isTauri } from "../api";
import { detachPanel, isPanelWindow } from "../windows";

/** The rows of two tables side by side: changed cells marked, rows only in the target struck, new ones at the end. */
export function DataCompareView() {
  const c = () => dataCompare.comparison;
  const changes = () => (c() ? c()!.counts.changed + c()!.counts.added + c()!.counts.gone : 0);
  return (
    <Dialog title="Comparar datos" wide class="schema-compare data-compare" onClose={closeDataCompare}>
      <div class="sc-sides">
        <div class="sc-side">
          <small>Origen (el modelo)</small>
          <b>{dataCompare.source ? tableTitle(dataCompare.source) : ""}</b>
        </div>
        <button type="button" class="icon-btn" title="Intercambiar origen y destino" disabled={dataCompare.loading} onClick={swapDataCompare}>
          <ArrowLeftRight size={15} />
        </button>
        <div class="sc-side">
          <small>Destino (lo que cambiaría)</small>
          <b>{dataCompare.target ? tableTitle(dataCompare.target) : ""}</b>
        </div>
        <Show when={isTauri() && !isPanelWindow()}>
          <button type="button" class="icon-btn sc-detach" title="Abrir la comparación en su propia ventana" onClick={() => void detachPanel("data-compare")}>
            <ExternalLink size={14} />
          </button>
        </Show>
      </div>
      <Show when={!dataCompare.loading} fallback={
        <div class="export-progress sc-progress">
          <LoaderCircle size={15} class="spin" />
          <span>Leyendo las filas de las dos tablas…</span>
        </div>
      }>
        <Show when={!dataCompare.error} fallback={<p class="import-warn">{dataCompare.error}</p>}>
          <Show when={c()}>
            {(cmp) => (
              <>
                <div class="compare-head dc-head">
                  <span class="compare-chip equal">{cmp().counts.equal.toLocaleString()} iguales</span>
                  <span class="compare-chip changed">{cmp().counts.changed.toLocaleString()} cambiadas</span>
                  <span class="compare-chip added">{cmp().counts.added.toLocaleString()} solo en el origen</span>
                  <span class="compare-chip gone">{cmp().counts.gone.toLocaleString()} solo en el destino</span>
                  <span class="spacer" />
                  <span class="muted small">{cmp().key.length ? `Filas emparejadas por ${cmp().key.join(", ")}` : "Sin clave: se comparan filas enteras"}</span>
                </div>
                <Show when={dataCompare.truncated}>
                  <p class="compare-note">Una de las tablas tiene más de {DATA_LIMIT.toLocaleString()} filas: solo se comparan las primeras (por orden de clave).</p>
                </Show>
                <Show when={dataCompare.blocked && !dataCompare.truncated}>
                  <p class="compare-note">{dataCompare.blocked}</p>
                </Show>
                <Show when={cmp().onlyOld.length || cmp().onlyNew.length}>
                  <p class="compare-note">No se comparan las columnas que solo están en una de las dos: {[...cmp().onlyOld.map((n) => `${n} (destino)`), ...cmp().onlyNew.map((n) => `${n} (origen)`)].join(", ")}.</p>
                </Show>
                <div class="dc-grid">
                  <DataGrid
                    columns={cmp().columns}
                    rows={cmp().rows}
                    resetKey={`data-compare:${dataCompare.runId}`}
                    busyKey="data-compare"
                    dialect={kindOf(dataCompare.source?.connId)}
                    edits={cmp().changed}
                    editsAreBefore
                    deleted={cmp().gone}
                    insertStart={cmp().newFrom}
                  />
                </div>
              </>
            )}
          </Show>
        </Show>
      </Show>
      <footer>
        <span class="muted small">Cambiadas: el valor del origen (el del destino, al pasar el ratón). Tachadas: solo en el destino. Al final: solo en el origen.</span>
        <span class="spacer" />
        <button type="button" class="btn" onClick={closeDataCompare}>Cerrar</button>
        <button type="button" class="btn primary" disabled={dataCompare.loading || Boolean(dataCompare.error) || Boolean(dataCompare.blocked) || !changes()} title={dataCompare.blocked || undefined} onClick={openDataSyncScript}>
          <FileCode2 size={14} /> Script para igualar el destino
        </button>
      </footer>
    </Dialog>
  );
}
