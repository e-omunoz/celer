import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { raw } from "./raw";
import { busy, endBusy, nextPaint, startBusy, updateBusy } from "./busy";
import { cellText, codeOnly, exportStatement, firstKeyword, formatSql, rowsLabel, isMutating, needsProductionConfirm, splitSql, statementAt, wherePosition } from "./sql";
import type {
  Cell,
  ColumnInfo,
  CompletionSchema,
  ConnConfig,
  ConnSummary,
  ConnTestReport,
  DbKind,
  HistoryEntry,
  InformixDrivers,
  MetaNode,
  ObjectRef,
  ResultSet,
  Settings,
  TableColumn,
  ThemeName,
} from "./types";
import { defaultSettings, emptyConn, engineOf } from "./types";
import { binaryKeysWritable, changeStatements, explainPrefix, paramNamesFor, selectLimit, upsertSql, whereOf } from "./sqlgen";
import { bindParams, findParams, hasUnfilteredWrite, paramNames } from "./snippets";
import { erNeighbourhood, erNeighbours, type ErEdge, type ErTable } from "./erLayout";
import { parseMssqlPlan, parseMysqlPlan, parsePostgresPlan, parseSqlitePlan, parseSynapsePlan, type Plan } from "./plan";
import { activitySpec, readSessions, synapseDedicated, type ServerSession } from "./activity";
import type { AiMessage } from "./ai";
import { insertAt } from "./windowModel";
import { forwardFromPanel, forwardGib, gibHere, isPanelWindow, otherFullWindows, raisePanel, restoreWindowLayout, saveWindowLayout } from "./windows";
import { libraryDirty } from "./library";
import { RECOVERED_PREFIX, connLink, connectTimeText, markConn, markTab, tabLink } from "./connStatus";
import { startConnWatch } from "./connWatch";
import { labelColorOn } from "./contrast";
import type { ColumnOrder } from "./columnOrder";

export type InspectorMode = "value" | "record" | "history" | "library" | "ai";

export interface OutputEntry {
  at: number;
  sql: string;
  ok: boolean;
  text: string;
  elapsedMs: number | null;
}

export interface SqlTab {
  id: string;
  kind: "sql";
  title: string;
  connId: string | null;
  sessionId: string | null;
  database: string;
  serverInfo: string;
  sql: string;
  cursor: number;
  selection: string;
  revision: number;
  results: ResultSet[];
  /** Index into results; -1 shows the Output log. */
  activeResult: number;
  messages: string[];
  output: OutputEntry[];
  error: string;
  elapsedMs: number | null;
  startedAt: number | null;
  running: boolean;
  inTransaction: boolean;
  autocommit: boolean;
  completion: CompletionSchema | null;
  lastSql: string;
  /** Increments on every successful run; the grid resets only when this changes (not when pages arrive). */
  runId: number;
  /** The SQL that produced the current results (lastSql may be a later run that failed). */
  resultsSql: string;
  /** The .sql file the console was opened from or saved to (Ctrl+S writes there), and its encoding. */
  filePath?: string;
  fileEncoding?: string;
  /** The file's line endings, written back on save (the editor works with \n). */
  fileCrlf?: boolean;
  /** The file's text as last read or written (\n line endings): the console has unsaved changes when it differs. */
  fileSaved?: string;
  /** The script library entry the console was opened from (saving to the library updates it). */
  libraryId?: string;
  /** The last execution plan (Ctrl+Shift+E), shown in its own result tab. */
  plan: { plan: Plan; sql: string } | null;
  activePlan: boolean;
  /** Results kept aside with the pin button: they survive the next runs until closed. */
  pinned: PinnedResult[];
  /** The pinned result on show instead of the current ones (null: the current ones). */
  activePinned: string | null;
  /** A pinned result compared with the current one (key: columns that match rows; null: guessed). */
  compare: { pinId: string; key: string[] | null } | null;
  /** Opened by an assistant through MCP (#100): when, and who ("claude-code · WSL (Ubuntu)"). Not saved. */
  aiOpenedAt?: number;
  aiClient?: string;
}

export interface PinnedResult {
  id: string;
  title: string;
  sql: string;
  at: number;
  result: ResultSet;
}

export interface TableTab {
  id: string;
  kind: "table";
  title: string;
  connId: string;
  sessionId: string;
  database: string;
  obj: ObjectRef;
  qualified: string;
  baseSelect: string;
  quoted: string[];
  section: "data" | "columns" | "indexes" | "keys" | "ddl";
  columnsMeta: TableColumn[];
  gridCols: ColumnInfo[];
  rows: Cell[][];
  hasMore: boolean;
  ddl: string;
  indexes: MetaNode[];
  keys: MetaNode[];
  loading: boolean;
  error: string;
  /** Where the error points inside the user's WHERE text (null when it is elsewhere or unknown). */
  errorAt: number | null;
  where: string;
  orderBy: string;
  filters: ColumnFilter[];
  sort: { col: number; dir: 1 | -1 } | null;
  totalCount: number | null;
  counting: boolean;
  elapsedMs: number | null;
  edits: Record<string, string | null>;
  deleted: number[];
  inserts: (string | null)[][];
  /** Restored from the last session and not loaded yet: it loads (and connects) when it is first shown. */
  restored?: boolean;
  /** Opened by an assistant through MCP (#100): when, and who. Not saved. */
  aiOpenedAt?: number;
  aiClient?: string;
}

export type Tab = SqlTab | TableTab;

export type FilterOp =
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  | "contains" | "not-contains" | "starts" | "ends"
  | "null" | "not-null" | "empty" | "between" | "in" | "not-in";

export interface ColumnFilter {
  id: string;
  col: string;
  op: FilterOp;
  value: string;
  value2: string;
  values: string[];
  enabled: boolean;
}

export const FILTER_OPS: { op: FilterOp; label: string; short: string; kinds?: ColumnInfo["kind"][]; arity: 0 | 1 | 2 | "list" }[] = [
  { op: "eq", label: "es igual a", short: "=", arity: 1 },
  { op: "ne", label: "es distinto de", short: "≠", arity: 1 },
  { op: "contains", label: "contiene", short: "contiene", kinds: ["text", "other"], arity: 1 },
  { op: "not-contains", label: "no contiene", short: "no contiene", kinds: ["text", "other"], arity: 1 },
  { op: "starts", label: "empieza por", short: "empieza por", kinds: ["text", "other"], arity: 1 },
  { op: "ends", label: "termina en", short: "termina en", kinds: ["text", "other"], arity: 1 },
  { op: "gt", label: "mayor que", short: ">", kinds: ["number", "date", "text", "other"], arity: 1 },
  { op: "gte", label: "mayor o igual que", short: "≥", kinds: ["number", "date", "text", "other"], arity: 1 },
  { op: "lt", label: "menor que", short: "<", kinds: ["number", "date", "text", "other"], arity: 1 },
  { op: "lte", label: "menor o igual que", short: "≤", kinds: ["number", "date", "text", "other"], arity: 1 },
  { op: "between", label: "entre", short: "entre", kinds: ["number", "date", "text", "other"], arity: 2 },
  { op: "in", label: "es uno de", short: "en", arity: "list" },
  { op: "not-in", label: "no es ninguno de", short: "no en", arity: "list" },
  { op: "null", label: "es NULL", short: "es NULL", arity: 0 },
  { op: "not-null", label: "no es NULL", short: "no es NULL", arity: 0 },
  { op: "empty", label: "está vacío", short: "vacío", kinds: ["text", "other"], arity: 0 },
];

interface TreeEntry {
  open: boolean;
  status: "loading" | "ready" | "error";
  nodes: MetaNode[];
  error?: string;
}

interface ConnSession {
  metaId: string;
  database: string;
  serverInfo: string;
  databases: string[];
  connecting?: boolean;
}

export interface SavedSqlTab {
  id: string;
  kind: "sql";
  title: string;
  connId: string | null;
  sql: string;
  database: string;
  cursor?: number;
  autocommit?: boolean;
  filePath?: string;
  fileEncoding?: string;
  fileCrlf?: boolean;
  /** The file's text as last read or written, kept only when the console differs from it. */
  fileSaved?: string;
  libraryId?: string;
}

export interface SavedTableTab {
  id: string;
  kind: "table";
  title: string;
  connId: string;
  database: string;
  obj: ObjectRef;
  section: TableTab["section"];
  where: string;
  orderBy: string;
  filters: ColumnFilter[];
  sort: TableTab["sort"];
}

/** A tab as workspace.json keeps it (one list per window, see windowModel.ts). */
export type SavedTab = SavedSqlTab | SavedTableTab;

export interface MenuItem {
  label?: string;
  hint?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error" | "warning";
  text: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface InspectValue {
  column: string;
  typeName: string;
  value: Cell;
}

export interface RecordView {
  columns: ColumnInfo[];
  row: Cell[];
  index: number;
}

export interface GridStats {
  cells: number;
  rows: number;
  numeric: number;
  sum: number;
  min: number | null;
  max: number | null;
  distinct: number;
  /** The grid's busyKey (its tab id): the status bar shows them only while that tab is active. */
  owner?: string;
}

/**
 * The state of this window. Every Celer window (windows.ts) is its own page with its own copy of this store, split
 * in two:
 * - shared by every window: the saved connections and the settings (theme and shortcuts included). The core owns
 *   them; a change is sent to the core, which writes the file and tells the other windows (windows.ts);
 * - this window's own: its tabs and their sessions, its explorer (the connections it opened), its panels, focus,
 *   dialogs and the typed passwords it was given.
 */
export const [state, setState] = createStore({
  // ---- shared by every window (mirrored from the core)
  connections: [] as ConnSummary[],
  settings: { ...defaultSettings } as Settings,
  appInfo: { version: "", dataDir: "" },
  driverPath: null as string | null,
  // ---- this window's own
  sessions: {} as Record<string, ConnSession>,
  connecting: {} as Record<string, boolean>,
  catalog: {} as Record<string, { database: string; tables: CompletionSchema["tables"] }>,
  passwords: {} as Record<string, string>,
  tree: {} as Record<string, TreeEntry>,
  treeFilter: "",
  treeSelected: "",
  tabs: [] as Tab[],
  activeTabId: "",
  explorerOpen: true,
  inspectorOpen: false,
  inspectorMode: "value" as InspectorMode,
  ai: { messages: [] as AiMessage[], running: false, hasKey: false, needsKey: false },
  historyQuery: "",
  history: [] as HistoryEntry[],
  settingsOpen: false,
  /** The settings section shown when the dialog opens (commands can open a given one). */
  settingsSection: "appearance" as string,
  /** A shortcut is being recorded: every key goes to the recorder (Esc included). */
  capturingKeys: false,
  connDialog: null as ConnConfig | null,
  testOutput: "",
  testOk: null as boolean | null,
  testing: false,
  exportOpen: false,
  exportFormat: "csv" as ExportFormat,
  exportSource: null as ExportSource | null,
  exportId: "",
  exportOpts: { delimiter: ",", header: true, bom: true, nullText: "", tableName: "", sqlBatch: 100 },
  exportPath: "",
  exportRows: 0,
  exportRunning: false,
  inspect: null as InspectValue | null,
  record: null as RecordView | null,
  previewSql: "",
  previewRun: null as (() => Promise<void>) | null,
  toasts: [] as Toast[],
  driverProgress: "",
  /** A driver download in progress (it can be cancelled). */
  driverDownload: null as { what: string; done: number; total: number } | null,
  /** Settings › Drivers: what Informix can connect with on this machine. */
  informixDrivers: null as InformixDrivers | null,
  /** A JDBC connection lacks Java or the driver: what is missing, and what to retry once it is downloaded. */
  jdbcSetup: null as { missing: ("java" | "jdbc")[]; text: string; retry: (() => void) | null } | null,
  /** The Informix drivers guide, open on a topic (jdbc, sdk, drda, locale, server), with the error that led there. */
  informixGuide: null as { topic: string; message: string } | null,
  /** "Probar conexión" failed with something the guide explains: its topic. */
  testGuide: "",
  /** "Probar conexión": every step with its time, the way it connected and, if it failed, what to do. */
  testReport: null as ConnTestReport | null,
  confirm: null as { title: string; body: string; confirmLabel: string; danger: boolean; run: () => void } | null,
  passwordAsk: null as { name: string; resolve: (value: string | null) => void } | null,
  /** Values for the parameters of the statement about to run (:name, ?, ${name}). */
  paramAsk: null as ParamAsk | null,
  /** The entity-relationship diagram on show (a schema's tables and their foreign keys). */
  er: null as ErState | null,
  /** Server activity monitor on show: the sessions of a server and what they run. */
  activity: null as ActivityState | null,
  paletteOpen: false,
  paletteMode: "all" as "all" | "actions" | "tables",
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
  gridStats: null as GridStats | null,
  cursorPos: { line: 1, col: 1 },
  aboutOpen: false,
  onboardingOpen: false,
  ready: false,
});

export const [resolvedTheme, setResolvedTheme] = createSignal<Exclude<ThemeName, "system">>("dark");

/** Things Gib reacts to. The companion decides how (mood, tip, nothing). */
export interface GibEvent {
  type: "query-ok" | "query-error" | "connected" | "connect-failed" | "commit" | "rollback" | "saved" | "mouse-run" | "running" | "tip" | "show-off";
  at: number;
  ms?: number;
  detail?: string;
  production?: boolean;
  hasMore?: boolean;
  /** query-ok: columns of the first result with a grid, and the engine (for Gib's advice about the statement). */
  columns?: number;
  kind?: string;
}
export const [gibEvent, setGibEvent] = createSignal<GibEvent | null>(null);
export function gib(type: GibEvent["type"], extra: Omit<GibEvent, "type" | "at"> = {}) {
  const event: GibEvent = { type, at: Date.now(), ...extra };
  // Gib lives in one window: the others tell him what happened there.
  if (!gibHere()) forwardGib(event);
  else setGibEvent(event);
}
/** False while the startup animation plays; the companion appears when Gib lands. */
export const [splashDone, setSplashDone] = createSignal(false);
export const [now, setNow] = createSignal(Date.now());

let toastId = 0;
let saveTimer = 0;
let confirmResolve: ((value: boolean) => void) | null = null;

window.setInterval(() => {
  if (state.tabs.some((tab) => (tab.kind === "sql" && tab.running) || (tab.kind === "table" && tab.loading))) setNow(Date.now());
}, 100);

export function notify(text: string, kind: Toast["kind"] = "info", detail?: string, action?: Toast["action"]) {
  const id = ++toastId;
  setState("toasts", (list) => [...list.slice(-3), { id, kind, text, detail, action }]);
  window.setTimeout(() => dismissToast(id), kind === "error" || action ? 9000 : 4500);
}

export function dismissToast(id: number) {
  setState("toasts", (list) => list.filter((toast) => toast.id !== id));
}

export function pathKey(connId: string, path: string[]) {
  return `${connId}\u0000${path.join("\u0000")}`;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function patchTab(id: string, patch: Record<string, unknown>) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  setState("tabs", index, patch as Partial<Tab>);
}

export function activeTab(): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

export function activeSql(): SqlTab | undefined {
  const tab = activeTab();
  return tab?.kind === "sql" ? tab : undefined;
}

export function connectionById(id: string | null | undefined) {
  return state.connections.find((conn) => conn.id === id);
}

/** Connection of the explorer selection, falling back to the active tab, then the first connection. */
export function contextConnId(): string | null {
  const key = state.treeSelected;
  if (key.startsWith("c:") || key.startsWith("f:")) return key.slice(2);
  if (key.startsWith("n:")) return key.slice(2).split("\u0000")[0] || null;
  return activeTab()?.connId ?? state.connections[0]?.id ?? null;
}

/** Server banner of a connection: live when connected, otherwise the last one seen (to show the right logo). */
export function serverOf(connId: string | null | undefined): string {
  if (!connId) return "";
  const live = state.sessions[connId]?.serverInfo;
  if (live) return live;
  try {
    return localStorage.getItem(`celer.server.${connId}`) ?? "";
  } catch {
    return "";
  }
}

export function kindOf(connId: string | null | undefined): DbKind {
  return connectionById(connId)?.kind ?? "sqlite";
}

function tabIndex(id: string) {
  return state.tabs.findIndex((tab) => tab.id === id);
}

export function connColor(conn: ConnSummary | undefined) {
  if (!conn) return "var(--text-faint)";
  if (conn.production) return "var(--danger)";
  return conn.color || engineOf(conn.kind).color;
}

// ---------------------------------------------------------------- theme

const LIGHT_THEMES = new Set(["light", "sand", "contrast-light"]);

export function applyTheme(settings: Settings = state.settings, preview?: ThemeName) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const chosen = preview ?? settings.theme;
  const theme = chosen === "system" ? (dark ? "dark" : "light") : chosen;
  setResolvedTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = settings.density;
  root.dataset.motion = reducedMotion(settings) ? "reduce" : "full";
  root.style.setProperty("--accent", settings.accent);
  // White on Clay, Ember, Teal or Green is below 4.5:1: those buttons get a black label.
  root.style.setProperty("--accent-fg", labelColorOn(settings.accent));
  root.style.fontSize = `${settings.fontSize}px`;
  if (isTauri()) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(LIGHT_THEMES.has(theme) ? "light" : "dark"))
      .catch(() => {});
  }
}

