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
  erSchemaPath,
  formatActive,
  gib,
  gibName,
  gibShows,
  notify,
  openActivity,
  openConnDialog,
  openErDiagram,
  openInspector,
  openPalette,
  openQuery,
  openScript,
  pinResult,
  reloadTableSafe,
  shownResultRef,
  runActive,
  saveScript,
  saveSettings,
  serverOf,
  setState,
  startExport,
  state,
  toggleInspector,
} from "./state";
import type { ThemeName } from "./types";
import { unsupportedReason, type Feature } from "./engineCompat";
import { askAi } from "./ai";
import { checkForUpdates } from "./update";
import { openMigration } from "./migrate";
import { createLibraryFolder, exportLibrary, importLibraryFiles, library, loadLibrary, openRunOn, saveToLibrary, selectedScript, setLibrary, setOnlyCompat, setOnlyConn } from "./library";
import { chordLabel, chordOf, chordsFor, EDITOR_COMMANDS } from "./keymap";
import { resetGibTips } from "./gib/memory";
import { isTauri } from "./api";
import { detachablePanel, detachPanel, openNewWindow, otherFullWindows, quitCeler, raiseWindow, sendTab } from "./windows";
import { windowName } from "./windowModel";
import { pickComparison } from "./resultCompare";
import { openErrorLog } from "./errorLog";
import { openMyReports, openReport } from "./reportStore";
import { focusPanel } from "./focus";
import { openThemeEditor } from "./themeStore";
import { exportConnections, importConnections } from "./connManage";
import { openTestData } from "./testDataRun";

