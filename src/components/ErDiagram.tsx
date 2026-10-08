import { Download, ExternalLink, Maximize2, Minus, Plus, Search, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, isTauri } from "../api";
import { columnY, edgePath, ER, layoutEr, type ErBox, type ErTable } from "../erLayout";
import { Gib } from "../gib/Gib";
import { closeErDiagram, notify, openTable, state } from "../state";
import { detachPanel, isPanelWindow } from "../windows";

/**
 * Entity-relationship diagram of a schema: one card per table (columns, keys), a line per foreign key from its
 * column to the referenced one. Drag to pan, wheel to zoom, hover a table to see its relations, double-click
 * to open it. Exports to SVG.
 */
export function ErDiagram() {
  const er = () => state.er!;
  const layout = createMemo(() => layoutEr(er().tables, er().edges));
  const byId = createMemo(() => new Map(er().tables.map((t) => [t.id, t])));
  const [view, setView] = createSignal({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  let host: HTMLDivElement | undefined;
  let svg: SVGSVGElement | undefined;

  const matches = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? new Set(er().tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase() === q)).map((t) => t.id)) : null;
  });
  /** The hovered table and everything it relates to. */
  const related = createMemo(() => {
    const id = hover();
    if (!id) return null;
    const set = new Set([id]);
    for (const e of er().edges) {
      if (e.from === id) set.add(e.to);
      if (e.to === id) set.add(e.from);
    }
    return set;
  });
  const dim = (id: string) => (related() ? !related()!.has(id) : matches() ? !matches()!.has(id) : false);

  function fit() {
    if (!host) return;
    const { width, height } = layout();
    const r = host.getBoundingClientRect();
    const k = Math.min(1.2, Math.max(0.15, Math.min(r.width / width, (r.height - 10) / height)));
    setView({ k, x: (r.width - width * k) / 2, y: Math.max(0, (r.height - height * k) / 2) });
  }
  function zoom(factor: number, cx?: number, cy?: number) {
    if (!host) return;
    const r = host.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const v = view();
    const k = Math.min(3, Math.max(0.1, v.k * factor));
    setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
  }
  function centerOn(id: string) {
    const box = layout().boxes[id];
    if (!box || !host) return;
    const r = host.getBoundingClientRect();
    const k = Math.max(view().k, 0.8);
    setView({ k, x: r.width / 2 - (box.x + box.w / 2) * k, y: r.height / 2 - (box.y + box.h / 2) * k });
  }

  // Fit once the first tables are in, and again when loading ends.
  let fitted = false;
  createEffect(
    on(
      () => [er().tables.length, er().loading] as const,
      ([count, loading]) => {
        if (count && (!fitted || !loading)) {
          fitted = true;
          queueMicrotask(fit);
        }
      },
    ),
  );

  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof HTMLInputElement && query())) {
        event.stopPropagation();
        closeErDiagram();
      }
    };
    window.addEventListener("keydown", key, true);
    onCleanup(() => window.removeEventListener("keydown", key, true));
  });

  // Pan with the mouse; wheel zooms around the cursor.
  let drag: { x: number; y: number; vx: number; vy: number } | null = null;
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, vx: view().x, vy: view().y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    setView({ ...view(), x: drag.vx + event.clientX - drag.x, y: drag.vy + event.clientY - drag.y });
  };
  const onUp = () => (drag = null);
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const r = host!.getBoundingClientRect();
    zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - r.left, event.clientY - r.top);
  };

  async function exportSvg() {
    if (!svg) return;
    // The whole diagram, not the hover or search highlight of the moment.
    const searched = query();
    setHover(null);
    setQuery("");
    // Past the highlight transitions (160 ms).
    await new Promise((done) => setTimeout(done, 220));
    const markup = standaloneSvg(svg, layout().width, layout().height);
    setQuery(searched);
    const name = `${er().title.replace(/[^\w.-]+/g, "_") || "diagrama"}.svg`;
    if (isTauri()) {
      const path = await api().pickSavePath([{ name: "SVG", extensions: ["svg"] }]);
      if (!path) return;
      await api().writeTextFile(path, markup);
      notify("Diagrama exportado", "success", path);
    } else {
      const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div class="er-view" role="dialog" aria-label={`Diagrama ${er().title}`}>
      <header class="er-head">
        <b>Diagrama</b>
        <span class="er-title">{er().title}</span>
        <span class="muted small">
          {er().tables.length} {er().tables.length === 1 ? "tabla" : "tablas"} · {er().edges.length} {er().edges.length === 1 ? "relación" : "relaciones"}
          {er().truncated ? ` · ${er().truncated} más sin mostrar` : ""}
        </span>
        <span class="spacer" />
        <label class="er-search">
          <Search size={13} />
          <input
            placeholder="Buscar tabla o columna"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches()?.size) centerOn([...matches()!][0]);
              if (event.key === "Escape") setQuery("");
            }}
          />
        </label>
        <button type="button" class="icon-btn" title="Alejar" onClick={() => zoom(1 / 1.25)}><Minus size={15} /></button>
        <span class="er-zoom">{Math.round(view().k * 100)}%</span>
        <button type="button" class="icon-btn" title="Acercar" onClick={() => zoom(1.25)}><Plus size={15} /></button>
        <button type="button" class="icon-btn" title="Ajustar a la ventana" onClick={fit}><Maximize2 size={14} /></button>
        <button type="button" class="btn tiny" disabled={!er().tables.length} onClick={() => void exportSvg()}><Download size={13} /> SVG</button>
        <Show when={isTauri() && !isPanelWindow()}>
          <button type="button" class="icon-btn" title="Abrir el diagrama en su propia ventana" disabled={er().loading} onClick={() => void detachPanel("er")}><ExternalLink size={15} /></button>
        </Show>
        <button type="button" class="icon-btn" title="Cerrar (Esc)" onClick={closeErDiagram}><X size={16} /></button>
      </header>
      <Show when={er().loading}>
        <div class="er-progress"><i style={{ width: `${er().total ? (er().done / er().total) * 100 : 8}%` }} /></div>
      </Show>
      <div class="er-canvas" ref={host} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
        <Show when={er().error}>
          <div class="er-empty"><Gib size={84} mood="error" /><p>{er().error}</p></div>
        </Show>
        <Show when={!er().error && !er().loading && !er().tables.length}>
          <div class="er-empty"><Gib size={84} mood="think" /><p>Este esquema no tiene tablas.</p></div>
        </Show>
        <Show when={er().loading && !er().tables.length && !er().error}>
          <div class="er-empty"><Gib size={84} mood="busy" pose="laptop" /><p>Leyendo tablas y claves… {er().done}/{er().total || "?"}</p></div>
        </Show>
        <svg ref={svg} class="er-svg" width="100%" height="100%">
          <defs>
            <marker id="er-one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
              <path d="M 11 1 V 11 M 7 1 V 11" class="er-mark" />
            </marker>
            {/* "Many" end (the table with the foreign key): a crow's foot that opens onto the card's edge. */}
            <marker id="er-many" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
              <path d="M 11 1 L 1 6 L 11 11 M 11 6 H 1" class="er-mark" />
            </marker>
          </defs>
          <g transform={`translate(${view().x} ${view().y}) scale(${view().k})`}>
            <For each={er().edges}>
              {(edge) => {
                const d = () => {
                  const from = layout().boxes[edge.from];
                  const to = layout().boxes[edge.to];
                  const fromTable = byId().get(edge.from);
                  const toTable = byId().get(edge.to);
                  if (!from || !to || !fromTable || !toTable) return "";
                  return edgePath(from, columnY(fromTable, edge.fromCols[0]), to, columnY(toTable, edge.toCols[0] ?? ""));
                };
                const lit = () => hover() !== null && (edge.from === hover() || edge.to === hover());
                return (
                  <Show when={d()}>
                    <path class="er-edge" classList={{ lit: lit(), dim: Boolean(hover()) && !lit() }} d={d()} marker-start="url(#er-many)" marker-end="url(#er-one)">
                      <title>{`${edge.name}: ${edge.fromCols.join(", ")} → ${edge.to.split(".").pop()}(${edge.toCols.join(", ")})`}</title>
                    </path>
                  </Show>
                );
              }}
            </For>
            <For each={er().tables}>
              {(table) => <TableCard table={table} box={layout().boxes[table.id]} dim={dim(table.id)} hit={Boolean(matches()?.has(table.id))} onHover={setHover} onOpen={() => {
                const obj = er().objects[table.id];
                if (!obj) return;
                const connId = er().connId;
                // In a window of its own the diagram stays: the table opens in its Celer window.
                if (!isPanelWindow()) closeErDiagram();
                void openTable(connId, obj);
              }} />}
            </For>
          </g>
        </svg>
        <p class="er-hint">Arrastra para moverte · rueda para acercar · pasa el ratón por una tabla para ver sus relaciones · doble clic para abrirla</p>
      </div>
    </div>
  );
}