/** Animations kept to a minimum: the in-app setting, or the system's when it says "follow the system". */
export function reducedMotion(settings: Settings = state.settings) {
  if (settings.motion === "reduce") return true;
  if (settings.motion === "full") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isLightTheme() {
  return LIGHT_THEMES.has(resolvedTheme());
}

// ---------------------------------------------------------------- boot

export async function boot() {
  try {
    const loaded = await api().loadJson("settings");
    if (loaded && typeof loaded === "object") {
      setState("settings", { ...defaultSettings, ...(loaded as Settings) });
    }
  } catch (err) {
    // Defaults this time (a damaged file was set aside, or it could not be read: the message says which). One
    // that is still there is not written over by this session's changes.
    const message = errorText(err);
    if (!message.includes(".unreadable-")) settingsUnreadable = true;
    notify("No se pudieron leer los ajustes: se usan los de serie", "error", message);
  }
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.theme === "system") applyTheme();
  });
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => {
    if (state.settings.motion === "system") applyTheme();
  });
  let connectionsLoaded = false;
  try {
    setState("connections", await api().listConnections());
    connectionsLoaded = true;
    const problem = await api().connectionsProblem();
    if (problem) notify("Problema al leer las conexiones guardadas", "error", problem);
    setState("appInfo", await api().appInfo());
    setState("driverPath", await api().ibmDriverStatus());
  } catch (err) {
    notify(errorText(err), "error");
  }
  // This window's tabs: the main one's from workspace.json (and the other windows open again), a new window's from
  // the window that opened it.
  await restoreWindowLayout(connectionsLoaded);
  setState("ready", true);
  startConnWatch();
  void api().onExportProgress((progress) => {
    if (state.exportRunning) setState("exportRows", progress.rows);
  });
  void api().onDriverDownload((progress) => {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    setState("driverProgress", progress.total ? `${pct}%` : `${progress.done} bytes`);
    if (state.driverDownload) setState("driverDownload", { what: progress.what || state.driverDownload.what, done: progress.done, total: progress.total });
  });
}

/**
 * Puts saved tabs in this window: tables of connections that no longer exist are dropped (`known`), the rest load
 * when first shown.
 */
export function restoreTabs(saved: SavedTab[], activeTabId: string, known: (connId: string | null) => boolean) {
  const tabs = saved
    .filter((tab) => tab.kind !== "table" || known(tab.connId))
    .map((tab): Tab =>
      tab.kind === "table"
        ? { ...blankTable(tab.id, tab.connId, tab.obj, "", tab.database, tab.section, tab.filters ?? []), where: tab.where ?? "", orderBy: tab.orderBy ?? "", sort: tab.sort ?? null, loading: false, restored: true }
        : {
            ...blankSql(tab.id, tab.connId, tab.sql, tab.title),
            database: tab.database ?? "",
            cursor: Math.min(tab.cursor ?? tab.sql.length, tab.sql.length),
            autocommit: tab.autocommit ?? true,
            filePath: tab.filePath,
            fileEncoding: tab.fileEncoding,
            fileCrlf: tab.fileCrlf,
            fileSaved: tab.filePath ? (tab.fileSaved ?? tab.sql) : undefined,
            libraryId: tab.libraryId,
          },
    );
  if (!tabs.length) return;
  setState("tabs", [...state.tabs, ...tabs]);
  setState("activeTabId", state.tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (state.tabs[0]?.id ?? ""));
}

/** The title of a console with no connection yet; it takes the connection's name when one is picked. */
export const CONSOLE_TITLE = "consola";

/** Still the placeholder title ("console" is what tabs saved by earlier versions have). */
export function isDefaultConsoleTitle(title: string) {
  return title === CONSOLE_TITLE || title === "console";
}

export function blankSql(id: string, connId: string | null = null, sql = "", title = CONSOLE_TITLE): SqlTab {
  return {
    id,
    kind: "sql",
    title,
    connId,
    sessionId: null,
    database: "",
    serverInfo: "",
    sql,
    cursor: sql.length,
    selection: "",
    revision: 0,
    results: [],
    activeResult: -1,
    messages: [],
    output: [],
    error: "",
    elapsedMs: null,
    startedAt: null,
    running: false,
    inTransaction: false,
    autocommit: true,
    completion: null,
    lastSql: "",
    runId: 0,
    resultsSql: "",
    plan: null,
    activePlan: false,
    pinned: [],
    activePinned: null,
    compare: null,
  };
}

function blankTable(id: string, connId: string, obj: ObjectRef, sessionId: string, database: string, section: TableTab["section"] = "data", filters: ColumnFilter[] = []): TableTab {
  return {
    id,
    kind: "table",
    title: obj.name,
    connId,
    sessionId,
    database,
    obj,
    qualified: obj.name,
    baseSelect: "",
    quoted: [],
    section,
    columnsMeta: [],
    gridCols: [],
    rows: [],
    hasMore: false,
    ddl: "",
    indexes: [],
    keys: [],
    loading: true,
    error: "",
    errorAt: null,
    where: "",
    orderBy: "",
    filters,
    sort: null,
    totalCount: null,
    counting: false,
    elapsedMs: null,
    edits: {},
    deleted: [],
    inserts: [],
  };
}

/** A table tab restored from the last session loads (connecting if needed) the first time it is shown. */
export function loadIfRestored(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (tab?.kind !== "table" || !tab.restored) return;
  patchTab(tabId, { restored: false });
  void reloadTable(tabId, true);
}

export function persistSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistNow, 400);
}

/** This window's tabs as workspace.json keeps them. */
export function savedTabs(): SavedTab[] {
  return state.tabs.map(
    (tab): SavedTab =>
      tab.kind === "sql"
        ? { id: tab.id, kind: "sql", title: tab.title, connId: tab.connId, sql: tab.sql, database: tab.database, cursor: tab.cursor, autocommit: tab.autocommit, filePath: tab.filePath, fileEncoding: tab.fileEncoding, fileCrlf: tab.fileCrlf, fileSaved: tab.filePath && tab.fileSaved !== tab.sql ? tab.fileSaved : undefined, libraryId: tab.libraryId }
        : { id: tab.id, kind: "table", title: tab.title, connId: tab.connId, database: tab.database, obj: tab.obj, section: tab.section, where: tab.where, orderBy: tab.orderBy, filters: tab.filters, sort: tab.sort },
  );
}

/** Writes this window's part of the workspace file right away (used before the window closes). */
export function persistNow() {
  window.clearTimeout(saveTimer);
  return saveWindowLayout();
}

/** Before the window closes: warn about open transactions and unsaved table edits, then save the workspace. */
export async function beforeClose(): Promise<boolean> {
  const tx = state.tabs.filter((tab) => tab.kind === "sql" && tab.inTransaction).length;
  const dirty = state.tabs.filter((tab) => tab.kind === "table" && tableDirty(tab)).length;
  if (tx || dirty) {
    const parts = [tx ? `${tx} ${tx === 1 ? "consola con una transacción abierta (se deshará)" : "consolas con transacciones abiertas (se desharán)"}` : "", dirty ? `${dirty} ${dirty === 1 ? "tabla con cambios sin guardar" : "tablas con cambios sin guardar"}` : ""].filter(Boolean);
    const ok = await confirmDialog("¿Cerrar Celer?", `Hay ${parts.join(" y ")}.`, "Cerrar de todos modos", true);
    if (!ok) return false;
  }
  await persistNow().catch(() => {});
  return true;
}

/** settings.json could not be read at start-up but is still there: changes apply only to this session. */
let settingsUnreadable = false;

export async function saveSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch };
  setState("settings", settings);
  applyTheme(settings);
  if (settingsUnreadable) {
    notify("Los ajustes no se guardan en esta sesión: no se pudo leer el fichero que ya había", "warning");
    return;
  }
  // Only what changed: the core merges it into settings.json and tells the other windows, so two windows changing
  // different settings at once do not undo each other.
  await api().saveJson("settings", patch, true);
}

/** Settings changed by another window (the core sends the whole file). */
export function applySharedSettings(value: Partial<Settings>) {
  setState("settings", { ...defaultSettings, ...value });
  applyTheme();
}

// ---------------------------------------------------------------- connections

export function askPassword(name: string) {
  return new Promise<string | null>((resolve) => setState("passwordAsk", { name, resolve }));
}

export interface ErState {
  connId: string;
  title: string;
  /** The schema's path in the explorer (to read it whole from the diagram of one table). */
  path: string[];
  loading: boolean;
  done: number;
  total: number;
  error: string;
  /** More tables than the diagram read (it stops at ER_LIMIT, or ER_SCAN_LIMIT around one table). */
  truncated: number;
  /** Tables with their columns read: all of them for the whole schema, those shown so far around one table. */
  tables: ErTable[];
  /** Foreign keys of the tables read (around one table: of every table of the schema, to find who points to it). */
  edges: ErEdge[];
  /** Where each diagram table comes from, to open it. */
  objects: Record<string, ObjectRef>;
  /** The diagram of one table: its id ("" for the whole schema) and the tables on show around it. */
  focus: string;
  shown: string[];
  /** Every table of the schema (up to ER_LIMIT) has its columns read: going back to the whole schema needs no reading. */
  whole: boolean;
}

const ER_LIMIT = 250;
/** Around one table only the keys of each table are read (one query, not two): many more tables fit. */
const ER_SCAN_LIMIT = 2000;
let erToken = 0;

const erId = (obj: { schema: string; name: string }) => `${obj.schema}.${obj.name}`;

/** The path openErDiagram takes for a table's schema: [database, schema], or [database] on Informix and ODBC. */
export function erSchemaPath(connId: string, obj: ObjectRef, database = ""): string[] {
  const db = obj.database || database || "main";
  const kind = kindOf(connId);
  return kind === "informix" || kind === "odbc" ? [db] : [db, obj.schema || "main"];
}

function erTable(obj: ObjectRef, columns: TableColumn[], fkCols: Set<string>): ErTable {
  return { id: erId(obj), name: obj.name, schema: obj.schema, columns: columns.map((c) => ({ name: c.name, type: c.typeName, pk: c.primaryKey, fk: fkCols.has(c.name), nullable: c.nullable })) };
}

/**
 * Loads the tables of a schema (path [database, schema], or [database] on engines without schemas) with their
 * columns and foreign keys, on a side session, and shows the diagram as it arrives. With `focus`, the diagram of
 * that table and the tables its foreign keys link it with, both ways: what points to a table is only known from
 * the keys of every table of its schema (there is no per-table query for it), so those are read first, without
 * the columns, which are read only for the tables on show.
 */
export async function openErDiagram(connId: string, path: string[], focus?: ObjectRef) {
  const token = ++erToken;
  // "main · main" (SQLite, MySQL: database and schema share the name) reads as just "main".
  const title = path.filter((part, i) => part !== path[i - 1]).join(" · ");
  const centre = focus ? erId(focus) : "";
  setState("er", { connId, title, path, loading: true, done: 0, total: 0, error: "", truncated: 0, tables: [], edges: [], objects: {}, focus: centre, shown: centre ? [centre] : [], whole: false });
  const current = () => token === erToken && state.er !== null;
  const opened = await openSessionFor(connId).catch((err) => {
    if (current()) setState("er", { loading: false, error: errorText(err) });
    return null;
  });
  if (!opened) {
    // Disconnected meanwhile (no error): not left loading forever.
    if (current() && state.er!.loading) setState("er", { loading: false, error: state.er!.error || "La conexión se cerró" });
    return;
  }
  if (!current()) {
    void api().closeSession(opened.sessionId).catch(() => {});
    return;
  }
  try {
    if (path[0]) await api().useDatabase(opened.sessionId, path[0]).catch(() => {});
    const isTables = (node: MetaNode) => node.kind === "folder" && (node.path[node.path.length - 1] === "tables" || /^(tablas|tables)$/i.test(node.name));
    let folder = (await api().metaChildren(opened.sessionId, path).catch(() => [] as MetaNode[])).find(isTables);
    // A generic ODBC source has no database level: its tree starts at the folders (Tablas, Vistas).
    if (!folder && kindOf(connId) === "odbc" && path.length) folder = (await api().metaChildren(opened.sessionId, [])).find(isTables);
    if (!folder) throw new Error("Aquí no hay una carpeta de tablas");
    const all = (await api().metaChildren(opened.sessionId, folder.path)).filter((node) => node.obj?.kind === "table");
    if (!current()) return;
    if (centre) {
      await scanAround(opened.sessionId, all, centre, current);
      return;
    }
    const nodes = all.slice(0, ER_LIMIT);
    setState("er", { total: nodes.length, truncated: all.length - nodes.length });
    const tables: ErTable[] = [];
    const edges: ErEdge[] = [];
    const objects: Record<string, ObjectRef> = {};
    for (const [i, node] of nodes.entries()) {
      const obj = node.obj!;
      const id = erId(obj);
      const [columns, fkNodes] = await Promise.all([
        api().tableColumns(opened.sessionId, obj).catch(() => [] as TableColumn[]),
        api().metaChildren(opened.sessionId, [...node.path, "fks"]).catch(() => [] as MetaNode[]),
      ]);
      if (!current()) return;
      const fks = parseForeignKeys(fkNodes, obj).filter((fk) => fk.columns.length);
      tables.push(erTable(obj, columns, new Set(fks.flatMap((fk) => fk.columns))));
      for (const fk of fks) edges.push({ name: fk.name, from: id, to: erId(fk.target), fromCols: fk.columns, toCols: fk.targetColumns });
      objects[id] = obj;
      // Show progress (and the tables so far) every few tables.
      if (i % 8 === 7 || i === nodes.length - 1) setState("er", { done: i + 1, tables: [...tables], edges: [...edges], objects: { ...objects } });
    }
    if (current()) setState("er", { loading: false, done: nodes.length, whole: true });
  } catch (err) {
    if (current()) setState("er", { loading: false, error: errorText(err) });
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
}

/** The diagram of one table: the keys of every table of the schema, then the columns of it and its neighbours. */
async function scanAround(sessionId: string, all: MetaNode[], centre: string, current: () => boolean) {
  const own = all.find((node) => erId(node.obj!) === centre);
  if (!own) throw new Error(`La tabla ${centre} no está en este esquema`);
  // The table itself first: its own keys count even past the limit.
  const nodes = [own, ...all.filter((node) => node !== own)].slice(0, ER_SCAN_LIMIT);
  setState("er", { total: nodes.length, truncated: all.length - nodes.length });
  const edges: ErEdge[] = [];
  const objects: Record<string, ObjectRef> = {};
  for (const [i, node] of nodes.entries()) {
    const obj = node.obj!;
    const id = erId(obj);
    objects[id] = obj;
    const fkNodes = await api().metaChildren(sessionId, [...node.path, "fks"]).catch(() => [] as MetaNode[]);
    if (!current()) return;
    for (const fk of parseForeignKeys(fkNodes, obj).filter((fk) => fk.columns.length)) {
      edges.push({ name: fk.name, from: id, to: erId(fk.target), fromCols: fk.columns, toCols: fk.targetColumns });
      // A table of another schema it points to is shown too (its own keys are not read).
      objects[erId(fk.target)] ??= fk.target;
    }
    if (i % 16 === 15 || i === nodes.length - 1) setState("er", { done: i + 1 });
  }
  setState("er", { edges, objects, shown: erNeighbourhood(centre, edges, 1) });
  if (await readErColumns(sessionId, state.er!.shown, current, nodes.length)) setState("er", { loading: false });
}

/**
 * Reads the columns of the diagram tables in `ids` not read yet, adding them as they come (progress after
 * `offset` steps already done). False when the diagram was closed or replaced meanwhile.
 */
async function readErColumns(sessionId: string, ids: string[], current: () => boolean, offset = 0): Promise<boolean> {
  const read = new Set(state.er!.tables.map((t) => t.id));
  const missing = ids.filter((id) => !read.has(id) && state.er!.objects[id]);
  setState("er", { total: offset + missing.length, done: offset });
  const batch: ErTable[] = [];
  for (const [i, id] of missing.entries()) {
    const obj = state.er!.objects[id];
    const columns = await api().tableColumns(sessionId, obj).catch(() => [] as TableColumn[]);
    if (!current()) return false;
    const fkCols = new Set(state.er!.edges.filter((e) => e.from === id).flatMap((e) => e.fromCols));
    batch.push(erTable(obj, columns, fkCols));
    if (i % 8 === 7 || i === missing.length - 1) setState("er", { done: offset + i + 1, tables: [...state.er!.tables, ...batch.splice(0)] });
  }
  return current();
}

/**
 * Shows the tables in `shown` around `centre`, reading the columns of those that were not read yet (on a side
 * session: in a diagram in its own window too).
 */
async function showErTables(centre: string, shown: string[]) {
  const er = state.er;
  if (!er || er.loading) return;
  const token = erToken;
  const current = () => token === erToken && state.er !== null;
  setState("er", { focus: centre, shown });
  const read = new Set(er.tables.map((t) => t.id));
  if (shown.every((id) => read.has(id) || !er.objects[id])) return;
  setState("er", { loading: true, done: 0, total: 0 });
  const opened = await openSessionFor(er.connId).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened || !current()) {
    if (opened) void api().closeSession(opened.sessionId).catch(() => {});
    if (current()) setState("er", { loading: false });
    return;
  }
  try {
    if (er.path[0]) await api().useDatabase(opened.sessionId, er.path[0]).catch(() => {});
    await readErColumns(opened.sessionId, shown, current);
  } catch (err) {
    notify(errorText(err), "error");
  } finally {
    if (current()) setState("er", { loading: false });
    void api().closeSession(opened.sessionId).catch(() => {});
  }
}

/** The diagram of one table: adds the tables linked to `ids` (by default all those on show: one level more). */
export function widenErDiagram(ids?: string[]) {
  const er = state.er;
  if (!er?.focus) return;
  const add = erNeighbours(ids ?? er.shown, er.edges).filter((id) => er.objects[id]);
  if (add.length) void showErTables(er.focus, [...er.shown, ...add]);
}

/** Centres the diagram on one of its tables: it and its neighbours, from what the diagram has read when it can. */
export function focusErTable(id: string) {
  const er = state.er;
  const obj = er?.objects[id];
  if (!er || !obj || er.loading) return;
  // The whole schema, cut at ER_LIMIT: who points to the table may be among the tables left out.
  if (!er.focus && er.truncated) {
    void openErDiagram(er.connId, er.path, obj);
    return;
  }
  void showErTables(id, erNeighbourhood(id, er.edges, 1).filter((other) => er.objects[other]));
}

