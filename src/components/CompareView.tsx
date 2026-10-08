import { GitCompare, X } from "lucide-solid";
import { createMemo, For, Show } from "solid-js";
import { compareResults } from "../compare";
import { closeCompare, currentResultOf, kindOf, setCompareKey, type SqlTab } from "../state";
import { DataGrid } from "./Grid";

/**
 * A pinned result next to the current one: rows matched by a key (guessed, or chosen), changed cells marked,
 * rows that are gone struck through and new rows at the end.
 */
export function CompareView(props: { tab: SqlTab }) {
  const pin = () => props.tab.pinned.find((p) => p.id === props.tab.compare?.pinId);
  const current = () => currentResultOf(props.tab);
  const comparison = createMemo(() => {
    const a = pin()?.result;
    const b = current();
    if (!a || !b) return null;
    return compareResults(a, b, props.tab.compare?.key ?? undefined);
  });
  const shared = () => (current()?.columns ?? []).map((c) => c.name).filter((name) => pin()?.result.columns.some((c) => c.name === name));

  return (
    <div class="compare-view">
      <div class="compare-head">
        <GitCompare size={15} />
        <b>{pin()?.title ?? "Fijado"}</b>
        <span class="muted">frente al resultado actual</span>
        <Show when={comparison()}>
          {(c) => (
            <>
              <span class="compare-chip equal">{c().counts.equal.toLocaleString()} iguales</span>
              <span class="compare-chip changed">{c().counts.changed.toLocaleString()} cambiadas</span>
              <span class="compare-chip added">{c().counts.added.toLocaleString()} nuevas</span>
              <span class="compare-chip gone">{c().counts.gone.toLocaleString()} desaparecidas</span>
            </>
          )}
        </Show>
        <span class="spacer" />
        <label class="compare-key" title="Columnas que identifican cada fila en los dos resultados">
          Clave
          <select
            value={props.tab.compare?.key === null ? "" : (props.tab.compare?.key ?? []).join(",") || "*"}
            onChange={(event) => {
              const v = event.currentTarget.value;
              setCompareKey(props.tab.id, v === "" ? null : v === "*" ? [] : [v]);
            }}
          >
            <option value="">Automática{comparison()?.key.length ? ` (${comparison()!.key.join(", ")})` : " (fila entera)"}</option>
            <option value="*">Fila entera</option>
            <For each={shared()}>{(name) => <option value={name}>{name}</option>}</For>
          </select>
        </label>
        <button type="button" class="icon-btn" title="Cerrar la comparación" onClick={() => closeCompare(props.tab.id)}><X size={15} /></button>
      </div>
      <Show when={comparison()?.onlyOld.length || comparison()?.onlyNew.length}>
        <p class="compare-note">
          No se comparan las columnas que solo están en uno de los dos:{" "}
          {[...(comparison()?.onlyOld ?? []).map((n) => `${n} (fijado)`), ...(comparison()?.onlyNew ?? []).map((n) => `${n} (actual)`)].join(", ")}.
        </p>
      </Show>
      <Show when={comparison()} fallback={<p class="muted compare-note">No hay un resultado actual con filas para comparar.</p>}>
        {(c) => (
          <DataGrid
            columns={c().columns}
            rows={c().rows}
            resetKey={`compare:${props.tab.compare?.pinId}:${props.tab.runId}:${(props.tab.compare?.key ?? ["auto"]).join(",")}`}
            busyKey={props.tab.id}
            dialect={kindOf(props.tab.connId)}
            edits={c().changed}
            deleted={c().gone}
            insertStart={c().newFrom}
          />
        )}
      </Show>
    </div>
  );
}