function TableCard(props: { table: ErTable; box: ErBox | undefined; dim: boolean; hit: boolean; onHover: (id: string | null) => void; onOpen: () => void }) {
  const shown = () => props.table.columns.slice(0, ER.maxRows);
  const hidden = () => props.table.columns.length - shown().length;
  return (
    <Show when={props.box}>
      {(box) => (
        <g
          class="er-table"
          classList={{ dim: props.dim, hit: props.hit }}
          transform={`translate(${box().x} ${box().y})`}
          onPointerEnter={() => props.onHover(props.table.id)}
          onPointerLeave={() => props.onHover(null)}
          onDblClick={(event) => {
            event.stopPropagation();
            props.onOpen();
          }}
        >
          <rect class="er-card" width={box().w} height={box().h} rx="8" />
          <path class="er-card-head" d={`M 0 8 A 8 8 0 0 1 8 0 H ${box().w - 8} A 8 8 0 0 1 ${box().w} 8 V ${ER.header} H 0 Z`} />
          <text class="er-name" x="12" y="20">{props.table.name}</text>
          <For each={shown()}>
            {(col, i) => (
              <g transform={`translate(0 ${ER.header + i() * ER.row})`}>
                <Show when={col.pk || col.fk}>
                  <text class="er-key" classList={{ pk: col.pk, fk: col.fk && !col.pk }} x="10" y="14">{col.pk ? "PK" : "FK"}</text>
                </Show>
                <text class="er-col" classList={{ pk: col.pk, nullable: col.nullable && !col.pk }} x="34" y="14">{col.name}</text>
                <text class="er-type" x={box().w - 10} y="14" text-anchor="end">{col.type.length > 18 ? `${col.type.slice(0, 17)}…` : col.type}</text>
              </g>
            )}
          </For>
          <Show when={hidden() > 0}>
            <text class="er-more" x="34" y={ER.header + ER.maxRows * ER.row + 14}>+{hidden()} columnas más</text>
          </Show>
        </g>
      )}
    </Show>
  );
}