/** From the diagram of one table to the whole schema (read again unless it came from there). */
export function showWholeEr() {
  const er = state.er;
  if (!er?.focus || er.loading) return;
  if (er.whole) setState("er", { focus: "", shown: [] });
  else void openErDiagram(er.connId, er.path);
}

export function closeErDiagram() {
  erToken++;
  setState("er", null);
}

export interface ActivityState {
  connId: string;
  title: string;
  /** The monitor's own side session (and its id on the server, to mark it). */
  sessionId: string;
  selfId: string;
  /** Descripción del servidor de la sesión del monitor (distingue Azure Synapse dentro de SQL Server). */
  serverInfo: string;
  loading: boolean;
  error: string;
  sessions: ServerSession[];
  updatedAt: number;
  canCancel: boolean;
  canKill: boolean;
}

/** Opens the server activity monitor of a connection, on its own side session. */
export async function openActivity(connId: string) {
  const conn = connectionById(connId);
  const spec = activitySpec(conn?.kind);
  if (!conn || !spec) {
    notify("La actividad del servidor no está disponible para este motor", "warning");
    return;
  }
  setState("activity", { connId, title: conn.name, sessionId: "", selfId: "", serverInfo: "", loading: true, error: "", sessions: [], updatedAt: 0, canCancel: Boolean(spec.cancel), canKill: Boolean(spec.kill) });
  const opened = await openSessionFor(connId).catch((err) => {
    setState("activity", { loading: false, error: errorText(err) });
    return null;
  });
  if (!opened) return;
  if (state.activity?.connId !== connId) {
    void api().closeSession(opened.sessionId).catch(() => {});
    return;
  }
  const live = activitySpec(conn.kind, opened.serverInfo) ?? spec;
  const self = await api()
    .execute(opened.sessionId, live.self, 1)
    .then((out) => String(out.results[0]?.rows[0]?.[0] ?? ""))
    .catch(() => "");
  setState("activity", { sessionId: opened.sessionId, selfId: self, serverInfo: opened.serverInfo, canCancel: Boolean(live.cancel), canKill: Boolean(live.kill) });
  await refreshActivity();
}

export async function refreshActivity() {
  const current = state.activity;
  const spec = activitySpec(kindOf(current?.connId), current?.serverInfo);
  if (!current?.sessionId || !spec) return;
  setState("activity", "loading", true);
  try {
    const out = await api().execute(current.sessionId, spec.list, 5000);
    await api().closeCursor(current.sessionId).catch(() => {});
    if (state.activity?.sessionId !== current.sessionId) return;
    setState("activity", { sessions: readSessions(out.results.find((r) => r.columns.length), current.selfId), loading: false, error: "", updatedAt: Date.now() });
  } catch (err) {
    if (state.activity?.sessionId === current.sessionId) setState("activity", { loading: false, error: errorText(err) });
  }
}

/** Cancels a session's running statement, or ends the session (asks first; says so on production). */
export async function activityAction(id: string, action: "cancel" | "kill") {
  const current = state.activity;
  const spec = activitySpec(kindOf(current?.connId), current?.serverInfo);
  const make = action === "cancel" ? spec?.cancel : spec?.kill;
  if (!current?.sessionId || !make) return;
  const conn = connectionById(current.connId);
  const target = current.sessions.find((s) => s.id === id);
  const who = target ? `${target.user}${target.database ? ` en ${target.database}` : ""}${target.app ? ` (${target.app})` : ""}. ` : "";
  const what = action === "cancel" ? "La sentencia en curso se detiene; la sesión sigue abierta." : "Se cierra su conexión y se deshace lo que no haya confirmado.";
  const ok = await confirmDialog(
    action === "cancel" ? `Cancelar la consulta de la sesión ${id}` : `Terminar la sesión ${id}`,
    `${who}${what}${conn?.production ? " Es una conexión de producción." : ""}`,
    action === "cancel" ? "Cancelar consulta" : "Terminar sesión",
    true,
  );
  if (!ok) return;
  try {
    await api().execute(current.sessionId, make(id), 1);
    await api().closeCursor(current.sessionId).catch(() => {});
    notify(action === "cancel" ? `Consulta de la sesión ${id} cancelada` : `Sesión ${id} terminada`, "success");
  } catch (err) {
    notify(action === "cancel" ? "No se pudo cancelar" : "No se pudo terminar la sesión", "error", errorText(err));
  }
  await refreshActivity();
}

export function closeActivity() {
  const sessionId = state.activity?.sessionId;
  setState("activity", null);
  if (sessionId) void api().closeSession(sessionId).catch(() => {});
}

/** What the parameters dialog edits; values are remembered per console. */
export interface ParamAsk {
  names: string[];
  values: Record<string, string>;
  raw: Record<string, boolean>;
  sql: string;
  resolve: (answer: { values: Record<string, string>; raw: Record<string, boolean> } | null) => void;
}

const rememberedParams: Record<string, { values: Record<string, string>; raw: Record<string, boolean> }> = {};

function askParamValues(tabId: string, names: string[], sql: string) {
  // Only one dialog: a second ask cancels the first (its run does not happen).
  if (state.paramAsk) answerParams(null);
  const previous = rememberedParams[tabId] ?? { values: {}, raw: {} };
  return new Promise<{ values: Record<string, string>; raw: Record<string, boolean> } | null>((resolve) =>
    setState("paramAsk", {
      names,
      values: Object.fromEntries(names.map((name) => [name, previous.values[name] ?? ""])),
      raw: Object.fromEntries(names.map((name) => [name, previous.raw[name] ?? false])),
      sql,
      resolve: (answer) => {
        if (answer) rememberedParams[tabId] = { values: { ...previous.values, ...answer.values }, raw: { ...previous.raw, ...answer.raw } };
        resolve(answer);
      },
    }),
  );
}

export function answerParams(answer: { values: Record<string, string>; raw: Record<string, boolean> } | null) {
  state.paramAsk?.resolve(answer);
  setState("paramAsk", null);
}

export function answerPassword(value: string | null) {
  state.passwordAsk?.resolve(value);
  setState("passwordAsk", null);
}

function needsPassword(conn: ConnSummary) {
  return !conn.integratedAuth && conn.kind !== "sqlite" && conn.kind !== "odbc" && !conn.hasPassword && !state.passwords[conn.id];
}

export async function refreshConnections() {
  setState("connections", await api().listConnections());
}

/** Folders in use by the saved connections, in order of first appearance. */
export function connectionFolders(): string[] {
  return [...new Set(state.connections.map((conn) => conn.folder).filter(Boolean))];
}

/**
 * Moves a connection to `folder` (drag and drop in the explorer), optionally right before another
 * connection. The saved password is kept: saving with an empty password leaves the stored one untouched.
 */
export async function moveConnection(id: string, folder: string, beforeId?: string) {
  const conn = connectionById(id);
  if (!conn || id === beforeId) return;
  try {
    if ((conn.folder || "") !== folder) {
      const { hasPassword: _hasPassword, ...cfg } = conn;
      await api().saveConnection({ ...cfg, folder, password: "" });
    }
    const ids = state.connections.map((c) => c.id).filter((x) => x !== id);
    let at = beforeId ? ids.indexOf(beforeId) : -1;
    if (at < 0) {
      // No target connection: after the last one of that folder (or at the end).
      const last = state.connections.map((c) => (c.id !== id && (c.folder || "") === folder ? c.id : "")).filter(Boolean).pop();
      at = last ? ids.indexOf(last) + 1 : ids.length;
    }
    ids.splice(at, 0, id);
    await api().reorderConnections(ids);
    await refreshConnections();
    if ((conn.folder || "") !== folder) notify(`${conn.name} → ${folder || "Sin carpeta"}`, "success");
  } catch (err) {
    notify("No se pudo mover la conexión", "error", errorText(err));
  }
}

export function openConnDialog(cfg?: ConnConfig) {
  setState({ testOutput: "", testOk: null, testing: false, testGuide: "", testReport: null });
  setState("connDialog", cfg ? { ...cfg, password: "" } : emptyConn(isTauri() ? "postgres" : "sqlite"));
}

export async function submitConnection(cfg: ConnConfig) {
  const saved = await api().saveConnection(cfg);
  if (cfg.password) setState("passwords", saved.id, cfg.password);
  setState("connDialog", null);
  await refreshConnections();
  notify(`Conexión «${saved.name}» guardada`, "success");
  return saved;
}

export async function removeConnection(id: string) {
  const conn = connectionById(id);
  if (!conn) return;
  const ok = await confirmDialog(`Eliminar «${conn.name}»`, "Se borrará la conexión y su contraseña guardada. Las consolas abiertas se quedarán sin conexión.", "Eliminar", true);
  if (!ok) return;
  await disconnect(id, false);
  await api().deleteConnection(id);
  await refreshConnections();
}

/**
 * Creates (once) a small SQLite database with sample customers and orders, saves a connection to it and connects.
 * Used by the start-up guide so new users can try everything without a server.
 */
