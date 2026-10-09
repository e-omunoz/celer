import { ArrowDownToLine, BookMarked, CircleHelp, Database, History, MessageSquareWarning, Moon, PanelLeft, PanelRight, Plus, RotateCcw, Search, Settings2, Sparkles, Sun } from "lucide-solid";
import { createEffect, onCleanup, onMount, Show, untrack } from "solid-js";
import { isTauri } from "./api";
import { Mark } from "./brand/Mark";
import { handleGlobalKey, shortcutLabel, withShortcut } from "./commands";
import { openErrorLog } from "./errorLog";
import { openMyReports, openReport } from "./reportStore";
import { trackAltGr } from "./keymap";
import { Inspector } from "./components/Inspector";
import { Modals } from "./components/Modals";
import { ContextMenu, Palette, Toasts } from "./components/Overlays";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { Companion } from "./gib/Companion";
import { Splash } from "./gib/Splash";
import { Onboarding } from "./components/Onboarding";
import { revealWindow, WindowControls } from "./components/WindowControls";
import { PanelApp, WindowAskDialog } from "./components/Windows";
import { gibHere, openNewWindow, panelKind, prepareWindow, startWindows, windowLabel } from "./windows";
import { EngineIcon } from "./icons";
import { loadLibrary } from "./library";
import {
  activeTab,
  boot,
  connColor,
  connectionById,
  formatMs,
  isLightTheme,
  loadIfRestored,
  openConnDialog,
  openMenu,
  openPalette,
  openQuery,
  saveSettings,
  setSplashDone,
  setState,
  state,
  toggleInspector,
  type MenuItem,
} from "./state";
import { engineOf } from "./types";
import { UpdateDialog } from "./components/UpdateDialog";
import { MigrateDialog } from "./components/MigrateDialog";
import { migration, openMigration } from "./migrate";
import { checkForUpdates, setUpdate, startUpdateChecks, update, updateChipVisible } from "./update";

export default function App() {
  // A panel in a window of its own (library, assistant, plan, diagram, comparison).
  if (panelKind) return <PanelApp />;
  // Table tabs restored from the last session load (and connect) the first time they are shown.
  createEffect(() => {
    const id = state.ready ? state.activeTabId : "";
    // Only the active tab is tracked; the load itself must not subscribe this effect to anything else.
    if (id) untrack(() => loadIfRestored(id));
  });
  onMount(() => {
    startWindows();
    // Gib's start-up hop is the main window's; another window starts with him where he is.
    if (windowLabel !== "main") setSplashDone(true);
    void boot().then(() => {
      if (windowLabel === "main") startUpdateChecks();
      // The library early: consoles opened from it show whether they have unsaved changes, and the palette lists it.
      void loadLibrary();
    });
    // Shown once it is where it was last time (and painted).
    void prepareWindow().then(revealWindow);
    // Window in the background: Gib's idle loops pause (App.css, data-focus).
    const focus = () => (document.documentElement.dataset.focus = document.hasFocus() && !document.hidden ? "in" : "out");
    focus();
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    document.addEventListener("visibilitychange", focus);
    onCleanup(() => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      document.removeEventListener("visibilitychange", focus);
    });
    let lastShift = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")) {
        // A page reload would drop results, edits and open transactions.
        if (state.paletteOpen || state.connDialog || state.settingsOpen) event.preventDefault();
      }
      if (state.paletteOpen || state.connDialog || state.settingsOpen) return;
      if (event.key === "Shift" && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const t = performance.now();
        if (t - lastShift < 350) {
          lastShift = 0;
          openPalette("all");
          return;
        }
        lastShift = t;
        return;
      }
      lastShift = 0;
      handleGlobalKey(event);
    };
    window.addEventListener("keydown", onKey);
    const blockMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("input, textarea, .cm-editor")) event.preventDefault();
    };
    window.addEventListener("contextmenu", blockMenu);
    const stopAltGr = trackAltGr(window);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", blockMenu);
      stopAltGr();
    });
  });

  return (
    <div class="app" classList={{ ready: state.ready }}>
      <TopBar />
      <div class="main">
        <nav class="stripe">
          <button type="button" class="stripe-btn" classList={{ on: state.explorerOpen }} title={withShortcut("Explorador", "toggle-explorer")} onClick={() => setState("explorerOpen", !state.explorerOpen)}>
            <Database size={17} />
          </button>
          <button type="button" class="stripe-btn" classList={{ on: state.inspectorOpen && state.inspectorMode === "history" }} title={withShortcut("Historial", "history")} onClick={() => toggleInspector("history")}>
            <History size={17} />
          </button>
          <button type="button" class="stripe-btn" classList={{ on: state.inspectorOpen && state.inspectorMode === "library" }} title={withShortcut("Biblioteca de scripts", "library")} onClick={() => toggleInspector("library")}>
            <BookMarked size={17} />
          </button>
          <button type="button" class="stripe-btn" classList={{ on: state.inspectorOpen && state.inspectorMode === "ai" }} title={withShortcut("Asistente IA", "ai")} onClick={() => toggleInspector("ai")}>
            <Sparkles size={17} />
          </button>
          <span class="spacer" />
          <button type="button" class="stripe-btn" title="Ayuda" onClick={(event) => openMenu(event, helpMenu())}>
            <CircleHelp size={17} />
          </button>
          <button type="button" class="stripe-btn" title={withShortcut("Ajustes", "settings")} onClick={() => setState("settingsOpen", true)}>
            <Settings2 size={17} />
          </button>
        </nav>
        <Show when={state.explorerOpen}>
          <Sidebar />
          <div class="vsplit" onMouseDown={(event) => resize(event, "sidebarWidth", 1)} />
        </Show>
        <Workspace />
        <Show when={state.inspectorOpen}>
          <div class="vsplit" onMouseDown={(event) => resize(event, "inspectorWidth", -1)} />
          <Inspector />
        </Show>
      </div>
      <StatusBar />
      <Toasts />
      <ContextMenu />
      <Palette />
      <Modals />
      <Show when={update.dialogOpen}><UpdateDialog /></Show>
      <Show when={migration.open}><MigrateDialog /></Show>
      <WindowAskDialog />
      <Show when={windowLabel === "main"}><Splash /></Show>
      <Show when={state.onboardingOpen}><Onboarding /></Show>
    </div>
  );
}

