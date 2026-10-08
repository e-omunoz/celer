import { ArrowDownToLine, Database, History, Moon, PanelLeft, PanelRight, Plus, RotateCcw, Search, Settings2, Sparkles, Sun } from "lucide-solid";
import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { isTauri } from "./api";
import { Mark } from "./brand/Mark";
import { handleGlobalKey } from "./commands";
import { Inspector } from "./components/Inspector";
import { Modals } from "./components/Modals";
import { ContextMenu, Palette, Toasts } from "./components/Overlays";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { Companion } from "./gib/Companion";
import { Splash } from "./gib/Splash";
import { Onboarding } from "./components/Onboarding";
import { revealWindow, WindowControls } from "./components/WindowControls";
import { EngineIcon } from "./icons";
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
  setState,
  state,
  toggleInspector,
} from "./state";
import { engineOf } from "./types";
import { UpdateDialog } from "./components/UpdateDialog";
import { MigrateDialog } from "./components/MigrateDialog";
import { migration, openMigration } from "./migrate";
import { setUpdate, startUpdateChecks, update, updateChipVisible } from "./update";

export default function App() {
  // Table tabs restored from the last session load (and connect) the first time they are shown.
  createEffect(() => {
    if (state.ready && state.activeTabId) loadIfRestored(state.activeTabId);
  });
  onMount(() => {
    void boot().then(startUpdateChecks);
    revealWindow();
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
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", blockMenu);
    });
  });

  return (
    <div class="app" classList={{ ready: state.ready }}>
      <TopBar />
      <div class="main">
        <nav class="stripe">
          <button type="button" class="stripe-btn" classList={{ on: state.explorerOpen }} title="Explorador (Alt+1)" onClick={() => setState("explorerOpen", !state.explorerOpen)}>
            <Database size={17} />
          </button>
          <button type="button" class="stripe-btn" classList={{ on: state.inspectorOpen && state.inspectorMode === "history" }} title="Historial (Ctrl+Alt+E)" onClick={() => toggleInspector("history")}>
            <History size={17} />
          </button>
          <button type="button" class="stripe-btn" classList={{ on: state.inspectorOpen && state.inspectorMode === "ai" }} title="Asistente IA (Ctrl+Alt+I)" onClick={() => toggleInspector("ai")}>
            <Sparkles size={17} />
          </button>
          <span class="spacer" />
          <button type="button" class="stripe-btn" title="Ajustes (Ctrl+Alt+S)" onClick={() => setState("settingsOpen", true)}>
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
      <Splash />
      <Show when={state.onboardingOpen}><Onboarding /></Show>
    </div>
  );
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
      <button type="button" class="top-icon" classList={{ on: state.explorerOpen }} title="Explorador (Alt+1)" onClick={() => setState("explorerOpen", !state.explorerOpen)}>
        <PanelLeft size={16} />
      </button>
      <button type="button" class="top-icon" classList={{ on: state.inspectorOpen }} title="Panel derecho (Alt+7)" onClick={() => (state.inspectorOpen ? setState("inspectorOpen", false) : toggleInspector("value"))}>
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
  const stats = () => state.gridStats;
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
      <Companion />
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