export interface Command {
  id: string;
  label: string;
  group: string;
  keys?: string;
  /** A note shown as a tooltip (palette, shortcut settings), kept out of the name. */
  hint?: string;
  run: () => void;
  enabled?: () => boolean;
  /** Why it does not work on the current engine («No disponible en Informix»): shown greyed instead of failing. */
  unsupported?: () => string | null;
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

/** A feature on the active tab's connection (or the explorer's, for connection commands). */
const missing = (feature: Feature, connId: () => string | null | undefined = () => activeTab()?.connId) => () => {
  const id = connId();
  const conn = state.connections.find((c) => c.id === id);
  return conn ? unsupportedReason(feature, conn.kind, serverOf(conn.id)) : null;
};

export function commands(): Command[] {
  // Gib under the name the user gave him (still found by "Gib").
  const who = gibName() === "Gib" ? "Gib" : `${gibName()} (Gib)`;
  const list: Command[] = [
    { id: "run", label: "Ejecutar sentencia o selección", group: "Consulta", run: () => void runActive("statement"), enabled: sqlOnly },
    { id: "run-script", label: "Ejecutar script completo", group: "Consulta", run: () => void runActive("script"), enabled: sqlOnly },
    { id: "explain", label: "Plan de ejecución (EXPLAIN)", group: "Consulta", run: () => void runActive("explain"), enabled: sqlOnly, unsupported: missing("plan") },
    { id: "explain-analyze", label: "Plan real: ejecuta y mide (EXPLAIN ANALYZE)", group: "Consulta", run: () => void runActive("analyze"), enabled: sqlOnly, unsupported: missing("analyze") },
    { id: "stop", label: "Detener ejecución", group: "Consulta", run: () => void cancelActive() },
    { id: "format", label: "Formatear SQL", group: "Consulta", run: formatActive, enabled: sqlOnly },
    { id: "commit", label: "Commit", group: "Transacción", run: () => void commitActive(false), enabled: () => Boolean(activeSql()?.inTransaction) },
    { id: "rollback", label: "Rollback", group: "Transacción", run: () => void commitActive(true), enabled: () => Boolean(activeSql()?.inTransaction) },
    { id: "export", label: "Exportar resultado…", group: "Consulta", run: () => void startExport(), enabled: sqlOnly },
    { id: "pin-result", label: "Fijar resultado (se conserva al volver a ejecutar)", group: "Consulta", run: () => { const tab = activeSql(); if (tab) pinResult(tab.id); }, enabled: () => { const tab = activeSql(); return Boolean(tab && !tab.activePinned && tab.results[tab.activeResult]?.columns.length); } },
    { id: "compare-result", label: "Comparar resultado con…", group: "Consulta", hint: "Otro resultado de esta consola, de otra (también de otra conexión) o las filas de una tabla abierta", run: () => { const tab = activeSql(); if (tab) pickComparison(tab.id); }, enabled: () => { const tab = activeSql(); return Boolean(tab && shownResultRef(tab)); } },
    { id: "new-console", label: "Nueva consola", group: "Archivo", run: () => openQuery(contextConnId()) },
    { id: "new-conn", label: "Nueva conexión…", group: "Archivo", run: () => openConnDialog() },
    { id: "disconnect", label: "Desconectar", group: "Conexión", run: () => { const id = contextConnId(); if (id) void disconnect(id); }, enabled: () => Boolean(contextConnId() && state.sessions[contextConnId()!]) },
    { id: "activity", label: "Actividad del servidor (sesiones y consultas en curso)", group: "Conexión", run: () => { const id = contextConnId(); if (id) void openActivity(id); }, enabled: () => Boolean(state.connections.some((c) => c.id === contextConnId())), unsupported: missing("activity", contextConnId) },
    { id: "disconnect-all", label: "Desconectar todas", group: "Conexión", run: () => void disconnectAll(), enabled: () => Object.keys(state.sessions).length > 0 },
    { id: "import-conns", label: "Importar conexiones de DBeaver o DbVisualizer…", group: "Archivo", run: () => void openMigration() },
    { id: "import-conns-file", label: "Importar conexiones de un fichero de Celer…", group: "Archivo", run: () => void importConnections() },
    { id: "import-conns-dbeaver", label: "Importar conexiones de DBeaver…", group: "Archivo", run: () => void openMigration("dbeaver") },
    { id: "import-conns-dbvis", label: "Importar conexiones de DbVisualizer…", group: "Archivo", run: () => void openMigration("dbvisualizer") },
    { id: "export-conns", label: "Exportar todas las conexiones…", group: "Archivo", run: () => void exportConnections(), enabled: () => state.connections.length > 0 },
    { id: "open", label: "Abrir script…", group: "Archivo", run: () => void openScript() },
    { id: "save", label: "Guardar script", group: "Archivo", run: () => void saveScript(), enabled: sqlOnly },
    { id: "save-as", label: "Guardar script como…", group: "Archivo", run: () => void saveScript(true), enabled: sqlOnly },
    { id: "close-tab", label: "Cerrar pestaña", group: "Ventana", run: () => state.activeTabId && void closeTab(state.activeTabId) },
    { id: "next-tab", label: "Pestaña siguiente", group: "Ventana", run: () => cycleTab(1) },
    { id: "prev-tab", label: "Pestaña anterior", group: "Ventana", run: () => cycleTab(-1) },
    { id: "toggle-explorer", label: "Mostrar u ocultar el explorador", group: "Ventana", run: () => setState("explorerOpen", !state.explorerOpen) },
    { id: "toggle-inspector", label: "Mostrar u ocultar el panel de valor", group: "Ventana", run: () => toggleInspector("value") },
    { id: "next-panel", label: "Ir al panel siguiente", hint: "Explorador, editor, resultados y panel derecho, por orden", group: "Ventana", run: () => focusPanel(1) },
    { id: "prev-panel", label: "Ir al panel anterior", group: "Ventana", run: () => focusPanel(-1) },
    { id: "ai", label: "Asistente IA: preguntar o generar SQL", group: "IA", run: () => openInspector("ai") },
    { id: "ai-explain", label: "IA: explicar la consulta", group: "IA", run: () => void askAi("explain"), enabled: sqlOnly },
    { id: "ai-fix", label: "IA: corregir el último error", group: "IA", run: () => void askAi("fix"), enabled: () => Boolean(activeSql()?.error) },
    { id: "ai-optimize", label: "IA: optimizar la consulta", group: "IA", run: () => void askAi("optimize"), enabled: sqlOnly },
    { id: "ai-schema", label: "Copiar esquema para IA", group: "IA", run: () => { const id = activeTab()?.connId; if (id) void copySchemaForAi(id); }, enabled: () => Boolean(activeTab()?.connId && state.sessions[activeTab()!.connId!]) },
    { id: "history", label: "Historial de consultas", group: "Ventana", run: () => openInspector("history") },
    { id: "library", label: "Biblioteca de scripts", group: "Ventana", run: () => openInspector("library") },
    { id: "variables", label: "Variables (${nombre}): ver y editar sus valores", group: "Ventana", run: () => openInspector("variables") },
    { id: "save-library", label: "Guardar la consola en la biblioteca (o sus cambios)", group: "Biblioteca", run: () => void saveToLibrary(), enabled: sqlOnly },
    { id: "library-save-new", label: "Guardar la consola en la biblioteca como script nuevo", group: "Biblioteca", run: () => void saveToLibrary(true), enabled: sqlOnly },
    { id: "library-search", label: "Buscar en la biblioteca de scripts", group: "Biblioteca", run: () => { openInspector("library"); void loadLibrary(); setLibrary("focusSearch", library.focusSearch + 1); } },
    { id: "library-only-compat", label: "Biblioteca: solo los scripts compatibles con el motor de la conexión activa (activar o quitar)", group: "Biblioteca", run: () => { openInspector("library"); setOnlyCompat(!library.onlyCompat); } },
    { id: "library-run-on", label: "Ejecutar el script seleccionado de la biblioteca en… (otra conexión o base de datos, o varias)", group: "Biblioteca", run: () => { const script = selectedScript(); if (script) openRunOn(script.id); }, enabled: () => Boolean(selectedScript() && state.connections.length) },
    { id: "library-new-folder", label: "Nueva carpeta en la biblioteca", group: "Biblioteca", run: () => void createLibraryFolder("") },
    { id: "library-import", label: "Importar ficheros .sql a la biblioteca…", group: "Biblioteca", run: () => void importLibraryFiles() },
    { id: "library-export", label: "Exportar toda la biblioteca a .sql…", group: "Biblioteca", run: () => void exportLibrary({ folder: "" }) },
    { id: "library-only-conn", label: "Biblioteca: solo los scripts de la conexión activa (activar o quitar)", group: "Biblioteca", run: () => { openInspector("library"); setOnlyConn(!library.onlyConn); } },
    { id: "collapse", label: "Contraer el árbol", group: "Ventana", run: collapseAll },
    // Several windows (desktop only).
    { id: "new-window", label: "Ventana nueva", hint: "Con su explorador y sus pestañas. Ctrl+Mayús+N hace otra cosa en el explorador (crea una carpeta) y en la rejilla (pone NULL).", group: "Ventana", run: () => void openNewWindow(), enabled: isTauri },
    { id: "tab-new-window", label: "Mover la pestaña a una ventana nueva", group: "Ventana", run: () => void sendTab(state.activeTabId, null), enabled: () => isTauri() && Boolean(activeTab()) },
    { id: "detach-panel", label: "Abrir el panel en su propia ventana (biblioteca, IA, plan, diagrama o comparación)", group: "Ventana", run: () => { const kind = detachablePanel(); if (kind) void detachPanel(kind); }, enabled: () => isTauri() && Boolean(detachablePanel()) },
    { id: "detach-library", label: "Biblioteca de scripts en su propia ventana", group: "Biblioteca", run: () => void detachPanel("library"), enabled: isTauri },
    { id: "detach-ai", label: "Asistente IA en su propia ventana", group: "IA", run: () => void detachPanel("ai"), enabled: isTauri },
    { id: "quit", label: "Salir de Celer (la próxima vez se abren todas las ventanas)", group: "Archivo", run: () => void quitCeler(), enabled: isTauri },
    { id: "go-table", label: "Ir a tabla…", group: "Navegar", run: () => openPalette("tables") },
    { id: "palette", label: "Buscar en todo (tablas y acciones)", group: "Navegar", run: () => openPalette("all") },
    { id: "palette-actions", label: "Buscar una acción", group: "Navegar", run: () => openPalette("actions") },
    { id: "shortcuts", label: "Atajos de teclado…", group: "Preferencias", run: () => setState({ settingsOpen: true, settingsSection: "keys" }) },
    { id: "er-table", label: "Diagrama de relaciones de la tabla", group: "Datos", run: () => { const tab = activeTab(); if (tab?.kind === "table") void openErDiagram(tab.connId, erSchemaPath(tab.connId, tab.obj, tab.database), tab.obj); }, enabled: () => { const tab = activeTab(); return tab?.kind === "table" && tab.obj.kind === "table"; }, unsupported: missing("er") },
    { id: "test-data", label: "Generar datos de prueba", group: "Datos", hint: "Llena la tabla abierta con datos realistas y válidos: insertados, como script o en CSV / JSON", run: () => { const tab = activeTab(); if (tab?.kind === "table") void openTestData(tab.connId, tab.obj); }, enabled: () => { const tab = activeTab(); return tab?.kind === "table" && tab.obj.kind === "table"; } },
    { id: "reload-table", label: "Recargar tabla", group: "Datos", run: () => { const tab = activeTab(); if (tab?.kind === "table") void reloadTableSafe(tab.id); }, enabled: () => activeTab()?.kind === "table" },
    { id: "settings", label: "Ajustes…", group: "Preferencias", run: () => setState("settingsOpen", true) },
    { id: "theme-editor", label: "Editor de tema…", group: "Tema", run: () => openThemeEditor("") },
    { id: "zebra", label: "Filas alternas en la tabla de resultados", group: "Preferencias", run: () => void saveSettings({ zebra: !state.settings.zebra }) },
    { id: "density", label: "Densidad: compacta / cómoda", group: "Preferencias", run: () => void saveSettings({ density: state.settings.density === "compact" ? "comfortable" : "compact" }) },
    { id: "font-up", label: "Aumentar tamaño del editor", group: "Preferencias", run: () => void saveSettings({ editorFontSize: Math.min(24, state.settings.editorFontSize + 1) }) },
    { id: "font-down", label: "Reducir tamaño del editor", group: "Preferencias", run: () => void saveSettings({ editorFontSize: Math.max(10, state.settings.editorFontSize - 1) }) },
    { id: "guide", label: "Guía de inicio", group: "Ayuda", run: () => setState("onboardingOpen", true) },
    { id: "gib-tip", label: `${who}: un consejo`, group: "Ayuda", run: () => gib("tip"), enabled: () => gibShows("companion") },
    { id: "gib-play", label: `${who}: haz algo`, group: "Ayuda", run: () => gib("show-off"), enabled: () => gibShows("companion") },
    { id: "gib-reset", label: `${who}: volver a contar los consejos desde el principio`, group: "Ayuda", run: () => { resetGibTips(); notify(`${gibName()} volverá a darte sus consejos`, "success", "Los que ya viste cuentan como nuevos."); } },
    { id: "error-log", label: "Registro de errores", hint: "Lo que ha fallado en este equipo, sin datos ni contraseñas. No se envía a ningún sitio.", group: "Ayuda", run: () => void openErrorLog() },
    { id: "report-bug", label: "Reportar un fallo…", hint: "Prepara un issue para GitHub; ves exactamente lo que se envía antes de abrirlo.", group: "Ayuda", run: () => void openReport("bug") },
    { id: "report-idea", label: "Sugerir una mejora…", group: "Ayuda", run: () => void openReport("idea") },
    { id: "my-reports", label: "Mis reportes (borradores y enviados)", group: "Ayuda", run: () => void openMyReports() },
    { id: "about", label: "Acerca de Celer", group: "Ayuda", run: () => setState("aboutOpen", true) },
    { id: "update", label: "Buscar actualizaciones", group: "Ayuda", run: () => void checkForUpdates(true) },
  ];
  for (const theme of THEMES) {
    list.push({ id: `theme-${theme.id}`, label: `Tema: ${theme.label}`, group: "Tema", run: () => void saveSettings({ theme: theme.id }) });
  }
  for (const theme of state.settings.customThemes) {
    list.push({ id: `theme-custom-${theme.id}`, label: `Tema: ${theme.name}`, hint: "Tema propio", group: "Tema", run: () => void saveSettings({ theme: `custom:${theme.id}` }) });
  }
  // The other windows open now ("window:" commands are not offered for shortcuts: the windows come and go).
  for (const w of otherFullWindows()) {
    const name = windowName(w.label);
    list.push({ id: `window:go:${w.label}`, label: `Ir a ${name}${w.title ? ` (${w.title})` : ""}`, group: "Ventana", run: () => void raiseWindow(w.label) });
    list.push({ id: `window:move:${w.label}`, label: `Mover la pestaña a ${name}`, group: "Ventana", run: () => void sendTab(state.activeTabId, w.label), enabled: () => Boolean(activeTab()) });
  }
  const user = state.settings.keymap;
  for (const command of list) {
    const first = chordsFor(command.id, user)[0];
    if (first) command.keys = chordLabel(first);
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
  // The target can be the window or the document (keys sent to the window): only elements have closest().
  const target = event.target instanceof Element ? event.target : null;
  const typing = Boolean(target?.closest("input, textarea, select, [contenteditable=true]")) && !target?.closest(".cm-editor");
  const chord = chordOf(event);
  if (!chord) return false;
  // Shortcuts that only make sense away from a text field (F5 reloads a table, not while typing).
  const bound = commandForChord(chord);
  if (bound && !(EDITOR_SET.has(bound.id)) && !(typing && bound.id === "reload-table")) {
    if (!bound.enabled || bound.enabled()) {
      event.preventDefault();
      const unsupported = bound.unsupported?.();
      if (unsupported) notify(`${bound.label}: ${unsupported.charAt(0).toLowerCase()}${unsupported.slice(1)}`, "info");
      else bound.run();
      return true;
    }
  }
  // Never let WebView2 reload the page (that would drop results, edits and open transactions).
  if (key === "f5" || (ctrl && key === "r")) {
    event.preventDefault();
    return true;
  }
  return false;
}

const EDITOR_SET = new Set<string>(EDITOR_COMMANDS);

/** The command a chord runs (the user's shortcuts first, then the defaults of the commands left untouched). */
export function commandForChord(chord: string): Command | undefined {
  const user = state.settings.keymap;
  return commands().find((command) => chordsFor(command.id, user).includes(chord));
}

/** The shortcut of a command as shown in menus and tooltips ("Ctrl+Mayús+E"), or "" when it has none. */
export function shortcutLabel(id: string): string {
  const first = chordsFor(id, state.settings.keymap)[0];
  return first ? chordLabel(first) : "";
}

/** "Label (Ctrl+…)" for a tooltip. */
export function withShortcut(label: string, id: string): string {
  const keys = shortcutLabel(id);
  return keys ? `${label} (${keys})` : label;
}
