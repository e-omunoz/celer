import {
  activeSql,
  activeTab,
  cancelActive,
  closeTab,
  collapseAll,
  commitActive,
  copySchemaForAi,
  contextConnId,
  cycleTab,
  disconnect,
  formatActive,
  gib,
  openConnDialog,
  openInspector,
  openPalette,
  openQuery,
  openScript,
  reloadTableSafe,
  runActive,
  saveScript,
  saveSettings,
  setState,
  startExport,
  state,
  toggleInspector,
} from "./state";
import type { ThemeName } from "./types";
import { askAi } from "./ai";
import { checkForUpdates } from "./update";
import { openMigration } from "./migrate";

export interface Command {
  id: string;
  label: string;
  group: string;
  keys?: string;
  run: () => void;
  enabled?: () => boolean;
}

const THEMES: { id: ThemeName; label: string }[] = [
  { id: "dark", label: "Celer Oscuro" },
  { id: "light", label: "Celer Claro" },
  { id: "darcula", label: "Darcula" },
  { id: "fjord", label: "Fjord" },
  { id: "sand", label: "Sand" },
  { id: "contrast", label: "Alto contraste oscuro" },
  { id: "contrast-light", label: "Alto contraste claro" },
  { id: "system", label: "Seguir al sistema" },
];

export const themeChoices = THEMES;

const sqlOnly = () => activeTab()?.kind === "sql";

export function commands(): Command[] {
  const list: Command[] = [
    { id: "run", label: "Ejecutar sentencia o selección", group: "Consulta", keys: "Ctrl+Intro", run: () => void runActive("statement"), enabled: sqlOnly },
    { id: "run-script", label: "Ejecutar script completo", group: "Consulta", keys: "Ctrl+Mayús+Intro", run: () => void runActive("script"), enabled: sqlOnly },
    { id: "explain", label: "Plan de ejecución (EXPLAIN)", group: "Consulta", keys: "Ctrl+Mayús+E", run: () => void runActive("explain"), enabled: sqlOnly },
    { id: "stop", label: "Detener ejecución", group: "Consulta", keys: "Ctrl+F2", run: () => void cancelActive() },
    { id: "format", label: "Formatear SQL", group: "Consulta", keys: "Ctrl+Alt+L", run: formatActive, enabled: sqlOnly },
    { id: "commit", label: "Commit", group: "Transacción", keys: "Ctrl+Alt+Mayús+C", run: () => void commitActive(false), enabled: () => Boolean(activeSql()?.inTransaction) },
    { id: "rollback", label: "Rollback", group: "Transacción", keys: "Ctrl+Alt+Mayús+R", run: () => void commitActive(true), enabled: () => Boolean(activeSql()?.inTransaction) },
    { id: "export", label: "Exportar resultado…", group: "Consulta", run: () => void startExport(), enabled: sqlOnly },
    { id: "new-console", label: "Nueva consola", group: "Archivo", keys: "Ctrl+Mayús+L", run: () => openQuery(contextConnId()) },
    { id: "new-conn", label: "Nueva conexión…", group: "Archivo", keys: "Ctrl+Alt+N", run: () => openConnDialog() },
    { id: "disconnect", label: "Desconectar", group: "Conexión", run: () => { const id = contextConnId(); if (id) void disconnect(id); }, enabled: () => Boolean(contextConnId() && state.sessions[contextConnId()!]) },
    { id: "disconnect-all", label: "Desconectar todas", group: "Conexión", run: () => void disconnectAll(), enabled: () => Object.keys(state.sessions).length > 0 },
    { id: "import-conns", label: "Importar conexiones de DBeaver o DbVisualizer…", group: "Archivo", run: () => void openMigration() },
    { id: "open", label: "Abrir script…", group: "Archivo", keys: "Ctrl+O", run: () => void openScript() },
    { id: "save", label: "Guardar script…", group: "Archivo", keys: "Ctrl+S", run: () => void saveScript(), enabled: sqlOnly },
    { id: "close-tab", label: "Cerrar pestaña", group: "Ventana", keys: "Ctrl+W", run: () => state.activeTabId && void closeTab(state.activeTabId) },
    { id: "next-tab", label: "Pestaña siguiente", group: "Ventana", keys: "Ctrl+Tab", run: () => cycleTab(1) },
    { id: "prev-tab", label: "Pestaña anterior", group: "Ventana", keys: "Ctrl+Mayús+Tab", run: () => cycleTab(-1) },
    { id: "toggle-explorer", label: "Mostrar u ocultar el explorador", group: "Ventana", keys: "Alt+1", run: () => setState("explorerOpen", !state.explorerOpen) },
    { id: "toggle-inspector", label: "Mostrar u ocultar el panel de valor", group: "Ventana", keys: "Alt+7", run: () => toggleInspector("value") },
    { id: "ai", label: "Asistente IA: preguntar o generar SQL", group: "IA", keys: "Ctrl+Alt+I", run: () => openInspector("ai") },
    { id: "ai-explain", label: "IA: explicar la consulta", group: "IA", run: () => void askAi("explain"), enabled: sqlOnly },
    { id: "ai-fix", label: "IA: corregir el último error", group: "IA", run: () => void askAi("fix"), enabled: () => Boolean(activeSql()?.error) },
    { id: "ai-optimize", label: "IA: optimizar la consulta", group: "IA", run: () => void askAi("optimize"), enabled: sqlOnly },
    { id: "ai-schema", label: "Copiar esquema para IA", group: "IA", run: () => { const id = activeTab()?.connId; if (id) void copySchemaForAi(id); }, enabled: () => Boolean(activeTab()?.connId && state.sessions[activeTab()!.connId!]) },
    { id: "history", label: "Historial de consultas", group: "Ventana", keys: "Ctrl+Alt+E", run: () => openInspector("history") },
    { id: "collapse", label: "Contraer el árbol", group: "Ventana", run: collapseAll },
    { id: "go-table", label: "Ir a tabla…", group: "Navegar", keys: "Ctrl+N", run: () => openPalette("tables") },
    { id: "reload-table", label: "Recargar tabla", group: "Datos", keys: "F5", run: () => { const tab = activeTab(); if (tab?.kind === "table") void reloadTableSafe(tab.id); }, enabled: () => activeTab()?.kind === "table" },
    { id: "settings", label: "Ajustes…", group: "Preferencias", keys: "Ctrl+Alt+S", run: () => setState("settingsOpen", true) },
    { id: "zebra", label: "Filas alternas en la tabla de resultados", group: "Preferencias", run: () => void saveSettings({ zebra: !state.settings.zebra }) },
    { id: "density", label: "Densidad: compacta / cómoda", group: "Preferencias", run: () => void saveSettings({ density: state.settings.density === "compact" ? "comfortable" : "compact" }) },
    { id: "font-up", label: "Aumentar tamaño del editor", group: "Preferencias", keys: "Ctrl++", run: () => void saveSettings({ editorFontSize: Math.min(24, state.settings.editorFontSize + 1) }) },
    { id: "font-down", label: "Reducir tamaño del editor", group: "Preferencias", keys: "Ctrl+-", run: () => void saveSettings({ editorFontSize: Math.max(10, state.settings.editorFontSize - 1) }) },
    { id: "guide", label: "Guía de inicio", group: "Ayuda", run: () => setState("onboardingOpen", true) },
    { id: "gib-tip", label: "Gib: un consejo", group: "Ayuda", run: () => gib("tip"), enabled: () => state.settings.companion !== "off" },
    { id: "gib-play", label: "Gib: haz algo", group: "Ayuda", run: () => gib("show-off"), enabled: () => state.settings.companion !== "off" },
    { id: "about", label: "Acerca de Celer", group: "Ayuda", run: () => setState("aboutOpen", true) },
    { id: "update", label: "Buscar actualizaciones", group: "Ayuda", run: () => void checkForUpdates(true) },
  ];
  for (const theme of THEMES) {
    list.push({ id: `theme-${theme.id}`, label: `Tema: ${theme.label}`, group: "Tema", run: () => void saveSettings({ theme: theme.id }) });
  }
  return list;
}