export async function createSampleDatabase(seed: string) {
  const existing = state.connections.find((conn) => conn.kind === "sqlite" && conn.name === "Ejemplo (SQLite)");
  if (existing) {
    await connect(existing.id);
    return existing.id;
  }
  const dir = state.appInfo.dataDir;
  const filePath = isTauri() && dir ? `${dir}${dir.includes("\\") ? "\\" : "/"}ejemplo.db` : ":memory:";
  const saved = await api().saveConnection({ ...emptyConn("sqlite"), name: "Ejemplo (SQLite)", filePath, folder: "Ejemplos", color: "#57AB5A" });
  await refreshConnections();
  const opened = await api().openSession(saved.id);
  try {
    const tables = await api().execute(opened.sessionId, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'customers'", 1);
    if (Number(tables.results[0]?.rows[0]?.[0] ?? 0) === 0) await api().execute(opened.sessionId, seed, 1);
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
  await connect(saved.id);
  return saved.id;
}

export async function duplicateConnection(id: string) {
  const conn = connectionById(id);
  if (!conn) return;
  openConnDialog({ ...conn, id: "", name: `${conn.name} (copia)` });
}

export async function testConnection(cfg: ConnConfig) {
  setState({ testOutput: "", testOk: null, testing: true, testGuide: "", testReport: null });
  try {
    const report = await api().testConnection(cfg);
    const code = errorCode(report.error);
    const summary = report.ok
      ? [report.serverInfo, report.route ? `Vía: ${report.route}` : "", `Total: ${formatMs(report.totalMs)}`]
      : [report.hint, plainError(report.error)];
    setState({ testReport: report, testOutput: summary.filter(Boolean).join("\n"), testOk: report.ok, testGuide: code?.code === "INFORMIX_GUIDE" ? code.arg || "jdbc" : "" });
    if (code?.code === "JDBC_SETUP") offerDriverHelp(report.error, () => void testConnection(cfg));
  } catch (err) {
    const message = errorText(err);
    const code = errorCode(message);
    setState({ testOutput: plainError(message), testOk: false, testGuide: code?.code === "INFORMIX_GUIDE" ? code.arg || "jdbc" : "" });
    // The dialog stays open: only what has to be downloaded is offered on top of it.
    if (code?.code === "JDBC_SETUP") offerDriverHelp(message, () => void testConnection(cfg));
  } finally {
    setState("testing", false);
  }
}

/**
 * A code the core puts in front of some errors: "JDBC_SETUP:java,jdbc: …", "INFORMIX_GUIDE:sdk: …", "IBM_DRIVER_MISSING: …",
 * and the connection's own (src-tauri/src/guard.rs): SESSION_LOST (it dropped and the transaction, #temp tables or SET
 * went with it), CONN_RESET (it dropped and a write was not repeated), CONN_DOWN (it dropped and could not reconnect).
 */
export function errorCode(message: string): { code: string; arg: string; text: string } | null {
  const match = /^(JDBC_SETUP|JDBC_BRIDGE_MISSING|INFORMIX_GUIDE|IBM_DRIVER_MISSING|SESSION_LOST|CONN_RESET|CONN_DOWN)(?::([\w,]+))?: ([\s\S]*)$/.exec(message);
  return match ? { code: match[1], arg: match[2] ?? "", text: match[3] } : null;
}

/** An error as the user reads it (without its code). */
export function plainError(message: string) {
  return errorCode(message)?.text ?? message;
}

/**
 * Offers what a driver error asks for: the downloads Informix over JDBC lacks (then `retry`), the Informix guide on
 * the error's topic, or Settings › Drivers. Returns whether it did.
 */
export function offerDriverHelp(message: string, retry: (() => void) | null): boolean {
  const code = errorCode(message);
  if (!code) return false;
  if (code.code === "JDBC_SETUP") {
    const missing = code.arg.split(",").filter((m): m is "java" | "jdbc" => m === "java" || m === "jdbc");
    setState("jdbcSetup", { missing, text: code.text, retry });
    void refreshInformixDrivers();
    return true;
  }
  if (code.code === "INFORMIX_GUIDE") {
    setState("informixGuide", { topic: code.arg || "jdbc", message: code.text });
    return true;
  }
  if (code.code === "IBM_DRIVER_MISSING" || code.code === "JDBC_BRIDGE_MISSING") {
    setState({ settingsOpen: true, settingsSection: "drivers" });
    return true;
  }
  return false;
}

export async function connect(connId: string, password?: string) {
  const conn = connectionById(connId);
  if (!conn || state.connecting[connId]) return;
  // Informix over JDBC: Java starts now, while the password is asked.
  if (isTauri() && conn.kind === "informix" && (conn.informixMode === "jdbc" || conn.informixMode === "auto")) void api().jdbcPrewarm(connId).catch(() => {});
  if (password) setState("passwords", connId, password);
  else if (needsPassword(conn)) {
    const typed = await askPassword(conn.name);
    if (!typed) return;
    setState("passwords", connId, typed);
  }
  const pwd = state.passwords[connId];
  const generation = connectGeneration(connId);
  setState("connecting", connId, true);
  try {
    const opened = await api().openSession(connId, pwd);
    // Disconnected while this was connecting: drop the new session instead of bringing the connection back.
    if (connectGeneration(connId) !== generation) {
      void api().closeSession(opened.sessionId).catch(() => {});
      return;
    }
    markConn(connId, "on", { connectMs: opened.connectMs, reused: opened.reused, note: "" });
    setState("sessions", connId, { metaId: opened.sessionId, database: opened.database, serverInfo: opened.serverInfo, databases: [] });
    try {
      localStorage.setItem(`celer.server.${connId}`, opened.serverInfo.slice(0, 120));
    } catch {
      /* only cosmetic */
    }
    // The explorer's first level first; the database list comes from it when it lists databases (one round trip
    // less), and autocompletion after the tree has opened (on the same session, it would hold the tree back).
    await loadChildren(connId, [], true);
    if (connectGeneration(connId) !== generation) return;
    const roots = state.tree[pathKey(connId, [])]?.nodes ?? [];
    const listed = roots.filter((node) => node.kind === "database").map((node) => node.name);
    const databases = listed.length ? [...listed].sort((a, b) => a.localeCompare(b)) : await api().listDatabases(opened.sessionId).catch(() => [] as string[]);
    if (state.sessions[connId]?.metaId === opened.sessionId) setState("sessions", connId, "databases", databases);
    const loadCatalog = () =>
      void api()
        .completion(opened.sessionId, opened.database)
        .then((schema) => setState("catalog", connId, { database: opened.database, tables: schema.tables }))
        .catch(() => {});
    void autoExpand(connId).then(loadCatalog, loadCatalog);
    gib("connected", { production: conn.production, detail: conn.name });
    const current = activeTab();
    if (!current) {
      // A panel window has no consoles of its own.
      if (!isPanelWindow()) openQuery(connId, "");
    } else if (current.kind === "sql" && !current.connId) {
      setState("tabs", tabIndex(current.id), { connId, database: opened.database, serverInfo: opened.serverInfo, title: isDefaultConsoleTitle(current.title) ? conn.name : current.title });
      warmSqlSession(current.id);
    } else if (current.kind === "sql" && current.connId === connId) {
      warmSqlSession(current.id);
    }
    persistSoon();
  } catch (err) {
    const message = errorText(err);
    // Shown on its dot; showing its consoles does not try again on its own (connecting by hand does).
    if (connectGeneration(connId) === generation) markConn(connId, "down", { note: plainError(message) });
    notify(`No se pudo conectar a «${conn.name}»`, "error", plainError(message));
    gib("connect-failed", { detail: plainError(message) });
    // Forget a typed password that did not work, so the next attempt asks again.
    if (!conn.hasPassword) {
      setState(produce((draft) => {
        delete draft.passwords[connId];
      }));
    }
    offerDriverHelp(message, () => void connect(connId));
  } finally {
    // A disconnect in between owns the flag now (a newer connect may be running).
    if (connectGeneration(connId) === generation) setState("connecting", connId, false);
  }
}

/** Opens the current database and its default schema, like DataGrip does on first connect. */
async function autoExpand(connId: string) {
  const session = state.sessions[connId];
  const roots = state.tree[pathKey(connId, [])]?.nodes ?? [];
  const db = roots.find((node) => node.name === session?.database) ?? (roots.length === 1 ? roots[0] : undefined);
  if (!db || db.leaf) return;
  await loadChildren(connId, db.path, true);
  const schemas = state.tree[pathKey(connId, db.path)]?.nodes ?? [];
  const preferred = ["public", "dbo", "main", db.name];
  const schema = schemas.find((node) => node.kind === "schema" && preferred.includes(node.name)) ?? (schemas.length === 1 && schemas[0].kind === "schema" ? schemas[0] : undefined);
  if (!schema || schema.leaf) return;
  await loadChildren(connId, schema.path, true);
  const folders = state.tree[pathKey(connId, schema.path)]?.nodes ?? [];
  const tables = folders.find((node) => node.kind === "folder" && /^(tablas|tables)$/i.test(node.name));
  if (tables && !tables.leaf) await loadChildren(connId, tables.path, true);
}

/** Bumped by every disconnect: a connect() still in flight from before must not resurrect the connection. */
const generations: Record<string, number> = {};
const connectGeneration = (connId: string) => generations[connId] ?? 0;

/**
 * Closes every session of a connection and forgets it in the UI. Open transactions and unsaved table edits are
 * confirmed first (they would be lost); consoles and tables stay open and reconnect on their next run or reload.
 */
export async function disconnect(connId: string, confirm = true) {
  const affected = state.tabs.filter((tab) => tab.connId === connId);
  const inTransaction = affected.filter((tab) => tab.kind === "sql" && tab.inTransaction).length;
  const dirty = affected.filter((tab) => tab.kind === "table" && tableDirty(tab)).length;
  const exporting = state.exportRunning && state.exportSource?.connId === connId;
  if (confirm && (inTransaction || dirty || exporting)) {
    const lost = [
      inTransaction ? `${inTransaction} ${inTransaction === 1 ? "consola con una transacción abierta (se deshará)" : "consolas con transacciones abiertas (se desharán)"}` : "",
      dirty ? `${dirty} ${dirty === 1 ? "tabla con cambios sin guardar" : "tablas con cambios sin guardar"}` : "",
      exporting ? "una exportación en curso (se cancelará)" : "",
    ].filter(Boolean);
    const ok = await confirmDialog(`Desconectar «${connectionById(connId)?.name ?? ""}»`, `Hay ${lost.join(" y ")}. Si desconectas se perderán.`, "Desconectar", true);
    if (!ok) return;
  }
  generations[connId] = connectGeneration(connId) + 1;
  markConn(connId, "off", { note: "" });
  for (const tab of affected) bumpToken(tab.id);
  if (exporting) void cancelExport();
  // This window's sessions of the connection (its explorer, its tabs, its activity monitor): other windows keep theirs.
  const own = [state.sessions[connId]?.metaId, ...affected.map((tab) => tab.sessionId), state.activity?.connId === connId ? state.activity.sessionId : ""].filter((id): id is string => Boolean(id));
  // The UI forgets the connection at once; the sessions close behind it.
  setState(
    produce((draft) => {
      delete draft.sessions[connId];
      delete draft.connecting[connId];
      for (const key of Object.keys(draft.tree)) {
        if (key.startsWith(`${connId}\u0000`)) delete draft.tree[key];
      }
      // A selected node inside this connection goes away: select the connection row instead.
      if (draft.treeSelected.startsWith(`n:${connId}\u0000`)) draft.treeSelected = `c:${connId}`;
      for (const tab of draft.tabs) {
        if (tab.connId !== connId) continue;
        // Consoles reopen a session on their next run; table tabs on reload. Pending pages are gone with the cursor.
        if (tab.kind === "sql") {
          tab.sessionId = null;
          tab.inTransaction = false;
          tab.running = false;
          tab.results = tab.results.map((result) => (result.hasMore ? { ...result, hasMore: false } : result));
        } else {
          tab.sessionId = "";
          tab.loading = false;
          tab.hasMore = false;
          tab.edits = {};
          tab.deleted = [];
          tab.inserts = [];
        }
      }
    }),
  );
  if (otherFullWindows().length) await Promise.all(own.map((id) => api().closeSession(id).catch(() => {})));
  else await api().closeConnectionSessions(connId).catch(() => 0);
  persistSoon();
}

// ---------------------------------------------------------------- explorer

export async function loadChildren(connId: string, path: string[], open = true) {
  const session = state.sessions[connId];
  if (!session) return;
  const key = pathKey(connId, path);
  setState("tree", key, { open, status: "loading", nodes: state.tree[key]?.nodes ?? [] });
  // A disconnect (or reconnect) while this loads: its answer belongs to a session that is gone.
  const stale = () => state.sessions[connId]?.metaId !== session.metaId;
  try {
    const nodes = await api().metaChildren(session.metaId, path);
    if (!stale()) setState("tree", key, { open, status: "ready", nodes });
  } catch (err) {
    if (!stale()) setState("tree", key, { open, status: "error", nodes: [], error: errorText(err) });
  }
}

export async function toggleNode(connId: string, node: MetaNode, force?: boolean) {
  if (node.leaf) return;
  const key = pathKey(connId, node.path);
  const current = state.tree[key];
  const target = force ?? !current?.open;
  if (!target) {
    if (current) setState("tree", key, "open", false);
    return;
  }
  if (current?.status === "ready") setState("tree", key, "open", true);
  else await loadChildren(connId, node.path, true);
}

export function toggleConnection(connId: string, force?: boolean) {
  if (!state.sessions[connId]) {
    if (force !== false) void connect(connId);
    return;
  }
  const key = pathKey(connId, []);
  const open = force ?? !state.tree[key]?.open;
  if (state.tree[key]) setState("tree", key, "open", open);
}

export function collapseAll() {
  for (const key of Object.keys(state.tree)) setState("tree", key, "open", false);
}

/**
 * Reloads a node and everything expanded below it (a table created elsewhere shows up in its open folder);
 * cached folders that are closed are forgotten, so they load fresh when opened.
 */
export async function refreshNode(connId: string, path: string[]) {
  const own = pathKey(connId, path);
  const below = (key: string) => key !== own && (path.length ? key.startsWith(`${own}\u0000`) : key.startsWith(own));
  const reopen: string[][] = [];
  setState(
    "tree",
    produce((tree) => {
      for (const key of Object.keys(tree)) {
        if (!below(key)) continue;
        if (tree[key].open) reopen.push(key.slice(connId.length + 1).split("\u0000"));
        else delete tree[key];
      }
    }),
  );
  await loadChildren(connId, path, true);
  await Promise.all(reopen.map((sub) => loadChildren(connId, sub, true)));
  if (!path.length) {
    const session = state.sessions[connId];
    if (!session) return;
    const databases = await api().listDatabases(session.metaId).catch(() => session.databases);
    // Disconnected (or reconnected) meanwhile: the entry is gone or belongs to another session.
    if (state.sessions[connId]?.metaId === session.metaId) setState("sessions", connId, "databases", databases);
  }
}

// ---------------------------------------------------------------- consoles

/**
 * A new console. `background`: added without becoming the active tab (an assistant opened it while the user was
 * typing); `database`: the one it starts in, instead of the connection's.
 */
export function openQuery(connId: string | null, sql = "", title?: string, options: { background?: boolean; database?: string } = {}) {
  const conn = connectionById(connId);
  const tab = blankSql(uid(), connId, sql, title ?? conn?.name ?? CONSOLE_TITLE);
  const session = connId ? state.sessions[connId] : undefined;
  if (session) {
    tab.database = session.database;
    tab.serverInfo = session.serverInfo;
  }
  if (connId && options.database) tab.database = options.database;
  setState("tabs", [...state.tabs, tab]);
  if (!options.background) setState("activeTabId", tab.id);
  persistSoon();
  warmSqlSession(tab.id);
  return tab.id;
}

export function updateSql(id: string, sql: string, cursor: number, selection: string) {
  const index = tabIndex(id);
  if (index < 0) return;
  setState("tabs", index, { sql, cursor, selection } as Partial<SqlTab>);
  persistSoon();
}

export async function setTabConnection(tabId: string, connId: string) {
  const before = state.tabs[tabIndex(tabId)];
  if (!before || before.kind !== "sql" || before.connId === connId) return;
  // Its session closes: same confirmation as closing the console.
  if (before.inTransaction || before.running) {
    const ok = await confirmDialog(
      before.inTransaction ? "Transacción abierta" : "Sentencia en curso",
      before.inTransaction
        ? "La consola tiene una transacción sin confirmar. Al cambiar de conexión se deshará (rollback)."
        : "La consola está ejecutando una sentencia. Al cambiar de conexión se interrumpirá.",
      before.inTransaction ? "Cambiar y deshacer" : "Cambiar de conexión",
      true,
    );
    if (!ok) return;
  }
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "sql" || tab.connId === connId) return;
  if (tab.sessionId) void api().closeSession(tab.sessionId).catch(() => {});
  const conn = connectionById(connId);
  const session = state.sessions[connId];
  setState("tabs", index, {
    connId,
    sessionId: null,
    completion: null,
    inTransaction: false,
    database: session?.database ?? "",
    serverInfo: session?.serverInfo ?? "",
    title: isDefaultConsoleTitle(tab.title) || connectionById(tab.connId)?.name === tab.title ? conn?.name ?? tab.title : tab.title,
  } as Partial<SqlTab>);
  // A session still opening on the old connection is closed when it arrives (openSqlSession): this one gets its own.
  openingSql.delete(tabId);
  if (!session) void connect(connId);
  else warmSqlSession(tabId);
  persistSoon();
}

export function formatActive() {
  const tab = activeSql();
  if (!tab) return;
  setState("tabs", tabIndex(tab.id), { sql: formatSql(tab.sql, kindOf(tab.connId)), revision: tab.revision + 1 } as Partial<SqlTab>);
  persistSoon();
}

export function insertIntoActive(text: string) {
  if (forwardFromPanel("insert", { text })) return;
  const tab = activeSql();
  if (!tab) {
    openQuery(null, text);
    return;
  }
  const at = Math.min(tab.cursor, tab.sql.length);
  const sql = tab.sql.slice(0, at) + text + tab.sql.slice(at);
  setState("tabs", tabIndex(tab.id), { sql, cursor: at + text.length, revision: tab.revision + 1 } as Partial<SqlTab>);
  persistSoon();
}

/** One session per console: the warm-up when it opens and a run that starts meanwhile share it. */
const openingSql = new Map<string, Promise<SqlTab>>();
function ensureSqlSession(tab: SqlTab): Promise<SqlTab> {
  const pending = openingSql.get(tab.id);
  if (pending) return pending;
  const job = openSqlSession(tab);
  openingSql.set(tab.id, job);
  // Only its own entry: a console moved to another connection meanwhile has a newer job here.
  void job.finally(() => openingSql.get(tab.id) === job && openingSql.delete(tab.id)).catch(() => {});
  return job;
}

/**
 * Opens the session of a console in the background as soon as the console opens or is shown: the first run does not
 * pay the login (TLS included), as when a tool keeps its connection open. A connection that is not connected yet
 * connects on its own when it needs no password (connect() then warms the active console).
 */
export function warmSqlSession(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "sql" || !tab.connId || tab.sessionId) return;
  const conn = connectionById(tab.connId);
  if (!state.sessions[tab.connId]) {
    if (conn && !state.connecting[tab.connId] && !needsPassword(conn) && connLink(tab.connId).link !== "down") void connect(tab.connId);
    return;
  }
  void ensureSqlSession(tab).catch(() => {});
}

async function openSqlSession(tab: SqlTab): Promise<SqlTab> {
  if (!tab.connId) throw new Error("Elige una conexión para esta consola");
  // Moved here from another window with its session (and its transaction, #temp tables, pending rows): kept.
  const moved = state.tabs[tabIndex(tab.id)];
  if (moved?.kind === "sql" && moved.sessionId) return moved;
  if (!state.sessions[tab.connId]) await connect(tab.connId);
  // connect() returns at once when another call (the console's warm-up) is already connecting: wait for that one.
  for (let i = 0; i < 600 && !state.sessions[tab.connId] && state.connecting[tab.connId]; i++) await new Promise((r) => setTimeout(r, 100));
  if (!state.sessions[tab.connId]) throw new Error("Sin conexión");
  const fresh = state.tabs[tabIndex(tab.id)];
  if (!fresh || fresh.kind !== "sql") throw new Error("La pestaña ya no existe");
  if (fresh.sessionId) return fresh;
  // Plain values: `fresh` is a live store proxy, and the console may move to another connection while this opens.
  const connId = fresh.connId!;
  const database = fresh.database;
  const pwd = state.passwords[connId];
  const generation = connectGeneration(connId);
  // Straight into the console's database and transaction mode (a console in Manual mode stays manual on a new
  // session): no USE or extra round trips afterwards. If that database is gone, the connection's own.
  markTab(fresh.id, "connecting");
  const mode = { autocommit: fresh.autocommit };
  // The console's connection was changed while this session opened: it now has (or is opening) its own.
  const switched = () => {
    const now = state.tabs[tabIndex(fresh.id)];
    return now?.kind === "sql" && (now.connId !== connId || !!now.sessionId);
  };
  const opened = await api()
    .openSession(connId, pwd, { ...mode, database: database || undefined })
    .catch((err: unknown) => (database && !switched() ? api().openSession(connId, pwd, mode) : Promise.reject(err)))
    .catch((err: unknown) => {
      if (!switched()) markTab(fresh.id, "down", { note: plainError(errorText(err)) });
      throw err;
    });
  if (switched()) {
    void api().closeSession(opened.sessionId).catch(() => {});
    throw new Error("La consola ha cambiado de conexión");
  }
  // Disconnected meanwhile (even if reconnected since): do not attach a session the core may have closed.
  if (!state.sessions[connId] || connectGeneration(connId) !== generation) {
    void api().closeSession(opened.sessionId).catch(() => {});
    markTab(fresh.id, "off");
    throw new Error("La conexión se ha cerrado");
  }
  const now = state.tabs[tabIndex(fresh.id)];
  if (!now || now.kind !== "sql") {
    void api().closeSession(opened.sessionId).catch(() => {});
    throw new Error("La pestaña ya no existe");
  }
  markTab(fresh.id, "on", { connectMs: opened.connectMs, reused: opened.reused, note: "" });
  patchTab(fresh.id, { sessionId: opened.sessionId, database: opened.database, serverInfo: opened.serverInfo, inTransaction: false });
  void loadCompletion(fresh.id);
  return state.tabs[tabIndex(fresh.id)] as SqlTab;
}

/**
 * Consoles whose autocompletion waits for their open result: reading the catalog on the session would close it (MySQL,
 * SQLite), so the refresh after DDL comes once the result is read to the end or the next run leaves none open.
 */
const completionAfterResult = new Set<string>();

/** Refreshes a console's autocompletion now, or once its open result is read (see completionAfterResult). */
function refreshCompletion(tabId: string, results: ResultSet[]) {
  if (results.some((result) => result.hasMore)) completionAfterResult.add(tabId);
  else {
    completionAfterResult.delete(tabId);
    void loadCompletion(tabId);
  }
}

async function loadCompletion(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "sql" || !tab.sessionId) return;
  const { sessionId, database } = tab;
  try {
    const completion = await api().completion(sessionId, database);
    // The database (or the session) changed meanwhile: a newer request describes the one on show.
    const now = state.tabs[tabIndex(tabId)];
    if (now?.kind !== "sql" || now.sessionId !== sessionId || now.database !== database) return;
    patchTab(tabId, { completion });
  } catch {
    /* completion is optional */
  }
}

async function remember(tab: SqlTab, sql: string, ok: boolean, elapsedMs: number, rows: number | null) {
  const conn = connectionById(tab.connId);
  const entry: HistoryEntry = {
    sql,
    connId: tab.connId ?? "",
    connName: conn?.name ?? "",
    database: tab.database,
    at: Date.now(),
    elapsedMs,
    ok,
    rows,
  };
  await api().addHistory(entry).catch(() => {});
  if (state.inspectorOpen && state.inspectorMode === "history") void refreshHistory();
}

function pushOutput(tabId: string, entry: OutputEntry) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "sql") return;
  patchTab(tabId, { output: [...tab.output.slice(-199), entry] });
}

export function describeResults(results: ResultSet[], elapsedMs: number) {
  const parts = results.map((result) =>
    result.columns.length
      ? rowsLabel(result.rows.length, result.hasMore)
      : `${rowsLabel(result.rowsAffected ?? 0)} ${(result.rowsAffected ?? 0) === 1 ? "afectada" : "afectadas"}`,
  );
  return `${parts.join(", ") || "Hecho"} en ${formatMs(elapsedMs)}`;
}