/** The diagram as a standalone SVG file: the whole drawing at 100%, with the theme's colours written in. */
function standaloneSvg(live: SVGSVGElement, width: number, height: number): string {
  const copy = live.cloneNode(true) as SVGSVGElement;
  const source = [...live.querySelectorAll("*")];
  const target = [...copy.querySelectorAll("*")];
  source.forEach((el, i) => {
    const style = getComputedStyle(el);
    const out = target[i] as SVGElement;
    // Not opacity: in the diagram it only dims what the hover or the search leaves out.
    for (const prop of ["fill", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight"]) {
      const value = style.getPropertyValue(prop);
      if (value && value !== "none" && value !== "normal") out.setAttribute(prop, prop === "fill" || prop === "stroke" ? plainColor(value) : value);
      else if (value === "none") out.setAttribute(prop, "none");
    }
    out.removeAttribute("class");
  });
  copy.querySelector("g")?.setAttribute("transform", "");
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(Math.ceil(width)));
  copy.setAttribute("height", String(Math.ceil(height)));
  copy.setAttribute("viewBox", `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
  const background = plainColor(getComputedStyle(live.parentElement!).backgroundColor);
  copy.insertAdjacentHTML("afterbegin", `<rect width="100%" height="100%" fill="${background}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${copy.outerHTML}`;
}

let swatch: CanvasRenderingContext2D | null = null;
/**
 * A colour other SVG viewers understand: the theme's color-mix() / color(srgb …) values become rgba() (painted
 * on a 1×1 canvas and read back). url(#marker) references and plain colours pass through.
 */
function plainColor(value: string): string {
  if (!/^(color|oklch|oklab|lab|lch)/i.test(value.trim())) return value;
  swatch ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  if (!swatch) return value;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = "#000";
  swatch.fillStyle = value;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}
