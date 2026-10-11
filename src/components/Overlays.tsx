import { CircleAlert, CircleCheck, Info, Search, TriangleAlert, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { commands } from "../commands";
import { library, loadLibrary, openLibraryScript, openRunOn } from "../library";
import { returnFocus } from "../focus";
import { ObjIcon } from "../icons";
import { allTables, closeMenu, connectionById, dismissToast, openTable, selectTab, setState, state, tableDirty } from "../state";

// ---------------------------------------------------------------- context menu

export function ContextMenu() {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [active, setActive] = createSignal(-1);

  createEffect(() => {
    const menu = state.menu;
    if (!menu) return;
    setActive(-1);
    setPos({ x: menu.x, y: menu.y });
    queueMicrotask(() => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = Math.min(menu.x, window.innerWidth - rect.width - 6);
      const y = menu.y + rect.height > window.innerHeight - 6 ? Math.max(6, menu.y - rect.height) : menu.y;
      setPos({ x: Math.max(6, x), y });
      el.focus();
    });
  });

  onMount(() => {
    const close = (event: Event) => {
      if (state.menu && el && !el.contains(event.target as Node)) closeMenu();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    onCleanup(() => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    });
  });

  const items = () => state.menu?.items ?? [];

  function onKey(event: KeyboardEvent) {
    const list = items();
    const step = (dir: number) => {
      event.preventDefault();
      let next = active();
      for (let i = 0; i < list.length; i++) {
        next = (next + dir + list.length) % list.length;
        if (!list[next].separator && !list[next].disabled) break;
      }
      setActive(next);
    };
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
    if (event.key === "ArrowDown") step(1);
    if (event.key === "ArrowUp") step(-1);
    if (event.key === "Enter" && active() >= 0) {
      event.preventDefault();
      const item = list[active()];
      closeMenu();
      item.run?.();
    }
  }

  return (
    <Show when={state.menu}>
      <div class="menu" ref={el} tabIndex={-1} role="menu" style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={onKey} onContextMenu={(event) => event.preventDefault()}>
        <For each={items()}>
          {(item, index) =>
            item.separator ? (
              <div class="menu-sep" />
            ) : (
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                classList={{ danger: item.danger, active: active() === index() }}
                disabled={item.disabled}
                title={item.title}
                onMouseEnter={() => setActive(index())}
                onClick={() => {
                  closeMenu();
                  item.run?.();
                }}
              >
                <span class="menu-label">{item.label}</span>
                <Show when={item.hint}><kbd>{item.hint}</kbd></Show>
              </button>
            )
          }
        </For>
      </div>
    </Show>
  );
}

// ---------------------------------------------------------------- toasts

export function Toasts() {
  // A table with pending changes shows its changes bar at the bottom: the toasts go above it, not over its buttons.
  const raised = () => {
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    return tab?.kind === "table" && tab.section === "data" && tableDirty(tab);
  };
  return (
    <div class="toasts" classList={{ raised: raised() }} aria-live="polite">
      <For each={state.toasts}>
        {(toast) => (
          <div class={`toast ${toast.kind}`} role="status">
            <span class="toast-icon">
              {toast.kind === "success" ? <CircleCheck size={16} /> : toast.kind === "error" ? <CircleAlert size={16} /> : toast.kind === "warning" ? <TriangleAlert size={16} /> : <Info size={16} />}
            </span>
            <div class="toast-body">
              <b>{toast.text}</b>
              <Show when={toast.detail}><span>{toast.detail}</span></Show>
              <Show when={toast.action}>
                <button type="button" class="link small toast-action" onClick={() => { toast.action!.run(); dismissToast(toast.id); }}>{toast.action!.label}</button>
              </Show>
            </div>
            <button type="button" class="icon-btn tiny" title="Cerrar" onClick={() => dismissToast(toast.id)}><X size={12} /></button>
          </div>
        )}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------- palette

interface PaletteItem {
  key: string;
  label: string;
  detail?: string;
  /** More about it, as a tooltip. */
  hint?: string;
  group: string;
  icon: string;
  keys?: string;
  run: () => void;
  score: number;
  /** Shown greyed, with `hint` saying why (a feature the engine does not have). */
  disabled?: boolean;
}

function fuzzy(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 100 - t.length * 0.01;
  if (at > 0) return 70 - at * 0.1 - t.length * 0.01;
  // Subsequence match, but only through word starts or consecutive letters (like "mpq" → my_pending_queue).
  let ti = 0;
  let score = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] !== ch) continue;
      const wordStart = i === 0 || /[\s_.\-:/]/.test(t[i - 1]) || (text[i] !== t[i] && text[i - 1] === t[i - 1]);
      if (i === ti && qi > 0) {
        found = i;
        score += 3;
        break;
      }
      if (wordStart) {
        found = i;
        score += 2;
        break;
      }
    }
    if (found < 0) return 0;
    ti = found + 1;
  }
  return Math.min(45, score * 2) - t.length * 0.01;
}