export function formatMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toLocaleString(undefined, { minimumFractionDigits: ms < 10000 ? 2 : 1, maximumFractionDigits: ms < 10000 ? 2 : 1 })} s`;
  const m = Math.floor(ms / 60000);
  return `${m} min ${Math.round((ms % 60000) / 1000)} s`;
}

/** Runs the selection or the statement at the cursor of the active console, or `text` when given (runText, rerunActive). */
/** Runs in the active console, or in the console `tabId` (an assistant's, which may be in the background). */
export async function runActive(mode: "statement" | "script" | "explain" | "analyze", text?: string, tabId?: string) {
  const byId = tabId ? state.tabs[tabIndex(tabId)] : undefined;
  const current = tabId ? (byId?.kind === "sql" ? byId : undefined) : activeSql();
  if (!current || current.running) return;
  const conn = connectionById(current.connId);
  let sql = text?.trim() || current.selection.trim() || (mode === "script" ? current.sql.trim() : statementAt(current.sql, current.cursor, conn?.kind));
  if (!sql) return;
  // Parameters (:name, ?, ${name}): ask for their values and write them in as literals.
  if (state.settings.askParams) {
    const refs = findParams(sql, conn?.kind);
    if (refs.length) {
      const answer = await askParamValues(current.id, paramNames(refs), sql);
      if (!answer) return;
      sql = bindParams(sql, refs, answer.values, answer.raw, conn?.kind);
    }
  }
  if (mode === "explain" || mode === "analyze") {
    // One plan: the first statement of a selection (the others would run, not be explained).
    // Pieces that are only comments ("SELECT 1; -- fin") are not statements.
    const parts = splitSql(sql, conn?.kind).filter((part) => codeOnly(part.sql, conn?.kind).trim());
    if (parts.length > 1) notify("La selección tiene varias sentencias: se muestra el plan de la primera", "info");
    return explainStatement(current.id, parts[0]?.sql ?? sql, mode === "analyze");
  }
  // hasUnfilteredWrite also sees the DELETE / UPDATE inside a CTE (WITH d AS (DELETE …) SELECT … WHERE …).
  if (conn?.production && state.settings.confirmMutations && (needsProductionConfirm(sql, conn.kind) || hasUnfilteredWrite(sql, conn.kind))) {
    const ok = await confirmDialog(
      `Ejecutar en ${conn.name} (producción)`,
      "La sentencia modifica datos sin WHERE o cambia la estructura (DROP, TRUNCATE, ALTER). Revisa antes de continuar.",
      "Ejecutar de todos modos",
      true,
    );
    if (!ok) return;
  } else if (state.settings.confirmNoWhere && hasUnfilteredWrite(sql, conn?.kind)) {
    const ok = await confirmDialog(
      "DELETE / UPDATE sin WHERE",
      "La sentencia no tiene WHERE: afectará a todas las filas de la tabla.",
      "Ejecutar de todos modos",
      true,
    );
    if (!ok) return;
  }
  const fresh = state.tabs[tabIndex(current.id)];
  if (!fresh || fresh.kind !== "sql") return;
  patchTab(current.id, { running: true, error: "", messages: [], startedAt: Date.now(), lastSql: sql });
  const token = tokenOf(current.id);
  try {
    const hadSession = Boolean(fresh.sessionId);
    const tab = await ensureSqlSession(fresh);
    const output = await api().execute(tab.sessionId!, sql, state.settings.pageSize);
    // Disconnected while it ran: this answer belongs to a closed session.
    if (tokenOf(current.id) !== token) return;
    // The session opened for this run: how long that took goes with the output. One that dropped and came back on
    // its own says so (the core's note) and the tab shows it.
    const opened = hadSession ? null : tabLink(tab);
    if (opened && opened.connectMs !== null) output.messages = [`Sesión abierta en ${connectTimeText(opened)}`, ...output.messages];
    const recovered = output.messages.find((message) => message.startsWith(RECOVERED_PREFIX));
    if (recovered) markTab(tab.id, "reconnected", { note: recovered });
    const firstGrid = output.results.findIndex((result) => result.columns.length);
    patchTab(tab.id, {
      runId: (tab.runId ?? 0) + 1,
      running: false,
      startedAt: null,
      results: output.results,
      activeResult: firstGrid >= 0 ? firstGrid : -1,
      activePinned: null,
      activePlan: false,
      resultsSql: sql,
      messages: output.messages,
      elapsedMs: output.elapsedMs,
      inTransaction: output.inTransaction,
      error: "",
    });
    const summary = describeResults(output.results, output.elapsedMs);
    gib("query-ok", {
      ms: output.elapsedMs,
      hasMore: output.results.some((result) => result.hasMore),
      detail: sql,
      columns: output.results.find((result) => result.columns.length)?.columns.length ?? 0,
      kind: conn?.kind,
    });
    pushOutput(tab.id, { at: Date.now(), sql, ok: true, text: [summary, ...output.messages].join("\n"), elapsedMs: output.elapsedMs });
    // Statements of a script that wait behind a paged result, or that were dropped with one (the core's notes).
    const dropped = output.messages.find((message) => /^No se ejecutó|^No se ejecutaron \d+ sentencias del script/.test(message));
    const pending = output.messages.find((message) => /^Quedan? \d+ sentencias? del script/.test(message));
    if (dropped) notify(dropped, "warning");
    if (pending) notify(pending, "info");
    const rows = output.results.find((result) => result.columns.length)?.rows.length ?? output.results.find((result) => result.rowsAffected !== null)?.rowsAffected ?? null;
    if (isMutating(sql, conn?.kind) && /\b(create|drop|alter|rename)\b/i.test(sql)) {
      refreshCompletion(tab.id, output.results);
      if (tab.connId) void refreshNode(tab.connId, []);
    } else if (completionAfterResult.has(tab.id)) refreshCompletion(tab.id, output.results);
    await remember(tab, sql, true, output.elapsedMs, rows);
  } catch (err) {
    if (tokenOf(current.id) !== token) return;
    const full = errorText(err);
    // The connection dropped: the core reconnected (or could not) and says what was lost; the tab shows it.
    const dropped = noteDropped(current.id, current.title, full);
    const message = dropped ? plainError(full) : full;
    const at = tabIndex(current.id);
    if (at >= 0) patchTab(current.id, { running: false, startedAt: null, error: message, elapsedMs: null, activeResult: -1, activePinned: null, activePlan: false, compare: null, ...(dropped ? { inTransaction: false } : {}) });
    pushOutput(current.id, { at: Date.now(), sql, ok: false, text: message, elapsedMs: null });
    gib("query-error", { detail: message });
    await remember(current, sql, false, 0, null);
    offerDriverHelp(full, null);
  }
}

/**
 * An error that says the connection dropped (SESSION_LOST, CONN_RESET, CONN_DOWN from src-tauri/src/guard.rs): the
 * tab's indicator shows it, and a lost transaction or session state is also told in a balloon, since it is not an
 * error of the statement. Returns whether it was one of those.
 */
export function noteDropped(tabId: string, title: string, message: string): boolean {
  const code = errorCode(message)?.code ?? "";
  const text = plainError(message);
  if (code === "SESSION_LOST") {
    markTab(tabId, "lost", { note: text });
    notify(`«${title}» perdió su sesión al cortarse la conexión`, "warning", text);
  } else if (code === "CONN_RESET") markTab(tabId, "reconnected", { note: text });
  else if (code === "CONN_DOWN") markTab(tabId, "down", { note: text });
  else return false;
  return true;
}

/** ANALYZE runs the statement: only for reads, on engines whose analyzed plan Celer reads (PostgreSQL, MariaDB). */
export function canAnalyze(tab: SqlTab, sql: string): boolean {
  const kind = kindOf(tab.connId);
  const engineOk = kind === "postgres" || (kind === "mysql" && /mariadb/i.test(tab.serverInfo || state.sessions[tab.connId ?? ""]?.serverInfo || ""));
  return engineOk && /^(SELECT|WITH|VALUES|TABLE)$/.test(firstKeyword(sql)) && !isMutating(sql, kind);
}

/**
 * A statement run on the tab's session besides its results (EXPLAIN) closes the open cursor: the kept results
 * can no longer fetch more rows. Also the transaction state the session reported, when it did.
 */
function afterSideStatement(tabId: string, inTransaction: boolean | null): Partial<SqlTab> {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "sql") return {};
  const patch: Partial<SqlTab> = {};
  if (tab.results.some((result) => result.hasMore)) patch.results = tab.results.map((result) => (result.hasMore ? { ...result, hasMore: false } : result));
  if (inTransaction !== null) patch.inTransaction = inTransaction;
  return patch;
}

/**
 * The execution plan of a statement, as a tree in its own result tab (the current results stay). Engines
 * without a plan reader show the raw EXPLAIN output instead.
 */
export async function explainStatement(tabId: string, sql: string, analyze = false) {
  // A plan in a window of its own: the console's window plans again, and sends the new plan over.
  if (forwardFromPanel("plan-explain", { tabId, sql, analyze })) return;
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "sql" || tab.running) return;
  const kind = kindOf(tab.connId);
  if (analyze && !canAnalyze(tab, sql)) {
    notify("ANALYZE solo se ofrece para consultas de lectura en PostgreSQL y MariaDB", "warning");
    return;
  }
  const prefix = explainPrefix(kind);
  if (!prefix && kind !== "mssql") {
    notify("El plan de ejecución no está disponible para este motor", "warning");
    return;
  }
  patchTab(tabId, { running: true, startedAt: Date.now(), error: "" });
  const token = tokenOf(tabId);
  let session = "";
  try {
    const ready = await ensureSqlSession(tab);
    session = ready.sessionId!;
    const mariadb = /mariadb/i.test(ready.serverInfo);
    let plan: Plan;
    let inTx: boolean | null = null;
    if (kind === "postgres") {
      const out = await api().execute(session, `EXPLAIN (FORMAT JSON, VERBOSE, COSTS${analyze ? ", ANALYZE, BUFFERS" : ""}) ${sql}`, 10);
      inTx = out.inTransaction;
      plan = parsePostgresPlan(String(out.results[0]?.rows[0]?.[0] ?? "[]"));
    } else if (kind === "mysql") {
      const out = await api().execute(session, `${analyze && mariadb ? "ANALYZE" : "EXPLAIN"} FORMAT=JSON ${sql}`, 10);
      inTx = out.inTransaction;
      plan = parseMysqlPlan(String(out.results[0]?.rows[0]?.[0] ?? "{}"));
      plan.engine = mariadb ? "MariaDB" : "MySQL";
    } else if (kind === "sqlite") {
      const out = await api().execute(session, `EXPLAIN QUERY PLAN ${sql}`, 10_000);
      inTx = out.inTransaction;
      plan = parseSqlitePlan(out.results[0]?.rows ?? []);
    } else if (synapseDedicated(ready.serverInfo)) {
      // Azure Synapse dedicated / PDW: sin SHOWPLAN_XML; EXPLAIN da el plan distribuido sin ejecutar la sentencia.
      const out = await api().execute(session, `EXPLAIN ${sql}`, 10);
      inTx = out.inTransaction;
      plan = parseSynapsePlan(String(out.results.find((r) => r.columns.length)?.rows[0]?.[0] ?? ""));
    } else {
      // SQL Server: the XML plan, without running the statement.
      await api().execute(session, "SET SHOWPLAN_XML ON", 1);
      try {
        const out = await api().execute(session, sql, 10);
        plan = parseMssqlPlan(String(out.results.find((r) => r.columns.length)?.rows[0]?.[0] ?? ""));
      } finally {
        const off = await api().execute(session, "SET SHOWPLAN_XML OFF", 1).catch(() => null);
        if (off) inTx = off.inTransaction;
      }
    }
    if (tokenOf(tabId) !== token) return;
    patchTab(tabId, { running: false, startedAt: null, plan: { plan, sql }, activePlan: true, activePinned: null, compare: null, ...afterSideStatement(tabId, inTx) });
  } catch (err) {
    if (tokenOf(tabId) !== token) return;
    const message = errorText(err);
    patchTab(tabId, { running: false, startedAt: null, error: message, activePlan: false, activePinned: null, activeResult: -1, ...afterSideStatement(tabId, null) });
    pushOutput(tabId, { at: Date.now(), sql: `EXPLAIN ${sql}`, ok: false, text: message, elapsedMs: null });
    gib("query-error", { detail: message });
  }
}

/** Runs a given SQL text in the active console without touching what the user wrote. */
export async function runText(sql: string) {
  if (forwardFromPanel("run-text", { sql })) return;
  const tab = activeSql();
  if (!tab) return;
  await runActive("statement", sql);
}

/** Replaces the whole text of the active console. */
export function replaceActiveSql(sql: string) {
  if (forwardFromPanel("replace", { sql })) return;
  const tab = activeSql();
  if (!tab) {
    openQuery(null, sql);
    return;
  }
  setState("tabs", tabIndex(tab.id), { sql, cursor: sql.length, revision: tab.revision + 1 } as Partial<SqlTab>);
  persistSoon();
}

export async function rerunActive() {
  const tab = activeSql();
  if (!tab?.lastSql) return runActive("statement");
  await runActive("statement", tab.lastSql);
}

export async function cancelActive() {
  const tab = activeTab();
  if (!tab?.sessionId) return;
  await api().cancel(tab.sessionId).catch((err) => notify(errorText(err), "error"));
}

/**
 * Work in flight per tab (a run, a page, a reload): disconnect bumps the token, so an answer that arrives
 * afterwards from the closed session is ignored instead of overwriting the tab (a new run may own it by then).
 */
const tabTokens = new Map<string, number>();
const tokenOf = (tabId: string) => tabTokens.get(tabId) ?? 0;
const bumpToken = (tabId: string) => tabTokens.set(tabId, tokenOf(tabId) + 1);

/** Loads the next page. Returns false when nothing could be loaded (error, closed tab, nothing pending). */
export async function fetchMore(tabId: string, n = state.settings.pageSize): Promise<boolean> {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || !tab.sessionId) return false;
  if (tab.kind === "sql") {
    const resultIndex = tab.results.findIndex((result) => result.hasMore);
    if (resultIndex < 0 || tab.running) return false;
    patchTab(tab.id, { running: true });
    const token = tokenOf(tabId);
    try {
      const more = await api().fetch(tab.sessionId, n);
      const fresh = state.tabs[tabIndex(tabId)];
      if (!fresh || fresh.kind !== "sql" || tokenOf(tabId) !== token) return false;
      const result = fresh.results[resultIndex];
      const results = fresh.results.slice();
      results[resultIndex] = { ...result, rows: concatRows(result.rows, more.rows), hasMore: more.hasMore };
      if (!more.hasMore) results.push(...more.extra);
      patchTab(tab.id, { results, running: false });
      if (completionAfterResult.has(tabId)) refreshCompletion(tabId, results);
      return true;
    } catch (err) {
      if (tokenOf(tabId) !== token) return false;
      patchTab(tab.id, { running: false });
      notify("No se pudieron cargar más filas", "error", errorText(err));
      return false;
    }
  }
  if (!tab.hasMore || tab.loading) return false;
  patchTab(tab.id, { loading: true });
  const token = tokenOf(tabId);
  try {
    const more = await api().fetch(tab.sessionId, n);
    const fresh = state.tabs[tabIndex(tabId)];
    if (!fresh || fresh.kind !== "table" || tokenOf(tabId) !== token) return false;
    patchTab(tab.id, { rows: concatRows(fresh.rows, more.rows), hasMore: more.hasMore, loading: false });
    return true;
  } catch (err) {
    if (tokenOf(tabId) !== token) return false;
    patchTab(tab.id, { loading: false });
    notify("No se pudieron cargar más filas", "error", errorText(err));
    return false;
  }
}

/** The explorer's row estimate for a table ("~200000 filas"), to show real progress while loading it. */
function estimatedRows(tab: TableTab): number | null {
  const prefix = `${tab.connId}\u0000`;
  for (const [key, entry] of Object.entries(state.tree)) {
    if (!key.startsWith(prefix) || !entry?.nodes) continue;
    for (const node of entry.nodes) {
      if (node.name !== tab.obj.name || (node.kind !== "table" && node.kind !== "view")) continue;
      if (tab.obj.schema && !node.path.includes(tab.obj.schema)) continue;
      const match = /~?\s*([\d.,]+)\s*filas/.exec(node.detail ?? "");
      const n = match ? Number(match[1].replace(/[.,]/g, "")) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** Rows kept in memory by "Cargar todo"; beyond this, exporting streams to disk instead. */
export const LOAD_ALL_LIMIT = 1_000_000;

/**
 * Loads every remaining row in large chunks behind the busy overlay. Cancel stops after the chunk in
 * flight and keeps what was loaded; the UI stays responsive between chunks.
 */
export async function fetchAll(tabId: string) {
  if (busy[tabId]) return;
  let stop = false;
  const first = state.tabs[tabIndex(tabId)];
  // Exact count when known; otherwise the explorer's estimate (only without filters: they change the total).
  const total =
    first?.kind !== "table" ? null : first.totalCount ?? (!first.where.trim() && !first.filters.some((f) => f.enabled) ? estimatedRows(first) : null);
  startBusy(tabId, "Cargando todas las filas", () => (stop = true), total);
  const started = performance.now();
  try {
    for (let guard = 0; guard < 10_000 && !stop; guard++) {
      const tab = state.tabs[tabIndex(tabId)];
      if (!tab) return;
      const pending = tab.kind === "sql" ? tab.results.find((result) => result.hasMore) : tab.hasMore ? tab : null;
      if (!pending) break;
      const loaded = tab.kind === "sql" ? (pending as ResultSet).rows.length : tab.rows.length;
      updateBusy(tabId, { done: loaded });
      if (loaded >= LOAD_ALL_LIMIT) {
        notify(`Se han cargado ${LOAD_ALL_LIMIT.toLocaleString()} filas, el máximo en pantalla`, "warning", "Filtra para acotar o exporta el resultado completo: la exportación va directa a disco.");
        break;
      }
      // Large chunks: few IPC round trips and few array copies. Stop at the first failure.
      if (!(await fetchMore(tabId, Math.min(50_000, Math.max(5_000, loaded))))) break;
      // Give the window a frame between chunks so it never looks frozen.
      await nextPaint();
    }
  } finally {
    const tab = state.tabs[tabIndex(tabId)];
    const rows = !tab ? 0 : tab.kind === "sql" ? tab.results.reduce((sum, result) => sum + result.rows.length, 0) : tab.rows.length;
    endBusy(tabId);
    if (stop) notify(`Carga detenida con ${rows.toLocaleString()} filas`, "info", "Puedes seguir cargando más tarde con «Cargar todo».");
    else if (rows >= 100_000 && performance.now() - started > 800) {
      notify(
        `${rows.toLocaleString()} filas en memoria`,
        "info",
        tab?.kind === "table"
          ? "Ordenar y filtrar se hacen en el servidor; para análisis más grandes, exporta."
          : "Ordenar por columna se hace en local y puede tardar un momento; para más, añade ORDER BY o exporta.",
      );
    }
  }
}
/** Appends without going through the store proxies (fast for 100k+ rows). */
function concatRows(current: Cell[][], extra: Cell[][]): Cell[][] {
  const base = raw(current);
  const out = new Array<Cell[]>(base.length + extra.length);
  for (let i = 0; i < base.length; i++) out[i] = base[i];
  for (let i = 0; i < extra.length; i++) out[base.length + i] = extra[i];
  return out;
}

export async function changeAutocommit(on: boolean) {
  const tab = activeSql();
  if (!tab) return;
  try {
    const ready = await ensureSqlSession(tab);
    const inTransaction = await api().setAutocommit(ready.sessionId!, on);
    patchTab(ready.id, { autocommit: on, inTransaction });
    persistSoon();
  } catch (err) {
    notify(errorText(err), "error");
  }
}

export async function commitActive(rollback = false) {
  const tab = activeSql();
  if (!tab?.sessionId) return;
  try {
    const inTransaction = rollback ? await api().rollback(tab.sessionId) : await api().commit(tab.sessionId);
    patchTab(tab.id, { inTransaction });
    pushOutput(tab.id, { at: Date.now(), sql: rollback ? "ROLLBACK" : "COMMIT", ok: true, text: rollback ? "Transacción deshecha" : "Transacción confirmada", elapsedMs: null });
    notify(rollback ? "Rollback hecho" : "Commit hecho", "success");
    gib(rollback ? "rollback" : "commit");
  } catch (err) {
    notify(errorText(err), "error");
  }
}

export async function switchDatabase(database: string) {
  const tab = activeTab();
  const connId = tab?.connId;
  if (!connId) return;
  const session = state.sessions[connId];
  if (!session) return;
  try {
    if (tab?.kind === "sql" && tab.sessionId) {
      const used = await api().useDatabase(tab.sessionId, database);
      patchTab(tab.id, { database: used });
      void loadCompletion(tab.id);
    } else if (tab?.kind === "sql") {
      patchTab(tab.id, { database });
    }
  } catch (err) {
    notify(errorText(err), "error");
  }
}

// ---------------------------------------------------------------- table viewer

/** Opens a new session for a table tab (connecting first if needed) and selects its database; one at a time. */
const reopening = new Map<string, Promise<string>>();
function reopenTableSession(tabId: string): Promise<string> {
  const pending = reopening.get(tabId);
  if (pending) return pending;
  const job = (async () => {
    const tab = state.tabs[tabIndex(tabId)];
    if (!tab || tab.kind !== "table") throw new Error("La pestaña ya no existe");
    const opened = await openSessionFor(tab.connId, tab.obj.database);
    if (!opened) throw new Error("Sin conexión");
    if (tabIndex(tabId) < 0) {
      void api().closeSession(opened.sessionId).catch(() => {});
      throw new Error("La pestaña ya no existe");
    }
    patchTab(tabId, { sessionId: opened.sessionId });
    return opened.sessionId;
  })();
  reopening.set(tabId, job);
  void job.finally(() => reopening.delete(tabId)).catch(() => {});
  return job;
}

/** A new session for a connection (connecting first if needed); null when it cannot connect. */
/** The database each side session opened in: a table's first load needs no USE when it is already there. */
const sessionDatabase = new Map<string, string>();

/** A side session (a table, a count, a comparison…), straight in `database` when one is given. */
export async function openSessionFor(connId: string, database?: string) {
  if (!state.sessions[connId]) await connect(connId);
  if (!state.sessions[connId]) return null;
  const generation = connectGeneration(connId);
  const opened = await api()
    .openSession(connId, state.passwords[connId], { database: database || undefined })
    .catch((err: unknown) => (database ? api().openSession(connId, state.passwords[connId]) : Promise.reject(err)));
  // Disconnected while it opened: the core may have closed it already.
  if (connectGeneration(connId) !== generation || !state.sessions[connId]) {
    void api().closeSession(opened.sessionId).catch(() => {});
    throw new Error("La conexión se ha cerrado");
  }
  sessionDatabase.set(opened.sessionId, opened.database);
  return opened;
}

// ---------------------------------------------------------------- foreign keys

export interface ForeignKey {
  name: string;
  /** Columns of this table, and the referenced table and columns (same order). */
  columns: string[];
  target: ObjectRef;
  targetColumns: string[];
}

const unquote = (name: string) => name.trim().replace(/^["`[]|["`\]]$/g, "");

/** FK nodes of the "Claves" section: the core sends "cols → table(cols)" and the referenced table in `obj`. */
export function foreignKeys(tab: TableTab): ForeignKey[] {
  return parseForeignKeys(tab.keys, tab.obj);
}

/** FK nodes of the explorer ("cols → table(cols)") as foreign keys of `base`. */
function parseForeignKeys(nodes: MetaNode[], base: ObjectRef): ForeignKey[] {
  const out: ForeignKey[] = [];
  for (const node of nodes) {
    if (node.kind !== "key" || !node.obj) continue;
    const match = /^(.*?)\s*→\s*.*?\(([^()]*)\)\s*$/.exec(node.detail ?? "");
    const columns = match ? match[1].split(",").map(unquote).filter(Boolean) : [];
    const targetColumns = match ? match[2].split(",").map(unquote).filter(Boolean) : [];
    out.push({ name: node.name, columns, target: { ...node.obj, database: node.obj.database || base.database }, targetColumns });
  }
  return out;
}

/** The FK a column belongs to (single-column keys first). */
export function foreignKeyOf(tab: TableTab, column: string): ForeignKey | undefined {
  const fks = foreignKeys(tab).filter((fk) => fk.columns.includes(column));
  return fks.find((fk) => fk.columns.length === 1) ?? fks[0];
}

/**
 * Opens the table an FK points to. With `row` (values of this table's columns), opens it filtered to the
 * referenced row(s), like "go to referenced row" in DataGrip.
 */
export async function followForeignKey(tab: TableTab, fk: ForeignKey, row?: Record<string, Cell>) {
  const filters: ColumnFilter[] = [];
  if (row && fk.targetColumns.length === fk.columns.length) {
    fk.columns.forEach((col, i) => {
      const value = row[col];
      filters.push({ id: uid(), col: fk.targetColumns[i], op: value === null || value === undefined ? "null" : "eq", value: value === null || value === undefined ? "" : cellText(value), value2: "", values: [], enabled: true });
    });
  }
  await openTable(tab.connId, fk.target, "data", filters);
}

/**
 * Opens a table (or brings its tab forward). `options` are an assistant's (#100): `background` adds the tab without
 * making it active, `where` / `orderBy` start it filtered and ordered. Returns the tab's id.
 */
export async function openTable(
  connId: string,
  obj: ObjectRef,
  section: TableTab["section"] = "data",
  filters: ColumnFilter[] = [],
  options: { background?: boolean; where?: string; orderBy?: string } = {},
): Promise<string | undefined> {
  if (forwardFromPanel("open-table", { connId, obj, section, filters })) return;
  const query = options.where !== undefined || options.orderBy !== undefined ? { where: options.where ?? "", orderBy: options.orderBy ?? "", filters: [] as ColumnFilter[], sort: null } : null;
  const existing = state.tabs.find((tab) => tab.kind === "table" && tab.connId === connId && tab.obj.name === obj.name && tab.obj.schema === obj.schema && tab.obj.database === obj.database);
  if (existing) {
    // A restored tab not loaded yet loads once here (with the filters, if any), not again when it is shown.
    const restored = existing.kind === "table" && existing.restored;
    if (restored) patchTab(existing.id, { restored: false, ...(filters.length ? { filters, where: "", section: "data" as const } : {}), ...(query ?? {}) });
    if (!options.background) selectTab(existing.id);
    if (section !== "data") patchTab(existing.id, { section });
    if (restored) {
      void reloadTable(existing.id, true);
    } else if (filters.length && (await guardDirty(existing.id))) {
      patchTab(existing.id, { filters, where: "", section: "data" });
      void reloadTable(existing.id);
    } else if (query && (await guardDirty(existing.id))) {
      patchTab(existing.id, query);
      void reloadTable(existing.id);
    }
    return existing.id;
  }
  const opened = await openSessionFor(connId, obj.database).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) return;
  const id = uid();
  const tab = blankTable(id, connId, obj, opened.sessionId, obj.database || opened.database, section, filters);
  if (query) Object.assign(tab, query);
  setState("tabs", [...state.tabs, tab]);
  persistSoon();
  if (!options.background) setState("activeTabId", id);
  await reloadTable(id, true);
  return id;
}