/** Ayuda: the guide, shortcuts, reports, the error log, updates and «Acerca de». */
export function helpMenu(): MenuItem[] {
  return [
    { label: "Guía de inicio", run: () => setState("onboardingOpen", true) },
    { label: "Atajos de teclado…", hint: shortcutLabel("shortcuts"), run: () => setState({ settingsOpen: true, settingsSection: "keys" }) },
    { separator: true },
    { label: "Reportar un fallo…", hint: shortcutLabel("report-bug"), run: () => void openReport("bug") },
    { label: "Sugerir una mejora…", hint: shortcutLabel("report-idea"), run: () => void openReport("idea") },
    { label: "Mis reportes", run: () => void openMyReports() },
    { label: "Registro de errores", hint: shortcutLabel("error-log"), run: () => void openErrorLog() },
    { separator: true },
    { label: "Buscar actualizaciones", run: () => void checkForUpdates(true) },
    { label: "Acerca de Celer", run: () => setState("aboutOpen", true) },
  ];
}

function TopBar() {
  return (
    <header class="topbar" data-tauri-drag-region>
      <div class="brand" title="Celer" data-tauri-drag-region>
        <Mark size={18} />
        <span>Celer</span>
      </div>
      <button
        type="button"
        class="top-btn"
        title="Nuevo"
        onClick={(event) =>
          openMenu(event, [
            { label: "Nueva conexión…", hint: "Ctrl+Alt+N", run: () => openConnDialog() },
            { label: "Nueva consola", hint: "Ctrl+Mayús+L", run: () => openQuery(activeTab()?.connId ?? state.connections[0]?.id ?? null) },
            { label: "Nueva ventana", hint: "Ctrl+Mayús+N", run: () => void openNewWindow() },
            { separator: true },
            { label: "Importar conexiones de DBeaver o DbVisualizer…", run: () => void openMigration() },
          ])
        }
      >
        <Plus size={15} /> <span>Nuevo</span>
      </button>
      <span class="spacer" data-tauri-drag-region />
      <button type="button" class="search-trigger" onClick={() => openPalette("all")} title="Buscar en todo (Mayús Mayús)">
        <Search size={14} />
        <span>Buscar tablas, acciones…</span>
        <kbd>⇧⇧</kbd>
      </button>
      <span class="spacer" data-tauri-drag-region />
      <button type="button" class="top-icon" title={isLightTheme() ? "Tema oscuro" : "Tema claro"} onClick={() => void saveSettings({ theme: isLightTheme() ? "dark" : "light" })}>
        <Show when={isLightTheme()} fallback={<Sun size={16} />}><Moon size={16} /></Show>
      </button>
      <button type="button" class="top-icon" classList={{ on: state.explorerOpen }} title={withShortcut("Explorador", "toggle-explorer")} onClick={() => setState("explorerOpen", !state.explorerOpen)}>
        <PanelLeft size={16} />
      </button>
      <button type="button" class="top-icon" classList={{ on: state.inspectorOpen }} title={withShortcut("Panel derecho", "toggle-inspector")} onClick={() => (state.inspectorOpen ? setState("inspectorOpen", false) : toggleInspector("value"))}>
        <PanelRight size={16} />
      </button>
      <WindowControls />
    </header>
  );
}

