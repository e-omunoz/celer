import { Minimize2 } from "lucide-solid";
import { createEffect, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Mark } from "../brand/Mark";
import { trackAltGr } from "../keymap";
import { boot, state, type SqlTab } from "../state";
import { schemaCompare } from "../schemaCompareRun";
import { dataCompare } from "../dataCompareRun";
import { answerWindow, closePanelWindow, dockPanel, panelKind, panelReady, prepareWindow, startWindows, windowAsk } from "../windows";
import { panelName } from "../windowModel";
import { AiPanel } from "./AiPanel";
import { ResultCompare } from "./ResultCompare";
import { DataCompareView } from "./DataCompareView";
import { ErDiagram } from "./ErDiagram";
import { LibraryView } from "./LibraryView";
import { Dialog, Modals } from "./Modals";
import { ContextMenu, Toasts } from "./Overlays";
import { PlanView } from "./PlanView";
import { SchemaCompareView } from "./SchemaCompareView";
import { revealWindow, WindowControls } from "./WindowControls";

/**
 * A panel in a window of its own: a slim title bar ("Acoplar" sends it back to its window) and the panel. The
 * library and the assistant work with the active console of the last focused Celer window; a plan, a diagram or a
 * comparison is the one it was opened with.
 */
export function PanelApp() {
  const kind = panelKind!;
  const sqlTab = () => {
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    return tab?.kind === "sql" ? (tab as SqlTab) : undefined;
  };

  onMount(() => {
    startWindows();
    void prepareWindow().then(revealWindow);
    void boot();
    // Never reload the page (the panel would be lost); the menus are the app's own.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")) event.preventDefault();
    };
    const blockMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("input, textarea, .cm-editor")) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", blockMenu);
    const stopAltGr = trackAltGr(window);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", blockMenu);
      stopAltGr();
    });
  });

  // Its content was closed (the diagram's ×, Esc, the comparison closed): the window goes too.
  createEffect(() => {
    if (!panelReady()) return;
    const gone =
      (kind === "er" && !state.er) ||
      (kind === "plan" && !sqlTab()?.plan) ||
      (kind === "compare" && !sqlTab()?.compare) ||
      (kind === "schema-compare" && !schemaCompare.open) ||
      (kind === "data-compare" && !dataCompare.open);
    if (gone) void closePanelWindow();
  });

  return (
    <div class="app panel-window" classList={{ ready: state.ready }}>
      <header class="topbar panel-top" data-tauri-drag-region>
        <div class="brand" data-tauri-drag-region>
          <Mark size={16} />
          <span>{panelName(kind)}</span>
        </div>
        <span class="spacer" data-tauri-drag-region />
        <button type="button" class="top-btn" title="Volver a su ventana de Celer" onClick={() => void dockPanel()}>
          <Minimize2 size={14} /> <span>Acoplar</span>
        </button>
        <WindowControls />
      </header>
      <div class="panel-body">
        <Show when={panelReady()}>
          <Switch>
            <Match when={kind === "library"}><LibraryView /></Match>
            <Match when={kind === "ai"}><AiPanel /></Match>
            <Match when={kind === "plan" && sqlTab()?.plan ? sqlTab() : undefined}>
              {(tab) => <PlanView tab={tab()} plan={tab().plan!.plan} sql={tab().plan!.sql} />}
            </Match>
            <Match when={kind === "compare" && sqlTab()?.compare ? sqlTab() : undefined}>{(tab) => <ResultCompare tab={tab()} />}</Match>
            <Match when={kind === "er" && state.er}><ErDiagram /></Match>
            <Match when={kind === "schema-compare" && schemaCompare.open}><SchemaCompareView /></Match>
            <Match when={kind === "data-compare" && dataCompare.open}><DataCompareView /></Match>
          </Switch>
        </Show>
      </div>
      <Toasts />
      <ContextMenu />
      <Modals />
    </div>
  );
}

/** A question with more than two answers about a window (closing it): from windows.ts. */
export function WindowAskDialog() {
  return (
    <Show when={windowAsk.current}>
      {(ask) => (
        <Dialog title={ask().title} onClose={() => answerWindow("")} small>
          <p class="dialog-lead">{ask().body}</p>
          <footer>
            <button type="button" class="btn" onClick={() => answerWindow("")}>Cancelar</button>
            <For each={ask().choices}>
              {(choice, index) => (
                <button
                  type="button"
                  class="btn"
                  classList={{ primary: choice.style === "primary", danger: choice.style === "danger" }}
                  ref={(el) => index() === ask().choices.length - 1 && queueMicrotask(() => el.focus())}
                  onClick={() => answerWindow(choice.value)}
                >
                  {choice.label}
                </button>
              )}
            </For>
          </footer>
        </Dialog>
      )}
    </Show>
  );
}