export async function reloadTable(tabId: string, full = false) {
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "table") return;
  patchTab(tabId, { loading: true, error: "", errorAt: null, edits: {}, deleted: [], inserts: [] });
  // Filters, WHERE, ORDER BY and sort all go through a reload: keep the workspace file in step.
  persistSoon();
  let select = "";
  const token = tokenOf(tabId);
  try {
    // After a disconnect the tab has no session: open a new one (connecting first if needed).
    if (!tab.sessionId) await reopenTableSession(tabId);
    let current = state.tabs[tabIndex(tabId)] as TableTab;
    const sid = current.sessionId;
    if (full || !current.baseSelect) {
      // Opened in the table's database already: no USE (one round trip less on every engine but PostgreSQL).
      if (tab.obj.database && sessionDatabase.get(sid)?.toLowerCase() !== tab.obj.database.toLowerCase()) {
        await api().useDatabase(sid, tab.obj.database).then((db) => sessionDatabase.set(sid, db)).catch(() => {});
      }
      const [columnsMeta, sqlInfo, ddl] = await Promise.all([
        api().tableColumns(sid, tab.obj),
        api().objectSql(sid, tab.obj),
        api().objectDdl(sid, tab.obj).catch((err) => `-- ${errorText(err)}`),
      ]);
      const quoted = await api().quoteIdents(sid, columnsMeta.map((col) => col.name));
      const schema = tab.obj.schema || "main";
      const folder = tab.obj.kind === "view" ? "views" : "tables";
      const base = [tab.obj.database || tab.database || "main", schema, folder, tab.obj.name];
      const [indexes, keys] = await Promise.all([
        api().metaChildren(sid, [...base, "indexes"]).catch(() => [] as MetaNode[]),
        api().metaChildren(sid, [...base, "fks"]).catch(() => [] as MetaNode[]),
      ]);
      patchTab(tabId, { columnsMeta, quoted, qualified: sqlInfo.qualified, baseSelect: sqlInfo.select, ddl, indexes, keys });
      current = state.tabs[tabIndex(tabId)] as TableTab;
    }
    select = current.baseSelect;
    const where = tableWhere(current);
    if (where) select += ` WHERE ${where}`;
    const order = tableOrderBy(current);
    if (order) select += ` ORDER BY ${order}`;
    if (current.totalCount !== null) patchTab(tabId, { totalCount: null });
    // Slow filters or sorts on big tables: the overlay (after a short delay) offers to cancel on the server.
    let cancelled = false;
    startBusy(tabId, where || order ? "Filtrando y ordenando en el servidor" : "Consultando el servidor", () => {
      cancelled = true;
      void api().cancel(sid).catch(() => {});
    });
    const output = await api().execute(sid, select, state.settings.pageSize).catch((err) => {
      throw cancelled ? new Error("Consulta cancelada. La tabla muestra los datos anteriores.") : err;
    }).finally(() => endBusy(tabId));
    if (tokenOf(tabId) !== token) return;
    const result = output.results.find((item) => item.columns.length) ?? { columns: [], rows: [], hasMore: false, rowsAffected: null };
    if (tabIndex(tabId) < 0) return;
    patchTab(tabId, {
      loading: false,
      error: "",
      errorAt: null,
      elapsedMs: output.elapsedMs,
      gridCols: result.columns.length ? withColumnTypes(result.columns, current.columnsMeta) : current.columnsMeta.map((col) => ({ name: col.name, typeName: col.typeName, kind: col.kind })),
      rows: result.rows,
      hasMore: result.hasMore,
    });
  } catch (err) {
    if (tokenOf(tabId) !== token) return;
    let message = errorText(err);
    // The connection dropped and the core could not bring it back (or a write was not repeated): the tab shows it.
    if (noteDropped(tabId, tab.title, message)) message = plainError(message);
    // The engine's position counts over the generated SELECT: translate it to the WHERE the user typed.
    const typed = (state.tabs[tabIndex(tabId)] as TableTab | undefined)?.where.trim() ?? "";
    const errorAt = select ? wherePosition(message, select, typed) : null;
    if (errorAt !== null) message = message.replace(/Posici[oó]n:\s*l[ií]nea\s+\d+,\s*columna\s+\d+/i, `En tu WHERE, carácter ${errorAt + 1}`);
    // A session closed behind our back (disconnect, server restart): drop it so Reintentar reopens one.
    patchTab(tabId, { loading: false, error: message, errorAt, ...(/sesi[oó]n (no encontrada|cerrada)/i.test(message) ? { sessionId: "" } : {}) });
  }
}

export async function reloadTableSafe(tabId: string) {
  if (await guardDirty(tabId)) await reloadTable(tabId);
}

/** Asks before throwing away unsaved edits of a table tab. Returns false when the user keeps them. */
export async function guardDirty(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table" || !tableDirty(tab)) return true;
  return confirmDialog(`Descartar cambios en ${tab.title}`, "Recargar la tabla (orden, filtros o F5) descarta las ediciones que no has guardado.", "Descartar y recargar", true);
}

function withColumnTypes(columns: ColumnInfo[], meta: TableColumn[]): ColumnInfo[] {
  return columns.map((col) => {
    const found = meta.find((item) => item.name === col.name);
    return found ? { ...col, typeName: found.typeName || col.typeName } : col;
  });
}

export async function setTableFilter(tabId: string, where: string, orderBy: string) {
  if (!(await guardDirty(tabId))) return;
  patchTab(tabId, { where, orderBy, sort: orderBy.trim() ? null : (state.tabs[tabIndex(tabId)] as TableTab | undefined)?.sort ?? null });
  void reloadTable(tabId);
}

export function filterLabel(filter: ColumnFilter) {
  const op = FILTER_OPS.find((item) => item.op === filter.op);
  if (!op) return filter.col;
  if (op.arity === 0) return `${filter.col} ${op.short}`;
  if (op.arity === 2) return `${filter.col} entre ${filter.value} y ${filter.value2}`;
  if (op.arity === "list") {
    const shown = filter.values.map((value) => (value === "\u0000NULL" ? "NULL" : value));
    return `${filter.col} ${op.short} (${shown.slice(0, 3).join(", ")}${shown.length > 3 ? ` +${shown.length - 3}` : ""})`;
  }
  return `${filter.col} ${op.short} ${filter.value}`;
}

export function tableWhere(tab: TableTab) {
  return whereOf(tab, kindOf(tab.connId));
}

function tableOrderBy(tab: TableTab) {
  if (tab.orderBy.trim()) return tab.orderBy.trim();
  if (tab.sort) {
    const ident = tab.quoted[tab.sort.col] ?? tab.gridCols[tab.sort.col]?.name;
    if (ident) return `${ident} ${tab.sort.dir === 1 ? "ASC" : "DESC"}`;
  }
  return "";
}

export async function upsertTableFilter(tabId: string, filter: Omit<ColumnFilter, "id"> & { id?: string }) {
  if (!(await guardDirty(tabId))) return;
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table") return;
  const next: ColumnFilter = { ...filter, id: filter.id || uid() };
  const filters = tab.filters.some((item) => item.id === next.id) ? tab.filters.map((item) => (item.id === next.id ? next : item)) : [...tab.filters, next];
  patchTab(tabId, { filters });
  void reloadTable(tabId);
}

export async function removeTableFilter(tabId: string, id?: string) {
  if (!(await guardDirty(tabId))) return;
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table") return;
  patchTab(tabId, { filters: id ? tab.filters.filter((item) => item.id !== id) : [] });
  void reloadTable(tabId);
}

export async function toggleTableFilter(tabId: string, id: string) {
  if (!(await guardDirty(tabId))) return;
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table") return;
  patchTab(tabId, { filters: tab.filters.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item)) });
  void reloadTable(tabId);
}

export async function setTableSort(tabId: string, sort: TableTab["sort"]) {
  if (!(await guardDirty(tabId))) return;
  patchTab(tabId, { sort, orderBy: "" });
  void reloadTable(tabId);
}

/** Exact row count for the current filters, on a short-lived side session so the open cursor is untouched. */
export async function countTable(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table" || tab.counting) return;
  patchTab(tabId, { counting: true });
  const opened = await api().openSession(tab.connId, state.passwords[tab.connId]).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) {
    patchTab(tabId, { counting: false });
    return;
  }
  try {
    if (tab.obj.database) await api().useDatabase(opened.sessionId, tab.obj.database).catch(() => {});
    const where = tableWhere(tab);
    const output = await api().execute(opened.sessionId, `SELECT COUNT(*) FROM ${tab.qualified}${where ? ` WHERE ${where}` : ""}`, 1);
    const value = output.results.find((result) => result.columns.length)?.rows[0]?.[0];
    const now = state.tabs[tabIndex(tabId)];
    // Filters changed while counting: the number would describe another query.
    if (!now || now.kind !== "table" || tableWhere(now) !== where) {
      if (now) patchTab(tabId, { counting: false });
      return;
    }
    patchTab(tabId, { totalCount: value === null || value === undefined ? null : Number(value), counting: false });
  } catch (err) {
    patchTab(tabId, { counting: false });
    notify("No se pudo contar", "error", errorText(err));
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
}

export function setTableSection(tabId: string, section: TableTab["section"]) {
  patchTab(tabId, { section });
  persistSoon();
}

export function tableDirty(tab: TableTab) {
  return Object.keys(tab.edits).length > 0 || tab.deleted.length > 0 || tab.inserts.length > 0;
}

export function displayRows(tab: TableTab): Cell[][] {
  const base = raw(tab.rows);
  const editKeys = Object.keys(tab.edits);
  if (!editKeys.length && !tab.inserts.length) return base;
  // Copy only the rows that have edits; the rest are shared with the loaded data (fast with 200k rows).
  const out = base.slice();
  for (const key of editKeys) {
    const [rowText, colText] = key.split(":");
    const row = Number(rowText);
    if (!out[row]) continue;
    if (out[row] === base[row]) out[row] = base[row].slice();
    out[row][Number(colText)] = tab.edits[key];
  }
  for (const insert of raw(tab.inserts)) out.push(insert);
  return out;
}
export function editCell(tabId: string, row: number, col: number, value: string | null) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table") return;
  if (row >= tab.rows.length) {
    const insertIndex = row - tab.rows.length;
    const next = tab.inserts.map((line) => line.slice());
    next[insertIndex][col] = value;
    patchTab(tab.id, { inserts: next });
    return;
  }
  const original = tab.rows[row]?.[col];
  const same = (original === null && value === null) || (original !== null && value !== null && String(original) === value);
  const edits = { ...tab.edits };
  if (same) delete edits[`${row}:${col}`];
  else edits[`${row}:${col}`] = value;
  patchTab(tab.id, { edits });
}

