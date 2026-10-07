import { Filter, Plus, Search, X } from "lucide-solid";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { cellText, isNullCell } from "../sql";
import { FILTER_OPS, filterLabel, removeTableFilter, toggleTableFilter, upsertTableFilter, type ColumnFilter, type FilterOp, type TableTab } from "../state";
import { ObjIcon } from "../icons";

const NULL_KEY = "\u0000NULL";

export interface FilterDraft {
  filter: ColumnFilter;
  x: number;
  y: number;
}

export function newFilter(tab: TableTab, col?: string, op: FilterOp = "eq", value = ""): ColumnFilter {
  return { id: "", col: col ?? tab.columnsMeta[0]?.name ?? "", op, value, value2: "", values: [], enabled: true };
}

/** Chips for the active column filters, under the data toolbar. */
export function FilterChips(props: { tab: TableTab; onEdit: (filter: ColumnFilter, el: HTMLElement) => void; onAdd: (el: HTMLElement) => void }) {
  return (
    <Show when={props.tab.filters.length}>
      <div class="filter-chips">
        <Filter size={13} class="chips-icon" />
        <For each={props.tab.filters}>
          {(filter) => (
            <span class="chip" classList={{ off: !filter.enabled }}>
              <button type="button" class="chip-toggle" title={filter.enabled ? "Desactivar filtro" : "Activar filtro"} onClick={() => toggleTableFilter(props.tab.id, filter.id)}>
                <i />
              </button>
              <button type="button" class="chip-body" title="Editar filtro" onClick={(event) => props.onEdit(filter, event.currentTarget)}>
                {filterLabel(filter)}
              </button>
              <button type="button" class="chip-x" title="Quitar filtro" onClick={() => removeTableFilter(props.tab.id, filter.id)}>
                <X size={11} />
              </button>
            </span>
          )}
        </For>
        <button type="button" class="chip-add" title="Añadir filtro" onClick={(event) => props.onAdd(event.currentTarget)}>
          <Plus size={12} /> Filtro
        </button>
        <span class="spacer" />
        <button type="button" class="link small" onClick={() => removeTableFilter(props.tab.id)}>Quitar todos</button>
      </div>
    </Show>
  );
}