export function Palette() {
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);

  // What had the focus when the palette opened: it gets it back when the palette closes.
  let opener: Element | null = null;
  createEffect((wasOpen: boolean) => {
    const open = state.paletteOpen;
    if (open && !wasOpen) opener = document.activeElement;
    if (!open && wasOpen) returnFocus(opener);
    return open;
  }, false);

  createEffect(() => {
    if (state.paletteOpen) {
      setQuery("");
      setActive(0);
      // Library scripts are listed too ("all"): read the library if the panel never was.
      void loadLibrary();
      queueMicrotask(() => input?.focus());
    }
  });

  const items = createMemo<PaletteItem[]>(() => {
    if (!state.paletteOpen) return [];
    const q = query().trim();
    const mode = state.paletteMode;
    const out: PaletteItem[] = [];
    if (mode !== "actions") {
      for (const table of allTables()) {
        const label = table.obj.name;
        const score = fuzzy(label, q) || fuzzy(`${table.obj.schema}.${label}`, q) * 0.8;
        if (!score) continue;
        const conn = connectionById(table.connId);
        out.push({
          key: `t:${table.connId}:${table.obj.database}:${table.obj.schema}:${label}`,
          label,
          detail: [conn?.name, table.obj.database, table.obj.schema].filter(Boolean).join(" · "),
          group: table.obj.kind === "view" ? "Vistas" : "Tablas",
          icon: table.obj.kind === "view" ? "view" : "table",
          run: () => void openTable(table.connId, table.obj),
          score: score + 5,
        });
      }
      if (mode === "all") {
        for (const tab of state.tabs) {
          const score = fuzzy(tab.title, q);
          if (!score) continue;
          out.push({ key: `tab:${tab.id}`, label: tab.title, detail: connectionById(tab.connId)?.name, group: "Pestañas abiertas", icon: tab.kind === "table" ? "table" : "console", run: () => selectTab(tab.id), score: score + 8 });
        }
        for (const script of library.scripts) {
          const tags = script.tags.map((tag) => `#${tag}`).join(" ");
          const score = fuzzy(script.name, q) || fuzzy(`${script.folder} ${script.name} ${tags}`, q) * 0.8;
          if (!score) continue;
          out.push({
            key: `lib:${script.id}`,
            label: script.name,
            detail: [script.folder, connectionById(script.connId)?.name, tags].filter(Boolean).join(" · ") || "Biblioteca",
            group: "Biblioteca",
            icon: "file",
            run: () => void openLibraryScript(script.id),
            score: score + 6,
          });
          if (state.connections.length) {
            out.push({
              key: `lib-on:${script.id}`,
              label: `Ejecutar en… «${script.name}»`,
              detail: "Elegir conexión y base de datos (una o varias)",
              group: "Biblioteca",
              icon: "action",
              run: () => openRunOn(script.id),
              score: score + 2,
            });
          }
        }
      }
    }
    if (mode !== "tables") {
      for (const command of commands()) {
        if (command.enabled && !command.enabled()) continue;
        const score = fuzzy(command.label, q) || fuzzy(`${command.group} ${command.label}`, q) * 0.7;
        if (!score) continue;
        // Not on this engine: listed greyed with the reason, below what can run.
        const unsupported = command.unsupported?.() ?? null;
        out.push({ key: `a:${command.id}`, label: command.label, detail: unsupported ?? command.group, hint: unsupported ?? command.hint, group: "Acciones", icon: "action", keys: command.keys, run: command.run, score: unsupported ? score * 0.5 : score, disabled: Boolean(unsupported) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 80);
  });

  createEffect(() => {
    items();
    setActive(0);
  });

  function close() {
    setState("paletteOpen", false);
  }

  function choose(item: PaletteItem | undefined) {
    if (!item || item.disabled) return;
    close();
    item.run();
  }

  function onKey(event: KeyboardEvent) {
    const count = items().length;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((active() + 1) % Math.max(1, count));
      scrollActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((active() - 1 + count) % Math.max(1, count));
      scrollActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items()[active()]);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const order = ["all", "tables", "actions"] as const;
      setState("paletteMode", order[(order.indexOf(state.paletteMode) + (event.shiftKey ? 2 : 1)) % 3]);
    }
  }

  function scrollActive() {
    queueMicrotask(() => list?.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" }));
  }

  const placeholder = () => (state.paletteMode === "tables" ? "Ir a tabla o vista…" : state.paletteMode === "actions" ? "Buscar acción…" : "Buscar tablas, pestañas y acciones…");

  return (
    <Show when={state.paletteOpen}>
      <div class="scrim light" onMouseDown={close} />
      <div class="palette" role="dialog" aria-label="Buscar en todo">
        <div class="pal-search">
          <Search size={16} />
          <input ref={input} placeholder={placeholder()} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={onKey} spellcheck={false} />
          <div class="seg small">
            <button type="button" classList={{ on: state.paletteMode === "all" }} onClick={() => setState("paletteMode", "all")}>Todo</button>
            <button type="button" classList={{ on: state.paletteMode === "tables" }} onClick={() => setState("paletteMode", "tables")}>Tablas</button>
            <button type="button" classList={{ on: state.paletteMode === "actions" }} onClick={() => setState("paletteMode", "actions")}>Acciones</button>
          </div>
        </div>
        <div class="pal-list" ref={list}>
          <Show when={items().length} fallback={<p class="pal-empty">{state.paletteMode === "tables" && !allTables().length ? "Conecta una base de datos para buscar sus tablas." : "Sin coincidencias"}</p>}>
            <For each={items()}>
              {(item, index) => (
                <>
                  <Show when={index() === 0 || items()[index() - 1].group !== item.group}>
                    <div class="pal-group">{item.group}</div>
                  </Show>
                  <button type="button" class="pal-item" classList={{ active: active() === index(), disabled: item.disabled }} aria-disabled={item.disabled} title={item.hint} onMouseMove={() => setActive(index())} onClick={() => choose(item)}>
                    <Show when={item.icon !== "action"} fallback={<span class="pal-action-dot" />}>
                      <ObjIcon kind={item.icon} size={15} />
                    </Show>
                    <span class="pal-label">{item.label}</span>
                    <Show when={item.detail}><small>{item.detail}</small></Show>
                    <span class="spacer" />
                    <Show when={item.keys}><kbd>{item.keys}</kbd></Show>
                  </button>
                </>
              )}
            </For>
          </Show>
        </div>
        <div class="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
          <span><kbd>Intro</kbd> abrir</span>
          <span><kbd>Tab</kbd> cambiar ámbito</span>
          <span><kbd>Esc</kbd> cerrar</span>
        </div>
      </div>
    </Show>
  );
}