export function insertTableRow(tabId: string, from?: number) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table") return;
  const source = from !== undefined ? displayRows(tab)[from] : undefined;
  const row = tab.columnsMeta.map((col, index) => {
    if (!source || col.primaryKey || col.identity) return null;
    const value = source[index];
    return value === null || value === undefined ? null : String(value);
  });
  patchTab(tab.id, { inserts: [...tab.inserts, row] });
}

/** Undoes pending changes: one cell's edit, or everything on a row (edits, its deletion, or the new row itself). */
export function revertTableChange(tabId: string, row: number, col: number | null) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table") return;
  if (row >= tab.rows.length) {
    if (col === null) patchTab(tabId, { inserts: tab.inserts.filter((_, offset) => tab.rows.length + offset !== row) });
    return;
  }
  const edits = Object.fromEntries(Object.entries(tab.edits).filter(([key]) => (col === null ? !key.startsWith(`${row}:`) : key !== `${row}:${col}`)));
  patchTab(tabId, { edits, ...(col === null ? { deleted: tab.deleted.filter((index) => index !== row) } : {}) });
}

export function deleteTableRows(tabId: string, rows: number[]) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table") return;
  const existing = rows.filter((row) => row < tab.rows.length);
  const inserts = tab.inserts.filter((_, offset) => !rows.includes(tab.rows.length + offset));
  const deleted = new Set(tab.deleted);
  for (const row of existing) {
    if (deleted.has(row)) deleted.delete(row);
    else deleted.add(row);
  }
  patchTab(tab.id, { deleted: [...deleted], inserts });
}

export function revertTable(tabId: string) {
  patchTab(tabId, { edits: {}, deleted: [], inserts: [] });
}

export function buildChanges(tab: TableTab): string {
  return changeStatements(tab, kindOf(tab.connId)).join("\n");
}

export async function saveTable(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table" || !tableDirty(tab)) return;
  const pk = tab.columnsMeta.some((col) => col.primaryKey);
  if (!pk && (tab.deleted.length || Object.keys(tab.edits).length)) {
    notify("Esta tabla no tiene clave primaria: no se pueden generar UPDATE ni DELETE seguros.", "warning");
    return;
  }
  const kind = kindOf(tab.connId);
  const statements = changeStatements(tab, kind);
  const sql = statements.join("\n");
  setState({
    previewSql: sql,
    previewRun: async () => {
      const current = state.tabs[tabIndex(tabId)];
      if (!current || current.kind !== "table") return;
      // After a disconnect the tab has no session: reconnect instead of failing with "session not found".
      const session = current.sessionId || (await reopenTableSession(tabId));
      // All changes apply atomically: one transaction, rolled back if any statement fails.
      await api().closeCursor(session).catch(() => {});
      await api().setAutocommit(session, false);
      let output;
      try {
        const ran = await api().execute(session, sql, 1);
        output = ran;
        // A keyed UPDATE or DELETE that matched no row (changed or deleted meanwhile, or a key that does not compare)
        // saved nothing: undo it all. MySQL counts only changed rows, so an UPDATE to the same value says 0 there.
        if (ran.results.length === statements.length) {
          const missed = statements.findIndex((statement, i) => ran.results[i].rowsAffected === 0 && (statement.startsWith("DELETE ") || (statement.startsWith("UPDATE ") && kind !== "mysql")));
          if (missed >= 0) throw new Error(`La fila ya no está en la tabla o su clave no coincide:\n${statements[missed]}`);
        }
        await api().commit(session);
      } catch (err) {
        await api().rollback(session).catch(() => {});
        throw err;
      } finally {
        await api().setAutocommit(session, true).catch(() => {});
      }
      setState({ previewSql: "", previewRun: null });
      const affected = output.results.reduce((sum, result) => sum + (result.rowsAffected ?? 0), 0);
      notify(`Cambios guardados · ${rowsLabel(affected)} ${affected === 1 ? "afectada" : "afectadas"}`, "success");
      gib("saved");
      await reloadTable(tabId);
    },
  });
}

export async function runPreview() {
  try {
    await state.previewRun?.();
  } catch (err) {
    setState({ previewSql: "", previewRun: null });
    notify("No se guardó nada: la operación se deshizo", "error", errorText(err));
  }
}

export function canEdit(tab: TableTab) {
  const conn = connectionById(tab.connId);
  return (
    tab.obj.kind !== "view" &&
    !conn?.readOnly &&
    tab.columnsMeta.some((col) => col.primaryKey) &&
    // A binary key needs the engine's binary literal to find its row.
    (binaryKeysWritable(kindOf(tab.connId)) || !tab.columnsMeta.some((col) => col.primaryKey && col.kind === "binary"))
  );
}

// ---------------------------------------------------------------- object actions

export type GenerateKind = "select" | "select-join" | "insert" | "update" | "delete" | "upsert" | "drop" | "ddl" | "count";

/**
 * Writes a statement for a table or view in the console (the active one of the same connection, else a new
 * one). Values are :name parameters, so running it asks for them. DROP is written, never run.
 */
export async function generateSql(connId: string, obj: ObjectRef, kind: GenerateKind, nodePath: string[] = []) {
  const opened = await openSessionFor(connId).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) return;
  const dialect = kindOf(connId);
  try {
    if (obj.database) await api().useDatabase(opened.sessionId, obj.database).catch(() => {});
    if (kind === "ddl") {
      const ddl = await api().objectDdl(opened.sessionId, obj);
      openQuery(connId, ddl, `${obj.name}.sql`);
      return;
    }
    const [columns, info] = await Promise.all([api().tableColumns(opened.sessionId, obj).catch(() => [] as TableColumn[]), api().objectSql(opened.sessionId, obj)]);
    const quoted = await api().quoteIdents(opened.sessionId, columns.map((col) => col.name));
    const params = paramNamesFor(columns.map((col) => col.name));
    const q = info.qualified;
    const indexed = columns.map((col, index) => ({ col, index }));
    const pk = indexed.filter((item) => item.col.primaryKey);
    const keyCols = pk.length ? pk : indexed.slice(0, 1);
    const where = keyCols.map((item) => `${quoted[item.index]} = ${params[item.index]}`).join("\n  AND ");
    const writable = indexed.filter((item) => !item.col.identity);
    const limit = selectLimit(dialect, 100, opened.serverInfo);
    let sql = "";
    if (kind === "select") sql = `SELECT ${limit.top}${quoted.length ? quoted.join(",\n       ") : "*"}\nFROM ${q}\n${limit.tail};`;
    if (kind === "count") sql = `SELECT COUNT(*) FROM ${q};`;
    if (kind === "insert") sql = `INSERT INTO ${q} (${writable.map((item) => quoted[item.index]).join(", ")})\nVALUES (${writable.map((item) => params[item.index]).join(", ")});`;
    if (kind === "update") {
      const sets = indexed.filter((item) => !item.col.primaryKey).map((item) => `${quoted[item.index]} = ${params[item.index]}`).join(",\n    ");
      sql = `UPDATE ${q}\nSET ${sets}\nWHERE ${where};`;
    }
    if (kind === "delete") sql = `DELETE FROM ${q}\nWHERE ${where};`;
    if (kind === "drop") {
      // Materialized views are listed with the views (PostgreSQL), but they are dropped differently.
      const what = nodePath.includes("matviews") ? "MATERIALIZED VIEW" : obj.kind === "view" ? "VIEW" : "TABLE";
      sql = `-- Revisa antes de ejecutar: borra ${what === "TABLE" ? "la tabla y todos sus datos" : "la vista"}.\nDROP ${what} ${q};`;
    }
    if (kind === "upsert") {
      // The key decides between insert and update: without a primary key there is no safe one to use.
      if (!pk.length) {
        notify(`«${obj.name}» no tiene clave primaria: no se puede generar un UPSERT seguro`, "warning", "Sin clave, el MERGE actualizaría todas las filas que compartan la primera columna.");
        return;
      }
      // Key columns always go in (even identity ones, or the conflict could never happen); other identity
      // columns are left to the database.
      const keys = pk.map((item) => item.index);
      const cols = indexed.filter((item) => keys.includes(item.index) || !item.col.identity).map((item) => item.index);
      const identityKey = pk.some((item) => item.col.identity);
      const insertable = indexed.filter((item) => !item.col.identity).map((item) => item.index);
      sql = upsertSql(dialect, q, quoted, params, cols, keys, identityKey, insertable);
    }
    if (kind === "select-join") {
      const base = [obj.database || opened.database || "main", obj.schema || "main", obj.kind === "view" ? "views" : "tables", obj.name, "fks"];
      const fks = parseForeignKeys(await api().metaChildren(opened.sessionId, base).catch(() => [] as MetaNode[]), obj).filter((fk) => fk.columns.length && fk.columns.length === fk.targetColumns.length);
      const lines = [`SELECT ${limit.top}t0.*${fks.map((_, i) => `,\n       t${i + 1}.*`).join("")}`, `FROM ${q} t0`];
      for (const [i, fk] of fks.entries()) {
        const target = await api().objectSql(opened.sessionId, fk.target).then((r) => r.qualified).catch(() => fk.target.name);
        const left = await api().quoteIdents(opened.sessionId, fk.columns);
        const right = await api().quoteIdents(opened.sessionId, fk.targetColumns);
        lines.push(`LEFT JOIN ${target} t${i + 1} ON ${left.map((col, j) => `t${i + 1}.${right[j]} = t0.${col}`).join(" AND ")}`);
      }
      sql = `${lines.join("\n")}\n${limit.tail};`;
      if (!fks.length) notify(`«${obj.name}» no tiene claves foráneas: es un SELECT normal`, "info");
    }
    const tab = activeSql();
    if (tab && tab.connId === connId) insertIntoActive((tab.sql.trim() ? "\n\n" : "") + sql);
    else openQuery(connId, sql);
    if (!state.settings.askParams && /\s:[a-z_]/i.test(sql)) {
      notify("La sentencia lleva :parámetros", "info", "Sustitúyelos por valores, o activa «Pedir el valor de los parámetros» en Ajustes › Editor para que Celer los pida al ejecutar.");
    }
  } catch (err) {
    notify(errorText(err), "error");
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
}

export async function copyText(text: string, label = "Copiado") {
  try {
    await navigator.clipboard.writeText(text);
    notify(label, "success");
  } catch {
    notify("No se pudo copiar al portapapeles", "error");
  }
}

// ---------------------------------------------------------------- tabs

/** A console opened from or saved to a file whose text differs from what the file holds. */
export function fileDirty(tab: SqlTab): boolean {
  return Boolean(tab.filePath) && tab.fileSaved !== undefined && tab.sql !== tab.fileSaved;
}

export async function closeTab(id: string) {
  const tab = state.tabs.find((item) => item.id === id);
  if (tab?.kind === "table" && tableDirty(tab)) {
    const ok = await confirmDialog(`Descartar cambios en ${tab.title}`, "Hay ediciones sin guardar en esta tabla.", "Descartar", true);
    if (!ok) return;
  }
  if (tab?.kind === "sql" && (tab.libraryId ? libraryDirty(tab.libraryId) : fileDirty(tab))) {
    const where = tab.libraryId ? "la biblioteca" : "el fichero";
    const ok = await confirmDialog(`Descartar cambios en ${tab.title}`, `La consola tiene cambios que no se han guardado en ${where}.`, "Descartar", true);
    if (!ok) return;
  }
  if (tab?.kind === "sql" && tab.inTransaction) {
    const ok = await confirmDialog("Transacción abierta", "La consola tiene una transacción sin confirmar. Al cerrarla se deshará (rollback).", "Cerrar y deshacer", true);
    if (!ok) return;
  }
  if (tab?.sessionId) await api().closeSession(tab.sessionId).catch(() => {});
  const position = state.tabs.findIndex((item) => item.id === id);
  const tabs = state.tabs.filter((item) => item.id !== id);
  setState("tabs", tabs);
  if (state.activeTabId === id) setState("activeTabId", tabs[Math.min(position, tabs.length - 1)]?.id ?? "");
  persistSoon();
}

export async function closeOtherTabs(id: string) {
  for (const tab of state.tabs.filter((item) => item.id !== id)) await closeTab(tab.id);
}

/** Why a tab cannot go to another window right now ("" when it can): its answer would arrive here. */
export function tabMoveBlocker(tab: Tab): string {
  if (tab.kind === "sql" && tab.running) return "La consola está ejecutando: espera a que termine o detenla antes de moverla";
  if (tab.kind === "table" && (tab.loading || tab.counting)) return "La tabla está cargando: espera a que termine antes de moverla";
  if (openingSql.has(tab.id) || reopening.has(tab.id)) return "La pestaña está conectando: prueba otra vez en un momento";
  return "";
}

/**
 * Takes a tab out of this window without closing its session: it goes on in another window (windows.ts) with the
 * same connection, transaction, pending rows and #temp tables.
 */
export function detachTab(id: string) {
  const position = tabIndex(id);
  if (position < 0) return;
  // Anything still on its way for it belongs to the other window now.
  bumpToken(id);
  delete rememberedParams[id];
  const tabs = state.tabs.filter((item) => item.id !== id);
  setState("tabs", tabs);
  if (state.activeTabId === id) setState("activeTabId", tabs[Math.min(position, tabs.length - 1)]?.id ?? "");
  persistSoon();
}

/** A tab from another window, at `index` (the end when null), with its session as it was. */
export function adoptTab(tab: Tab, index: number | null) {
  if (tabIndex(tab.id) >= 0) return;
  setState("tabs", insertAt(state.tabs, [tab], index));
  setState("activeTabId", tab.id);
  persistSoon();
}

/** Closes tabs without asking (their window is closing and the user chose so): their sessions end. */
export async function closeTabsQuietly(ids: string[]) {
  const closing = state.tabs.filter((tab) => ids.includes(tab.id));
  if (!closing.length) return;
  for (const tab of closing) bumpToken(tab.id);
  setState("tabs", state.tabs.filter((tab) => !ids.includes(tab.id)));
  if (!state.tabs.some((tab) => tab.id === state.activeTabId)) setState("activeTabId", state.tabs[0]?.id ?? "");
  await Promise.all(closing.map((tab) => (tab.sessionId ? api().closeSession(tab.sessionId).catch(() => {}) : Promise.resolve())));
}

/** The sessions this window opened besides its tabs' (explorer, activity monitor, export), before it closes. */
export async function releaseWindowSessions() {
  if (state.exportRunning) await cancelExport().catch(() => {});
  if (state.activity) closeActivity();
  await Promise.all(Object.values(state.sessions).map((session) => api().closeSession(session.metaId).catch(() => {})));
}

export function selectTab(id: string) {
  setState("activeTabId", id);
  persistSoon();
}

export function cycleTab(step: number) {
  if (!state.tabs.length) return;
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const next = (index + step + state.tabs.length) % state.tabs.length;
  selectTab(state.tabs[next].id);
}

export function moveTab(from: number, to: number) {
  if (from === to) return;
  const tabs = state.tabs.slice();
  const [item] = tabs.splice(from, 1);
  tabs.splice(to, 0, item);
  setState("tabs", tabs);
  persistSoon();
}

export function renameTab(id: string, title: string) {
  if (!title.trim()) return;
  patchTab(id, { title: title.trim() });
  persistSoon();
}

export function setActiveResult(tabId: string, index: number) {
  patchTab(tabId, { activeResult: index, activePinned: null, activePlan: false, compare: null });
}

export function showPlan(tabId: string) {
  patchTab(tabId, { activePlan: true, activePinned: null, compare: null });
}

/**
 * Keeps the result on show aside: it stays in its own result tab, with the SQL that produced it, until it is
 * closed (later runs replace only the current results). Pages not loaded yet are not part of it.
 */
export function pinResult(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (tab?.kind !== "sql" || tab.activeResult < 0) return;
  const result = tab.results[tab.activeResult];
  if (!result?.columns.length) return;
  const grids = tab.results.filter((item) => item.columns.length);
  const pin: PinnedResult = {
    id: uid(),
    title: `Fijado ${tab.pinned.length + 1}`,
    // The statement behind this result when the run was a script (its title, and what exporting it reads).
    sql: exportStatement(tab.resultsSql || tab.lastSql, kindOf(tab.connId), grids.indexOf(result), grids.length) ?? (tab.resultsSql || tab.lastSql),
    at: Date.now(),
    result: { ...result, hasMore: false },
  };
  patchTab(tabId, { pinned: [...tab.pinned, pin], activePinned: pin.id });
  if (result.hasMore) notify("Resultado fijado con las filas cargadas", "info", "Las páginas pendientes no se incluyen: usa «Cargar todo» antes de fijar si las necesitas.");
}

export function showPinned(tabId: string, pinId: string) {
  patchTab(tabId, { activePinned: pinId, activePlan: false, compare: null });
}

export function unpinResult(tabId: string, pinId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (tab?.kind !== "sql") return;
  patchTab(tabId, {
    pinned: tab.pinned.filter((pin) => pin.id !== pinId),
    activePinned: tab.activePinned === pinId ? null : tab.activePinned,
    compare: tab.compare?.pinId === pinId ? null : tab.compare,
  });
}

/** The result a pinned one is compared with: the current result on show, else the first one with rows. */
export function currentResultOf(tab: SqlTab): ResultSet | undefined {
  const active = tab.activeResult >= 0 ? tab.results[tab.activeResult] : undefined;
  return active?.columns.length ? active : tab.results.find((r) => r.columns.length);
}

/** Compares a pinned result with the current one (in the results area, until closed). */
export function compareWithCurrent(tabId: string, pinId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (tab?.kind !== "sql") return;
  if (!currentResultOf(tab)) {
    notify("No hay un resultado actual con filas para comparar", "warning", "Ejecuta la consulta (otra vez, o una distinta) y compara el resultado fijado con el nuevo.");
    return;
  }
  patchTab(tabId, { compare: { pinId, key: null }, activePinned: null, activePlan: false });
}