async function disconnectAll() {
  for (const id of Object.keys(state.sessions)) await disconnect(id);
}

/** Global shortcuts that are not owned by the editor or the grid. */
export function handleGlobalKey(event: KeyboardEvent): boolean {
  // The editor or the grid already handled it (Ctrl+F2, Ctrl+Shift+L in CodeMirror, Ctrl+C in the grid…).
  if (event.defaultPrevented) return false;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const target = event.target as HTMLElement | null;
  const typing = Boolean(target?.closest("input, textarea, select, [contenteditable=true]")) && !target?.closest(".cm-editor");
  const run = (id: string) => {
    const command = commands().find((item) => item.id === id);
    if (!command || (command.enabled && !command.enabled())) return false;
    event.preventDefault();
    command.run();
    return true;
  };
  if (ctrl && event.shiftKey && key === "a") return openWith(event, "actions");
  if (ctrl && !event.shiftKey && key === "k") return openWith(event, "all");
  if (ctrl && !event.shiftKey && !event.altKey && key === "n") return openWith(event, "tables");
  if (ctrl && event.altKey && key === "n") return run("new-conn");
  if (ctrl && event.shiftKey && key === "l") return run("new-console");
  if (ctrl && event.altKey && key === "s") return run("settings");
  if (ctrl && event.altKey && key === "e") return run("history");
  if (ctrl && event.altKey && key === "i") return run("ai");
  if (ctrl && event.altKey && event.shiftKey && key === "c") return run("commit");
  if (ctrl && event.altKey && event.shiftKey && key === "r") return run("rollback");
  if (ctrl && !event.shiftKey && key === "w") return run("close-tab");
  if (ctrl && key === "tab") return run(event.shiftKey ? "prev-tab" : "next-tab");
  if (ctrl && !event.shiftKey && key === "o") return run("open");
  if (ctrl && !event.shiftKey && key === "s") return run("save");
  if (ctrl && key === "f2") return run("stop");
  if (event.altKey && !ctrl && key === "1") return run("toggle-explorer");
  if (event.altKey && !ctrl && key === "7") return run("toggle-inspector");
  // Never let WebView2 reload the page (that would drop results, edits and open transactions).
  if (key === "f5" || (ctrl && key === "r")) {
    event.preventDefault();
    if (key === "f5" && !typing) run("reload-table");
    return true;
  }
  if (ctrl && (key === "+" || key === "=")) return run("font-up");
  if (ctrl && key === "-") return run("font-down");
  return false;
}

function openWith(event: KeyboardEvent, mode: "all" | "actions" | "tables") {
  event.preventDefault();
  openPalette(mode);
  return true;
}
