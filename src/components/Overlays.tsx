import { ChevronRight, CircleAlert, CircleCheck, Info, Search, TriangleAlert, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { commands, shortcutLabel } from "../commands";
import { chordLabel, normalizeChord } from "../keymap";
import { library, loadLibrary, openLibraryScript, openRunOn } from "../library";
import { returnFocus } from "../focus";
import { bubbleOpen } from "../gib/Companion";
import { flipList, leaveOnCleanup } from "../motion";
import { nextMenuItem, placeMenu } from "../menu";
import { ObjIcon } from "../icons";
import { allTables, closeMenu, connectionById, dismissToast, openTable, selectTab, setState, state, tableDirty, type MenuItem } from "../state";

// ---------------------------------------------------------------- context menu

/**
 * The shortcut a menu row shows, always in the same notation (the keymap's: "Ctrl+Mayús+F", ⌘ on macOS): a
 * command's as the user set it, or a key that only works where the menu was opened.
 */
export function menuKeys(item: MenuItem): string {
  if (item.command) return shortcutLabel(item.command);
  return item.keys ? chordLabel(normalizeChord(item.keys)) : "";
}

export function ContextMenu() {
  onMount(() => {
    // A press outside every open panel (the menu and its submenus) closes the menu.
    const close = (event: Event) => {
      if (state.menu && !(event.target instanceof Element && event.target.closest(".menu"))) closeMenu();
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

  return (
    <Show when={state.menu} keyed>
      {(menu) => <MenuPanel items={menu.items} anchor={{ x: menu.x, y: menu.y }} root />}
    </Show>
  );
}

/**
 * One panel of the context menu: the root, or a submenu (`submenu` on an item: «Generar SQL ›», «Copiar como ›»…).
 * Keyboard: arrows move, → or Intro open a submenu, ← or Esc close it and go back to its row, Esc on the root closes
 * the menu. The mouse opens a submenu by resting on its row.
 */
function MenuPanel(props: { items: MenuItem[]; anchor: { x: number; y: number; row?: { left: number; right: number; top: number } }; root?: boolean; onBack?: () => void; onEnter?: () => void }) {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ x: props.anchor.x, y: props.anchor.y });
  const [active, setActive] = createSignal(props.root ? -1 : nextMenuItem(props.items, -1, 1));
  /** The open submenu: the row it hangs from (index) and where that row is. */
  const [open, setOpen] = createSignal<{ index: number; row: { left: number; right: number; top: number } } | null>(null);
  let hoverTimer = 0;
  onCleanup(() => window.clearTimeout(hoverTimer));

  onMount(() => {
    queueMicrotask(() => {
      if (!el) return;
      // Its layout size: the bounding box is still scaled down by the pop-in animation (it overflowed the edge).
      setPos(placeMenu(props.anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
      el.focus();
    });
  });

  const rowOf = (index: number) => el?.querySelectorAll<HTMLElement>(":scope > .menu-item, :scope > .menu-sep")[index];

  function openSub(index: number, focus: boolean) {
    const item = props.items[index];
    if (!item?.submenu || item.disabled) return;
    const rect = rowOf(index)?.getBoundingClientRect();
    if (!rect) return;
    setOpen({ index, row: { left: rect.left, right: rect.right, top: rect.top } });
    // From the keyboard the submenu takes the focus (it focuses itself when it mounts); from the mouse this panel
    // keeps it until the pointer goes into the submenu.
    if (!focus) queueMicrotask(() => el?.focus());
  }

  function choose(item: MenuItem, index: number) {
    if (item.submenu) {
      openSub(index, true);
      return;
    }
    closeMenu();
    item.run?.();
  }

  function onKey(event: KeyboardEvent) {
    const list = props.items;
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      setActive(nextMenuItem(list, active(), key === "ArrowDown" ? 1 : -1));
      setOpen(null);
    } else if (key === "Home" || key === "End") {
      event.preventDefault();
      setActive(key === "Home" ? nextMenuItem(list, -1, 1) : nextMenuItem(list, list.length, -1));
    } else if (key === "ArrowRight" && list[active()]?.submenu) {
      event.preventDefault();
      openSub(active(), true);
    } else if ((key === "ArrowLeft" && !props.root) || key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (props.root) closeMenu();
      else props.onBack?.();
    } else if ((key === "Enter" || key === " ") && active() >= 0) {
      event.preventDefault();
      const item = list[active()];
      if (item && !item.disabled) choose(item, active());
    }
  }

  return (
    <>
      <div
        class="menu"
        classList={{ submenu: !props.root }}
        ref={(node) => {
          el = node;
          if (props.root) leaveOnCleanup("menu")(node);
        }}
        tabIndex={-1}
        role="menu"
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        onKeyDown={onKey}
        onMouseEnter={() => props.onEnter?.()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <For each={props.items}>
          {(item, index) =>
            item.separator ? (
              <div class="menu-sep" role="separator" />
            ) : (
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                classList={{ danger: item.danger, active: active() === index(), "has-sub": Boolean(item.submenu), open: open()?.index === index() }}
                disabled={item.disabled}
                title={item.title}
                aria-haspopup={item.submenu ? "menu" : undefined}
                aria-expanded={item.submenu ? open()?.index === index() : undefined}
                onMouseEnter={() => {
                  setActive(index());
                  window.clearTimeout(hoverTimer);
                  // Resting on a row opens its submenu (or closes another one), after a moment so a pass on the way
                  // to the open submenu does not close it.
                  hoverTimer = window.setTimeout(() => {
                    if (item.submenu) {
                      if (open()?.index !== index()) openSub(index(), false);
                    } else setOpen(null);
                  }, open() ? 180 : 60);
                }}
                onClick={() => choose(item, index())}
              >
                <span class="menu-label">{item.label}</span>
                <Show when={item.hint}><small class="menu-hint">{item.hint}</small></Show>
                <Show when={menuKeys(item)}><kbd>{menuKeys(item)}</kbd></Show>
                <Show when={item.submenu}><ChevronRight size={13} class="menu-sub-arrow" /></Show>
              </button>
            )
          }
        </For>
      </div>
      <Show when={open()} keyed>
        {(sub) => (
          <MenuPanel
            items={props.items[sub.index]?.submenu ?? []}
            anchor={{ x: sub.row.right, y: sub.row.top, row: sub.row }}
            onBack={() => {
              setOpen(null);
              setActive(sub.index);
              el?.focus();
            }}
            onEnter={() => window.clearTimeout(hoverTimer)}
          />
        )}
      </Show>
    </>
  );
}

// ---------------------------------------------------------------- toasts

export function Toasts() {
  // A table with pending changes shows its changes bar at the bottom: the toasts go above it, not over its buttons.
  const raised = () => {
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    return tab?.kind === "table" && tab.section === "data" && tableDirty(tab);
  };
  let box: HTMLDivElement | undefined;
  // A toast that goes fades out where it was and the others glide into place.
  flipList(() => (box ? [...box.querySelectorAll<HTMLElement>(":scope > .toast")] : []), () => state.toasts.map((toast) => toast.id).join());
  return (
    <div class="toasts" ref={box} classList={{ raised: raised(), "beside-tip": bubbleOpen() }} aria-live="polite">
      <For each={state.toasts}>
        {(toast) => (
          <div class={`toast ${toast.kind}`} role="status" data-flip={toast.id} ref={leaveOnCleanup("toast")}>
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
      <div class="scrim light" ref={leaveOnCleanup("scrim")} onMouseDown={close} />
      <div class="palette" ref={leaveOnCleanup("palette")} role="dialog" aria-label="Buscar en todo">
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
