import { ArrowLeftRight, Download, ExternalLink, GitCompare, KeyRound, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { columnIndex, compareResults, guessKey, keyFits, onlyDifferences } from "../compare";
import { COMPARE_LIMIT, detectCompareKey, exportComparison, resolveRef, sameSide, type ResolvedSide } from "../resultCompare";
import { closeCompare, fetchAll, kindOf, openMenu, patchCompare, type SqlTab } from "../state";
import { DataGrid } from "./Grid";
import { isTauri } from "../api";
import { detachPanel, isPanelWindow } from "../windows";

/**
 * Two results side by side (#119): a pinned one and the current one, or any two picked with «Comparar con…» (this
 * console, another one, another connection, a table tab). Rows are matched by a key (the primary key when the side
 * is a table, else a unique column, or the columns chosen), changed cells are marked with the value in A on hover,
 * rows only in A are struck through and rows only in B come at the end.
 */
export function ResultCompare(props: { tab: SqlTab }) {
  const cmp = () => props.tab.compare;
  const sideA = createMemo<ResolvedSide | null>(() => (cmp() ? resolveRef(cmp()!.base) : null), null, { equals: sameSide });
  const sideB = createMemo<ResolvedSide | null>(() => (cmp() ? resolveRef(cmp()!.other) : null), null, { equals: sameSide });
  const shared = () => (sideB()?.result.columns ?? []).map((c) => c.name).filter((name) => sideA() && columnIndex(sideA()!.result.columns, name) >= 0);

  /** The key in use: the one chosen, else the primary key found (when both sides have it), else a unique column. */
  const autoKey = createMemo(() => {
    const a = sideA();
    const b = sideB();
    if (!a || !b) return [] as string[];
    const pk = cmp()?.pk;
    return pk && keyFits(a.result, b.result, pk) ? pk : guessKey(a.result, b.result);
  });
  const whole = createMemo(() => {
    const a = sideA();
    const b = sideB();
    if (!a || !b) return null;
    return compareResults(a.result, b.result, cmp()?.key ?? autoKey());
  });
  const shown = createMemo(() => {
    const c = whole();
    return c && cmp()?.onlyDiff ? onlyDifferences(c) : c;
  });

  // The primary key of either side's table, looked for once per pair of sides.
  createEffect(
    on(
      () => (cmp() ? JSON.stringify([cmp()!.base, cmp()!.other]) : ""),
      (pair) => {
        // In a window of its own the comparison is a copy: the window it came from looked for the key already.
        if (pair && !isPanelWindow()) void detectCompareKey(props.tab.id);
      },
    ),
  );

  const [keysOpen, setKeysOpen] = createSignal(false);
  let keysBox: HTMLDivElement | undefined;
  const outside = (event: MouseEvent) => keysBox && !keysBox.contains(event.target as Node) && setKeysOpen(false);
  window.addEventListener("mousedown", outside);
  onCleanup(() => window.removeEventListener("mousedown", outside));

  const keyLabel = () => {
    const key = cmp()?.key;
    if (key === null || key === undefined) {
      const auto = whole()?.key ?? [];
      return auto.length ? `${auto.join(", ")}${cmp()?.pk && auto.join() === cmp()!.pk!.join() ? " (clave primaria)" : " (automática)"}` : "fila entera (automática)";
    }
    return key.length ? key.join(", ") : "fila entera";
  };
  const toggleKey = (name: string) => {
    const current = cmp()?.key ?? whole()?.key ?? [];
    const next = current.includes(name) ? current.filter((k) => k !== name) : [...current, name];
    patchCompare(props.tab.id, { key: next });
  };
  const swap = () => {
    const c = cmp();
    if (c) patchCompare(props.tab.id, { base: c.other, other: c.base });
  };
  const labels = () => ({ before: sideA()?.title ?? "A", after: sideB()?.title ?? "B" });
  const exportMenu = (event: MouseEvent) => {
    const c = shown();
    if (!c) return;
    openMenu(event, [
      { label: `Exportar ${cmp()?.onlyDiff ? "las diferencias" : "la comparación"} a CSV…`, icon: "download", run: () => void exportComparison(c, labels(), "csv") },
      { label: `Exportar ${cmp()?.onlyDiff ? "las diferencias" : "la comparación"} a JSON…`, run: () => void exportComparison(c, labels(), "json") },
    ]);
  };

  /** What limits the comparison on one side: rows not loaded, a pinned result short of pages, the row cap. */
  const SideNote = (p: { side: ResolvedSide; name: string }) => (
    <>
      <Show when={p.side.more && !isPanelWindow()}>
        <p class="compare-note">
          {p.name} («{p.side.title}») tiene más filas sin cargar: se comparan las {p.side.loaded.toLocaleString()} cargadas.{" "}
          <button type="button" class="btn tiny" onClick={() => void fetchAll(p.side.tabId)}>Cargar todo</button>
        </p>
      </Show>
      <Show when={p.side.partial}>
        <p class="compare-note">{p.name} («{p.side.title}») se fijó con las {p.side.loaded.toLocaleString()} filas que había cargadas; las demás no están en él.</p>
      </Show>
      <Show when={p.side.capped}>
        <p class="compare-note">{p.name} («{p.side.title}») tiene {p.side.loaded.toLocaleString()} filas: se comparan las primeras {COMPARE_LIMIT.toLocaleString()}.</p>
      </Show>
    </>
  );

  return (
    <div class="compare-view">
      <div class="compare-head">
        <GitCompare size={15} />
        <span class="compare-side" title={sideA()?.place}><small>A</small><b>{sideA()?.title ?? "—"}</b><span class="muted">{sideA()?.place}</span></span>
        <button type="button" class="icon-btn" title="Intercambiar A y B" onClick={swap}><ArrowLeftRight size={14} /></button>
        <span class="compare-side" title={sideB()?.place}><small>B</small><b>{sideB()?.title ?? "—"}</b><span class="muted">{sideB()?.place}</span></span>
        <span class="spacer" />
        <Show when={isTauri() && !isPanelWindow()}>
          <button type="button" class="icon-btn" title="Abrir la comparación en su propia ventana" onClick={() => void detachPanel("compare")}><ExternalLink size={14} /></button>
        </Show>
        <button type="button" class="icon-btn" title="Cerrar la comparación" onClick={() => closeCompare(props.tab.id)}><X size={15} /></button>
      </div>
      <Show when={whole()}>
        {(c) => (
          <div class="compare-head compare-bar">
            <span class="compare-chip equal">{c().counts.equal.toLocaleString()} iguales</span>
            <span class="compare-chip changed">{c().counts.changed.toLocaleString()} cambiadas</span>
            <span class="compare-chip added" title={`Filas que solo están en B («${sideB()?.title}»)`}>{c().counts.added.toLocaleString()} solo en B</span>
            <span class="compare-chip gone" title={`Filas que solo están en A («${sideA()?.title}»)`}>{c().counts.gone.toLocaleString()} solo en A</span>
            <label class="check compare-only">
              <input type="checkbox" checked={Boolean(cmp()?.onlyDiff)} onChange={(event) => patchCompare(props.tab.id, { onlyDiff: event.currentTarget.checked })} /> Solo diferencias
            </label>
            <span class="spacer" />
            <div class="compare-keys" ref={keysBox}>
              <button type="button" class="btn tiny" title="Columnas que identifican cada fila en los dos resultados" onClick={() => setKeysOpen(!keysOpen())}>
                <KeyRound size={12} /> Clave: {keyLabel()}
              </button>
              <Show when={keysOpen()}>
                <div class="compare-keys-pop" role="dialog" aria-label="Columnas clave">
                  <button type="button" classList={{ on: cmp()?.key === null }} onClick={() => patchCompare(props.tab.id, { key: null })}>
                    Automática{cmp()?.pk?.length ? ` · clave primaria (${cmp()!.pk!.join(", ")})` : autoKey().length ? ` (${autoKey().join(", ")})` : " (fila entera)"}
                  </button>
                  <button type="button" classList={{ on: Array.isArray(cmp()?.key) && cmp()!.key!.length === 0 }} onClick={() => patchCompare(props.tab.id, { key: [] })}>Fila entera (sin clave)</button>
                  <div class="compare-keys-list">
                    <For each={shared()}>
                      {(name) => (
                        <label class="check">
                          <input type="checkbox" checked={(cmp()?.key ?? whole()?.key ?? []).includes(name)} onChange={() => toggleKey(name)} /> {name}
                        </label>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
            <button type="button" class="btn tiny" title="Exportar lo que se ve (con una columna «estado» y el valor de A de las celdas cambiadas)" onClick={exportMenu}>
              <Download size={12} /> Exportar
            </button>
          </div>
        )}
      </Show>
      <Show when={sideA()}>{(a) => <SideNote side={a()} name="A" />}</Show>
      <Show when={sideB()}>{(b) => <SideNote side={b()} name="B" />}</Show>
      <Show when={whole()?.onlyOld.length || whole()?.onlyNew.length}>
        <p class="compare-note">
          No se comparan las columnas que solo están en uno de los dos:{" "}
          {[...(whole()?.onlyOld ?? []).map((n) => `${n} (A)`), ...(whole()?.onlyNew ?? []).map((n) => `${n} (B)`)].join(", ")}.
        </p>
      </Show>
      <Show
        when={shown()}
        fallback={
          <p class="muted compare-note">
            {!sideA() ? "El resultado A ya no está abierto o no tiene filas." : "El resultado B ya no está abierto o todavía no tiene filas: ejecuta la consulta y se comparará con él."}
          </p>
        }
      >
        {(c) => (
          <Show when={c().rows.length || !cmp()?.onlyDiff} fallback={<p class="muted compare-note">Los dos resultados son iguales: no hay diferencias.</p>}>
            <DataGrid
              columns={c().columns}
              rows={c().rows}
              resetKey={`compare:${JSON.stringify([cmp()?.base, cmp()?.other, cmp()?.key, whole()?.key])}:${props.tab.runId}`}
              rowsKey={`${cmp()?.onlyDiff}:${sideA()?.loaded}:${sideB()?.loaded}`}
              busyKey={props.tab.id}
              dialect={kindOf(sideB()?.connId ?? props.tab.connId)}
              edits={c().changed}
              editsAreBefore
              deleted={c().gone}
              insertStart={c().newFrom}
            />
          </Show>
        )}
      </Show>
    </div>
  );
}