function StatusBar() {
  const tab = () => activeTab();
  const conn = () => connectionById(tab()?.connId);
  const session = () => (tab()?.connId ? state.sessions[tab()!.connId!] : undefined);
  // A tab's grid statistics only while that tab is active (a grid outside the tabs, such as the data comparison, always).
  const stats = () => {
    const stats = state.gridStats;
    if (!stats?.owner || stats.owner === state.activeTabId || !state.tabs.some((item) => item.id === stats.owner)) return stats;
    return null;
  };
  const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 }));
  return (
    <footer class="statusbar">
      <Show when={conn()} fallback={<span class="st-item muted">{state.connections.length ? "Sin conexión" : "Celer"}</span>}>
        <span class="st-item">
          <EngineIcon kind={conn()!.kind} size={12} server={session()?.serverInfo} />
          <i class="st-dot" style={{ background: session() ? connColor(conn()) : "var(--text-faint)" }} />
          {conn()!.name}
          <Show when={tab()?.database}><span class="muted"> · {tab()!.database}</span></Show>
        </span>
        <Show when={conn()!.production}><span class="tag prod tiny">PROD</span></Show>
        <Show when={session()?.serverInfo}><span class="st-item muted st-server" title={session()!.serverInfo}>{session()!.serverInfo.split("\n")[0]}</span></Show>
      </Show>
      <Show when={tab()?.kind === "sql" && (tab() as { inTransaction: boolean }).inTransaction}>
        <span class="tag warn tiny">TX pendiente</span>
      </Show>
      <span class="spacer" />
      <Show when={stats()}>
        <span class="st-item stats" title="Agregados de la selección">
          {stats()!.cells.toLocaleString()} celdas
          <Show when={stats()!.numeric}>
            <span> · Σ {fmt(stats()!.sum)}</span>
            <span> · x̄ {fmt(stats()!.sum / stats()!.numeric)}</span>
            <span> · mín {fmt(stats()!.min!)}</span>
            <span> · máx {fmt(stats()!.max!)}</span>
          </Show>
          <span> · {stats()!.distinct.toLocaleString()} distintos</span>
        </span>
      </Show>
      <Show when={tab()?.kind === "sql"}>
        <span class="st-item muted">Ln {state.cursorPos.line}, Col {state.cursorPos.col}</span>
      </Show>
      <Show when={tab()?.kind === "sql" && (tab() as { elapsedMs: number | null }).elapsedMs !== null}>
        <span class="st-item muted">{formatMs((tab() as { elapsedMs: number | null }).elapsedMs)}</span>
      </Show>
      <Show when={conn()}><span class="st-item muted">{engineOf(conn()!.kind).label}</span></Show>
      <span class="st-item muted">{isTauri() ? "" : "demo navegador · "}UTF-8</span>
      <button
        type="button"
        class="st-report"
        title="Reportar un fallo o sugerir una mejora"
        onClick={(event) =>
          openMenu(event, [
            { label: "Reportar un fallo…", run: () => void openReport("bug") },
            { label: "Sugerir una mejora…", run: () => void openReport("idea") },
            { label: "Mis reportes", run: () => void openMyReports() },
          ])
        }
      >
        <MessageSquareWarning size={12} />
      </button>
      <Show when={updateChipVisible()}>
        <button
          type="button"
          class="st-update"
          classList={{ ready: update.status === "ready", busy: update.status === "downloading" }}
          title={update.status === "ready" ? "Instalar la actualización y reiniciar Celer" : "Ver la nueva versión"}
          onClick={() => setUpdate({ dialogOpen: true })}
        >
          <Show when={update.status === "ready"} fallback={<ArrowDownToLine size={12} />}><RotateCcw size={12} /></Show>
          <span>
            {update.status === "downloading"
              ? `Descargando ${update.total ? Math.round((update.done / update.total) * 100) : 0}%`
              : update.status === "ready"
                ? "Reiniciar para actualizar"
                : `Celer ${update.info?.latest}`}
          </span>
        </button>
      </Show>
      <Show when={gibHere()}><Companion /></Show>
    </footer>
  );
}

function resize(event: MouseEvent, key: "sidebarWidth" | "inspectorWidth", dir: 1 | -1) {
  event.preventDefault();
  const startX = event.clientX;
  const startW = state.settings[key];
  document.body.classList.add("resizing");
  const move = (ev: MouseEvent) => setState("settings", key, Math.min(640, Math.max(200, startW + (ev.clientX - startX) * dir)));
  const up = () => {
    document.body.classList.remove("resizing");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    void saveSettings({ [key]: state.settings[key] });
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