export function setCompareKey(tabId: string, key: string[] | null) {
  const tab = state.tabs[tabIndex(tabId)];
  if (tab?.kind !== "sql" || !tab.compare) return;
  patchTab(tabId, { compare: { ...tab.compare, key } });
}

export function closeCompare(tabId: string) {
  patchTab(tabId, { compare: null });
}

// ---------------------------------------------------------------- history / inspector

export async function refreshHistory() {
  setState("history", await api().getHistory(state.historyQuery, 300));
}

/**
 * Shows a side panel. The library and the assistant may be in a window of their own: that window comes to the front
 * instead, unless `docked` (the library asking for a script's name needs this window's panel).
 */
export function openInspector(mode: InspectorMode, docked = false) {
  if (!docked && (mode === "library" || mode === "ai") && raisePanel(mode)) return;
  setState({ inspectorOpen: true, inspectorMode: mode });
  if (mode === "history") void refreshHistory();
}

export function toggleInspector(mode: InspectorMode) {
  if (state.inspectorOpen && state.inspectorMode === mode) setState("inspectorOpen", false);
  else openInspector(mode);
}

export async function useHistory(sql: string, connId?: string) {
  const tab = activeSql();
  if (!tab) {
    openQuery(connId || null, sql);
    return;
  }
  setState("tabs", tabIndex(tab.id), { sql, revision: tab.revision + 1, cursor: sql.length } as Partial<SqlTab>);
  persistSoon();
}

export async function clearHistory() {
  const ok = await confirmDialog("Vaciar historial", "Se borrarán todas las consultas guardadas en el historial.", "Vaciar", true);
  if (!ok) return;
  await api().clearHistory();
  setState("history", []);
}

// ---------------------------------------------------------------- dialogs

export function confirmDialog(title: string, body: string, confirmLabel: string, danger = false) {
  dismissConfirm();
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
    setState("confirm", {
      title,
      body,
      confirmLabel,
      danger,
      run: () => {
        const done = confirmResolve;
        confirmResolve = null;
        setState("confirm", null);
        done?.(true);
      },
    });
  });
}

export function dismissConfirm() {
  const done = confirmResolve;
  confirmResolve = null;
  setState("confirm", null);
  done?.(false);
}

export function openMenu(event: MouseEvent, items: MenuItem[]) {
  event.preventDefault();
  event.stopPropagation();
  setState("menu", { x: event.clientX, y: event.clientY, items });
}

export function closeMenu() {
  if (state.menu) setState("menu", null);
}

export function openPalette(mode: "all" | "actions" | "tables" = "all") {
  setState({ paletteOpen: true, paletteMode: mode });
}

// ---------------------------------------------------------------- export / files

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown" | "html" | "xml" | "xlsx";

export interface ExportSource {
  connId: string;
  database: string;
  sql: string;
  /** What is being exported, for the dialog title ("orders", "consulta"). */
  label: string;
  /** Table name used by SQL INSERT exports. */
  tableName: string;
  /** The grid's column order (headers dragged): the file follows what is on screen. */
  columnOrder?: ColumnOrder;
}

/**
 * Column order of the grid on show in each tab, when its headers were dragged. Not reactive and not saved: the grid
 * reports it (and clears it when it goes away or gets another result) and only an export reads it.
 */
const gridColumnOrders = new Map<string, ColumnOrder>();

export function setGridColumnOrder(tabId: string, order: ColumnOrder | null) {
  if (order) gridColumnOrders.set(tabId, order);
  else gridColumnOrders.delete(tabId);
}

const EXT: Record<ExportFormat, string> = { csv: "csv", tsv: "tsv", json: "json", sql: "sql", markdown: "md", html: "html", xml: "xml", xlsx: "xlsx" };

function openExport(source: ExportSource) {
  setState({ exportOpen: true, exportSource: source, exportRows: 0, exportRunning: false, exportPath: "" });
  setState("exportOpts", "tableName", source.tableName);
}

/**
 * Export the statement of the active console: `sqlOverride` (a pinned result's SQL), else the one behind the
 * result on show, else the selection or the one under the cursor. Only a statement that reads is exported: the
 * export runs it again, and a script's writes must not run a second time.
 */
export async function startExport(sqlOverride?: string) {
  const tab = activeTab();
  if (tab?.kind === "table") return startTableExport(tab.id);
  if (!tab || tab.kind !== "sql") return;
  if (!connectionById(tab.connId)) {
    notify("Elige una conexión", "warning");
    return;
  }
  const kind = kindOf(tab.connId);
  const grids = tab.results.filter((result) => result.columns.length);
  const shown = tab.results[tab.activeResult];
  let source: string;
  let sql: string | null;
  if (sqlOverride) {
    source = sqlOverride;
    sql = exportStatement(source, kind, 0, 1);
  } else if (tab.resultsSql && shown?.columns.length) {
    source = tab.resultsSql;
    sql = exportStatement(source, kind, grids.indexOf(shown), grids.length);
  } else {
    source = tab.selection.trim() || statementAt(tab.sql, tab.cursor, kind);
    sql = exportStatement(source, kind, 0, 1);
  }
  if (!source.trim()) return;
  if (!sql) {
    notify("Solo se exporta una consulta de lectura", "warning", "La exportación vuelve a ejecutar la consulta. Selecciona la SELECT que quieres exportar: las demás sentencias del script no se repiten.");
    return;
  }
  const from = /\bfrom\s+([\w."`\[\]]+)/i.exec(sql)?.[1]?.replace(/["`\[\]]/g, "") ?? "resultado";
  openExport({ connId: tab.connId!, database: tab.database, sql: sql.replace(/;\s*$/, ""), label: "el resultado de la consulta", tableName: from, columnOrder: gridColumnOrders.get(tab.id) });
}

/** Export a table tab with its current filters and order. */
export function startTableExport(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table" || !tab.baseSelect) return;
  let sql = tab.baseSelect;
  const where = tableWhere(tab);
  if (where) sql += ` WHERE ${where}`;
  const order = tableOrderBy(tab);
  if (order) sql += ` ORDER BY ${order}`;
  openExport({ connId: tab.connId, database: tab.obj.database || tab.database, sql, label: where ? `${tab.obj.name} (filtrada)` : tab.obj.name, tableName: tab.qualified, columnOrder: gridColumnOrders.get(tab.id) });
}

/** Export a whole table or view from the explorer. */
export async function startObjectExport(connId: string, obj: ObjectRef) {
  const opened = await openSessionFor(connId).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) return;
  try {
    const info = await api().objectSql(opened.sessionId, obj);
    openExport({ connId, database: obj.database, sql: info.select, label: obj.name, tableName: info.qualified });
  } catch (err) {
    notify(errorText(err), "error");
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
}

export async function runExport() {
  const source = state.exportSource;
  if (!source) return;
  const format = state.exportFormat;
  const ext = EXT[format];
  const base = (source.label.split(" ")[0] || "export").replace(/[^\w.-]+/g, "_");
  let path = state.exportPath;
  if (isTauri() && !path) {
    path = (await api().pickSavePath([{ name: format.toUpperCase(), extensions: [ext] }])) ?? "";
    if (!path) return;
    setState("exportPath", path);
  }
  const exportId = uid();
  setState({ exportRunning: true, exportRows: 0, exportId });
  const started = performance.now();
  try {
    const opts = state.exportOpts;
    const rows = await api().exportQuery(source.connId, source.database, source.sql, exportId, {
      format,
      path: path || `${base}.${ext}`,
      delimiter: format === "tsv" ? "\t" : opts.delimiter,
      header: opts.header,
      bom: opts.bom,
      tableName: opts.tableName || "resultado",
      nullText: opts.nullText,
      sqlBatch: opts.sqlBatch,
      columnOrder: source.columnOrder ?? null,
    });
    setState({ exportRows: rows, exportRunning: false, exportOpen: false, exportId: "" });
    const target = path;
    notify(`Exportadas ${rows.toLocaleString()} filas en ${formatMs(performance.now() - started)}`, "success", target || undefined, target && isTauri() ? { label: "Mostrar en la carpeta", run: () => void revealPath(target) } : undefined);
    gib("saved");
  } catch (err) {
    const cancelled = !state.exportRunning || /cancelada/i.test(errorText(err));
    setState({ exportRunning: false, exportId: "" });
    if (cancelled) notify("Exportación cancelada", "warning");
    else notify("La exportación falló", "error", errorText(err));
  }
}

/** Asks the export to stop; runExport reports the outcome (an export already on its last page still completes). */
export async function cancelExport() {
  const id = state.exportId;
  setState("exportRunning", false);
  if (id) await api().cancel(id).catch(() => {});
}

/**
 * Copies a compact, AI-ready description of a table (columns + DDL) or of a whole connection's schema
 * (every table with its columns) as Markdown, to paste into any assistant.
 */
export async function copySchemaForAi(connId: string, obj?: ObjectRef) {
  const conn = connectionById(connId);
  const engine = conn ? engineOf(conn.kind).label : "SQL";
  const opened = await openSessionFor(connId).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) return;
  try {
    if (obj?.database) await api().useDatabase(opened.sessionId, obj.database).catch(() => {});
    let text = "";
    if (obj) {
      const [columns, ddl] = await Promise.all([api().tableColumns(opened.sessionId, obj), api().objectDdl(opened.sessionId, obj).catch(() => "")]);
      const name = [obj.schema, obj.name].filter((part) => part && part !== "main").join(".");
      text = [
        `## ${obj.kind === "view" ? "Vista" : "Tabla"} \`${name}\` (${engine})`,
        "",
        "| Columna | Tipo | Nulos | Clave | Por defecto |",
        "| --- | --- | --- | --- | --- |",
        ...columns.map((col) => `| ${col.name} | ${col.typeName} | ${col.nullable ? "sí" : "no"} | ${col.primaryKey ? "PK" : ""} | ${col.default ?? ""} |`),
        ...(ddl ? ["", "```sql", ddl.trim(), "```"] : []),
      ].join("\n");
    } else {
      const schema = await api().completion(opened.sessionId, opened.database);
      const lines = schema.tables.map((table) => `- \`${table.schema && table.schema !== "main" ? `${table.schema}.` : ""}${table.name}\`(${table.columns.join(", ")})`);
      text = [`## Esquema de \`${opened.database || conn?.name}\` (${engine}, ${schema.tables.length} tablas)`, "", ...lines].join("\n");
    }
    await copyText(text, "Esquema copiado: pégalo en tu asistente de IA");
  } catch (err) {
    notify(errorText(err), "error");
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
}

export async function revealPath(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (err) {
    notify(errorText(err), "error");
  }
}
export async function browseSqlite(assign: (path: string) => void) {
  const path = await api().pickOpenPath([{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] }]);
  if (path) assign(path);
}

export async function openScript() {
  const path = await api().pickOpenPath([{ name: "SQL", extensions: ["sql", "txt"] }]);
  if (!path) return;
  try {
    const { text, encoding } = await api().readTextFile(path);
    const fileCrlf = text.includes("\r\n");
    const sql = text.replace(/\r\n?/g, "\n");
    const tab = activeSql();
    const title = path.split(/[\\/]/).pop() || "script.sql";
    if (tab && !tab.sql.trim()) {
      // The console now holds the file: it is no longer the library script it may have come from.
      setState("tabs", tabIndex(tab.id), { sql, revision: tab.revision + 1, title, filePath: path, fileEncoding: encoding, fileCrlf, fileSaved: sql, libraryId: undefined } as Partial<SqlTab>);
    } else {
      const id = openQuery(tab?.connId ?? null, sql, title);
      patchTab(id, { filePath: path, fileEncoding: encoding, fileCrlf, fileSaved: sql });
    }
    persistSoon();
  } catch (err) {
    notify(errorText(err), "error");
  }
}

/**
 * Ctrl+S: writes the console to its file (in the encoding it was opened with). A console without a file, or
 * "Guardar como…", asks where.
 */
export async function saveScript(saveAs = false) {
  const tab = activeSql();
  if (!tab) return;
  let path = tab.filePath ?? (tab.title.endsWith(".sql") ? tab.title : `${tab.title || "consulta"}.sql`);
  if (isTauri() && (saveAs || !tab.filePath)) {
    const picked = await api().pickSavePath([{ name: "SQL", extensions: ["sql"] }]);
    if (!picked) return;
    path = picked;
  }
  try {
    const lf = tab.sql.replace(/\r\n?/g, "\n");
    const used = await api().writeTextFile(path, tab.fileCrlf ? lf.replace(/\n/g, "\r\n") : lf, tab.fileEncoding);
    const title = path.split(/[\\/]/).pop() || tab.title;
    patchTab(tab.id, { filePath: isTauri() ? path : undefined, fileEncoding: used, fileSaved: isTauri() ? lf : undefined, title });
    persistSoon();
    if (tab.fileEncoding && used !== tab.fileEncoding) notify("Script guardado en UTF-8", "warning", `El texto tiene caracteres que ${tab.fileEncoding} no admite.`);
    else notify(isTauri() ? "Script guardado" : "Script descargado", "success", path);
  } catch (err) {
    notify("No se pudo guardar el script", "error", errorText(err));
  }
}

export async function downloadDriver() {
  setState({ driverProgress: "0%", driverDownload: { what: "IBM Data Server Driver", done: 0, total: 0 } });
  try {
    const path = await api().ibmDriverDownload();
    setState({ driverPath: path, driverProgress: "" });
    notify("Driver IBM instalado", "success");
  } catch (err) {
    setState("driverProgress", "");
    if (!/cancelada/i.test(errorText(err))) notify(errorText(err), "error");
  } finally {
    setState("driverDownload", null);
    void refreshInformixDrivers();
  }
}

export async function refreshInformixDrivers() {
  if (!isTauri()) return;
  try {
    setState("informixDrivers", await api().informixDrivers());
  } catch (err) {
    notify("No se pudo comprobar los drivers", "error", errorText(err));
  }
}

/**
 * Downloads Java (Eclipse Temurin JRE 21) or the Informix JDBC driver into Celer's data folder. Only on the user's
 * request: the buttons that call this say what is downloaded and from where. Returns whether it worked.
 */
export async function downloadJdbcPiece(what: "java" | "jdbc"): Promise<boolean> {
  if (state.driverDownload) return false;
  setState("driverDownload", { what: what === "java" ? "Java (Temurin JRE 21)" : "Driver JDBC de Informix", done: 0, total: 0 });
  try {
    await api().jdbcDownload(what);
    notify(what === "java" ? "Java descargado" : "Driver JDBC descargado", "success");
    return true;
  } catch (err) {
    if (!/cancelada/i.test(errorText(err))) notify("No se pudo completar la descarga", "error", errorText(err));
    return false;
  } finally {
    setState("driverDownload", null);
    await refreshInformixDrivers();
  }
}

export function cancelDriverDownload() {
  void api().driverDownloadCancel();
}

/** The JDBC setup dialog: downloads what is missing, in turn, then retries what failed. */
export async function completeJdbcSetup(what: ("java" | "jdbc")[]) {
  const setup = state.jdbcSetup;
  for (const piece of what) {
    if (!(await downloadJdbcPiece(piece))) return;
  }
  const drivers = state.informixDrivers;
  const ready = !drivers || (drivers.javaUsed && drivers.jdbcUsed);
  if (!ready) return;
  setState("jdbcSetup", null);
  setup?.retry?.();
}

// ---------------------------------------------------------------- completion

/**
 * Tables and columns for a console's completion and Ctrl+click. Before the console runs anything it has no
 * session of its own: fall back to the catalog loaded when the connection was opened (same database).
 */
export function completionTables(tab: SqlTab | undefined): CompletionSchema["tables"] {
  if (!tab?.connId) return [];
  if (tab.completion?.tables.length) return tab.completion.tables;
  const catalog = state.catalog[tab.connId];
  if (!catalog || (tab.database && catalog.database && tab.database !== catalog.database)) return [];
  return catalog.tables;
}

/** Opens the table a console refers to (Ctrl+click / F4 on its name in the SQL). */
export function openTableFromSql(tab: SqlTab, table: CompletionSchema["tables"][number]) {
  if (!tab.connId) return;
  const database = tab.database || state.catalog[tab.connId]?.database || "";
  void openTable(tab.connId, { database, schema: table.schema, name: table.name, kind: "table" });
}

export function schemaMap(tab: SqlTab | undefined) {
  const map: Record<string, string[]> = {};
  for (const table of tab?.completion?.tables ?? []) {
    map[table.name] = table.columns;
    if (table.schema) map[`${table.schema}.${table.name}`] = table.columns;
  }
  return map;
}

export function allTables() {
  const out: { connId: string; obj: ObjectRef; columns: number }[] = [];
  const seen = new Set<string>();
  const add = (connId: string, obj: ObjectRef, columns: number) => {
    const key = `${connId}|${obj.database}|${obj.schema}|${obj.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ connId, obj, columns });
  };
  // Explorer nodes first: they know whether an object is a table or a view.
  for (const [key, entry] of Object.entries(state.tree)) {
    const connId = key.split("\u0000")[0];
    for (const node of entry.nodes) {
      if (node.obj && (node.obj.kind === "table" || node.obj.kind === "view")) add(connId, node.obj, 0);
    }
  }
  for (const [connId, entry] of Object.entries(state.catalog)) {
    if (!state.sessions[connId]) continue;
    for (const table of entry.tables) add(connId, { database: entry.database, schema: table.schema, name: table.name, kind: "table" }, table.columns.length);
  }
  for (const tab of state.tabs) {
    if (tab.kind !== "sql" || !tab.connId || !tab.completion) continue;
    for (const table of tab.completion.tables) add(tab.connId, { database: tab.database, schema: table.schema, name: table.name, kind: "table" }, table.columns.length);
  }
  return out;
}

export function mutatingActive() {
  const tab = activeSql();
  return tab ? isMutating(statementAt(tab.sql, tab.cursor, kindOf(tab.connId)), kindOf(tab.connId)) : false;
}