/** Popover to create or edit one column filter. */
export function FilterEditor(props: { tab: TableTab; draft: FilterDraft; onClose: () => void }) {
  let box: HTMLDivElement | undefined;
  let valueInput: HTMLInputElement | undefined;
  const [filter, setFilter] = createSignal<ColumnFilter>({ ...props.draft.filter, values: [...props.draft.filter.values] });
  const [search, setSearch] = createSignal("");
  const [pos, setPos] = createSignal({ x: props.draft.x, y: props.draft.y });

  const column = () => props.tab.columnsMeta.find((col) => col.name === filter().col);
  const colIndex = () => props.tab.columnsMeta.findIndex((col) => col.name === filter().col);
  const ops = () => FILTER_OPS.filter((item) => !item.kinds || item.kinds.includes(column()?.kind ?? "text"));
  const arity = () => FILTER_OPS.find((item) => item.op === filter().op)?.arity ?? 1;
  const set = (patch: Partial<ColumnFilter>) => setFilter({ ...filter(), ...patch });

  /** Distinct values among the loaded rows, most frequent first. */
  const distinct = createMemo(() => {
    const index = props.tab.gridCols.findIndex((col) => col.name === filter().col);
    if (index < 0) return [] as { key: string; label: string; count: number }[];
    const counts = new Map<string, number>();
    for (const row of unwrap(props.tab.rows)) {
      const cell = row[index];
      const key = isNullCell(cell) ? NULL_KEY : cellText(cell);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.size > 2000) break;
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([key, count]) => ({ key, label: key === NULL_KEY ? "NULL" : key, count }));
  });

  const info = createMemo(() => new Map(distinct().map((item) => [item.key, item])));
  // Plain string keys keep <For> rows stable while values are ticked (no re-created checkboxes).
  const visibleKeys = createMemo(() => {
    const q = search().toLowerCase();
    const list = distinct().filter((item) => !q || item.label.toLowerCase().includes(q)).map((item) => item.key);
    const extra = filter().values.filter((value) => !info().has(value));
    return [...extra, ...list].slice(0, 300);
  });
  const labelOf = (key: string) => (key === NULL_KEY ? "NULL" : info().get(key)?.label ?? key);

  onMount(() => {
    queueMicrotask(() => {
      if (box) {
        const rect = box.getBoundingClientRect();
        setPos({ x: Math.max(8, Math.min(props.draft.x, window.innerWidth - rect.width - 8)), y: Math.min(props.draft.y, window.innerHeight - rect.height - 8) });
      }
      valueInput?.focus();
    });
    const outside = (event: MouseEvent) => {
      if (box && !box.contains(event.target as Node)) props.onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", key, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", key, true);
    });
  });

  const valid = () => {
    const f = filter();
    if (!f.col) return false;
    if (arity() === 1) return f.value !== "" || f.op === "eq" || f.op === "ne";
    if (arity() === 2) return f.value !== "" && f.value2 !== "";
    if (arity() === "list") return f.values.length > 0;
    return true;
  };

  function apply() {
    if (!valid()) return;
    upsertTableFilter(props.tab.id, { ...filter(), enabled: true });
    props.onClose();
  }

  function toggleValue(key: string) {
    const values = filter().values.includes(key) ? filter().values.filter((value) => value !== key) : [...filter().values, key];
    set({ values });
  }

  return (
    <div class="filter-editor" ref={box} style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={(event) => event.key === "Enter" && !(event.target as HTMLElement).closest(".fe-values") && apply()}>
      <div class="fe-row">
        <label class="field grow">
          <span>Columna</span>
          <select
            value={filter().col}
            onChange={(event) => {
              const col = props.tab.columnsMeta.find((item) => item.name === event.currentTarget.value);
              const keep = FILTER_OPS.find((item) => item.op === filter().op);
              const op = keep && (!keep.kinds || keep.kinds.includes(col?.kind ?? "text")) ? filter().op : "eq";
              set({ col: event.currentTarget.value, op, values: [] });
            }}
          >
            <For each={props.tab.columnsMeta}>{(col) => <option value={col.name}>{col.name} · {col.typeName}</option>}</For>
          </select>
        </label>
        <label class="field grow">
          <span>Condición</span>
          <select value={filter().op} onChange={(event) => set({ op: event.currentTarget.value as FilterOp })}>
            <For each={ops()}>{(item) => <option value={item.op}>{item.label}</option>}</For>
          </select>
        </label>
      </div>
      <Show when={arity() === 1}>
        <label class="field">
          <span>Valor</span>
          <input ref={valueInput} value={filter().value} spellcheck={false} placeholder={column()?.kind === "date" ? "2025-01-31" : column()?.kind === "number" ? "0" : "texto"} onInput={(event) => set({ value: event.currentTarget.value })} />
        </label>
      </Show>
      <Show when={arity() === 2}>
        <div class="fe-row">
          <label class="field grow"><span>Desde</span><input ref={valueInput} value={filter().value} spellcheck={false} onInput={(event) => set({ value: event.currentTarget.value })} /></label>
          <label class="field grow"><span>Hasta</span><input value={filter().value2} spellcheck={false} onInput={(event) => set({ value2: event.currentTarget.value })} /></label>
        </div>
      </Show>
      <Show when={arity() === "list"}>
        <div class="fe-values">
          <div class="mini-search grow">
            <Search size={12} />
            <input
              ref={valueInput}
              placeholder="Buscar o escribir un valor y pulsar Intro"
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && search().trim()) {
                  event.preventDefault();
                  const exact = distinct().find((item) => item.label.toLowerCase() === search().trim().toLowerCase());
                  const key = exact?.key ?? search().trim();
                  if (!filter().values.includes(key)) set({ values: [...filter().values, key] });
                  setSearch("");
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  apply();
                }
              }}
            />
          </div>
          <div class="fe-list">
            <For each={visibleKeys()}>
              {(key) => (
                <label class="fe-value" classList={{ null: key === NULL_KEY }}>
                  <input type="checkbox" checked={filter().values.includes(key)} onChange={() => toggleValue(key)} />
                  <span>{labelOf(key) === "" ? "(vacío)" : labelOf(key)}</span>
                  <Show when={info().get(key)?.count}><small>{info().get(key)!.count.toLocaleString()}</small></Show>
                </label>
              )}
            </For>
            <Show when={!visibleKeys().length}><p class="fe-empty">Sin valores. Escribe uno y pulsa Intro.</p></Show>
          </div>
          <div class="fe-list-foot">
            <span>Valores de las {props.tab.rows.length.toLocaleString()} filas cargadas</span>
            <span class="spacer" />
            <button type="button" class="link small" onClick={() => set({ values: distinct().map((item) => item.key) })}>Todos</button>
            <button type="button" class="link small" onClick={() => set({ values: [] })}>Ninguno</button>
          </div>
        </div>
      </Show>
      <div class="fe-preview">
        <ObjIcon kind={column()?.primaryKey ? "pkcolumn" : "column"} size={13} />
        <code>{valid() ? filterLabel(filter()) : "Completa el filtro"}</code>
        <Show when={colIndex() < 0}><span class="muted">columna desconocida</span></Show>
      </div>
      <footer>
        <Show when={props.draft.filter.id}>
          <button type="button" class="btn tiny" onClick={() => { removeTableFilter(props.tab.id, props.draft.filter.id); props.onClose(); }}>Quitar</button>
        </Show>
        <span class="spacer" />
        <button type="button" class="btn tiny" onClick={props.onClose}>Cancelar</button>
        <button type="button" class="btn tiny primary" disabled={!valid()} onClick={apply}>Aplicar</button>
      </footer>
    </div>
  );
}
