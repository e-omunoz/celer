import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { raw } from "./raw";
import { busy, endBusy, nextPaint, startBusy, updateBusy } from "./busy";
import { cellText, firstKeyword, formatSql, rowsLabel, isMutating, needsProductionConfirm, sqlLiteral, statementAt, wherePosition } from "./sql";
import type {
  Cell,
  ColumnInfo,
  CompletionSchema,
  ConnConfig,
  ConnSummary,
  DbKind,
  HistoryEntry,
  MetaNode,
  ObjectRef,
  ResultSet,
  Settings,
  TableColumn,
  ThemeName,
} from "./types";
import { defaultSettings, emptyConn, engineOf } from "./types";
import { bindParams, findParams, hasUnfilteredWrite, paramNames } from "./snippets";
import type { ErEdge, ErTable } from "./erLayout";
import { parseMssqlPlan, parseMysqlPlan, parsePostgresPlan, parseSqlitePlan, type Plan } from "./plan";
import { activitySpec, readSessions, type ServerSession } from "./activity";
import type { AiMessage } from "./ai";

export type InspectorMode = "value" | "record" | "history" | "ai";

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
  /** The last execution plan (Ctrl+Shift+E), shown in its own result tab. */
  plan: { plan: Plan; sql: string } | null;
  activePlan: boolean;
  /** Results kept aside with the pin button: they survive the next runs until closed. */
  pinned: PinnedResult[];
  /** The pinned result on show instead of the current ones (null: the current ones). */
  activePinned: string | null;
  /** A pinned result compared with the current one (key: columns that match rows; null: guessed). */
  compare: { pinId: string; key: string[] | null } | null;
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

interface SavedSqlTab {
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
}

interface SavedTableTab {
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

interface WorkspaceFile {
  tabs: (SavedSqlTab | SavedTableTab)[];
  activeTabId: string;
  sidebarWidth: number;
}

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
}

export const [state, setState] = createStore({
  connections: [] as ConnSummary[],
  sessions: {} as Record<string, ConnSession>,
  connecting: {} as Record<string, boolean>,
  catalog: {} as Record<string, { database: string; tables: CompletionSchema["tables"] }>,
  passwords: {} as Record<string, string>,
  tree: {} as Record<string, TreeEntry>,
  treeFilter: "",
  treeSelected: "",
  tabs: [] as Tab[],
  activeTabId: "",
  settings: { ...defaultSettings } as Settings,
  explorerOpen: true,
  inspectorOpen: false,
  inspectorMode: "value" as InspectorMode,
  ai: { messages: [] as AiMessage[], running: false, hasKey: false, needsKey: false },
  historyQuery: "",
  history: [] as HistoryEntry[],
  settingsOpen: false,
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
  appInfo: { version: "", dataDir: "" },
  driverPath: null as string | null,
  driverProgress: "",
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
}
export const [gibEvent, setGibEvent] = createSignal<GibEvent | null>(null);
export function gib(type: GibEvent["type"], extra: Omit<GibEvent, "type" | "at"> = {}) {
  setGibEvent({ type, at: Date.now(), ...extra });
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

function uid(): string {
  return crypto.randomUUID();
}

function patchTab(id: string, patch: Record<string, unknown>) {
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
  if (key.startsWith("c:")) return key.slice(2);
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
  } catch {
    /* empty settings */
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
    setState("appInfo", await api().appInfo());
    setState("driverPath", await api().ibmDriverStatus());
  } catch (err) {
    notify(errorText(err), "error");
  }
  try {
    const workspace = (await api().loadJson("workspace")) as WorkspaceFile | null;
    if (workspace?.tabs?.length) {
      // Tables of connections that no longer exist are dropped (only when the list did load: a failure must not
      // lose them for good); the rest load when first shown.
      const known = (id: string | null) => !id || !connectionsLoaded || state.connections.some((conn) => conn.id === id);
      setState(
        "tabs",
        workspace.tabs
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
                },
          ),
      );
      const active = state.tabs.some((tab) => tab.id === workspace.activeTabId) ? workspace.activeTabId : state.tabs[0]?.id ?? "";
      setState("activeTabId", active);
    }
  } catch {
    /* no workspace */
  }
  setState("ready", true);
  void api().onExportProgress((progress) => {
    if (state.exportRunning) setState("exportRows", progress.rows);
  });
  void api().onDriverDownload((progress) => {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    setState("driverProgress", progress.total ? `${pct}%` : `${progress.done} bytes`);
  });
}

function blankSql(id: string, connId: string | null = null, sql = "", title = "console"): SqlTab {
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

function persistSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistNow, 400);
}

/** Writes the workspace file right away (used before the window closes). */
export function persistNow() {
  window.clearTimeout(saveTimer);
  const file: WorkspaceFile = {
    activeTabId: state.activeTabId,
    sidebarWidth: state.settings.sidebarWidth,
    tabs: state.tabs.map(
      (tab): SavedSqlTab | SavedTableTab =>
        tab.kind === "sql"
          ? { id: tab.id, kind: "sql", title: tab.title, connId: tab.connId, sql: tab.sql, database: tab.database, cursor: tab.cursor, autocommit: tab.autocommit, filePath: tab.filePath, fileEncoding: tab.fileEncoding }
          : { id: tab.id, kind: "table", title: tab.title, connId: tab.connId, database: tab.database, obj: tab.obj, section: tab.section, where: tab.where, orderBy: tab.orderBy, filters: tab.filters, sort: tab.sort },
    ),
  };
  return api().saveJson("workspace", file);
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

export async function saveSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch };
  setState("settings", settings);
  applyTheme(settings);
  await api().saveJson("settings", settings);
}

// ---------------------------------------------------------------- connections

export function askPassword(name: string) {
  return new Promise<string | null>((resolve) => setState("passwordAsk", { name, resolve }));
}

export interface ErState {
  connId: string;
  title: string;
  loading: boolean;
  done: number;
  total: number;
  error: string;
  /** More tables than the diagram shows (it stops at ER_LIMIT). */
  truncated: number;
  tables: ErTable[];
  edges: ErEdge[];
  /** Where each diagram table comes from, to open it. */
  objects: Record<string, ObjectRef>;
}

const ER_LIMIT = 250;
let erToken = 0;

/**
 * Loads the tables of a schema (path [database, schema], or [database] on engines without schemas) with their
 * columns and foreign keys, on a side session, and shows the diagram as it arrives.
 */
export async function openErDiagram(connId: string, path: string[]) {
  const token = ++erToken;
  // "main · main" (SQLite, MySQL: database and schema share the name) reads as just "main".
  const title = path.filter((part, i) => part !== path[i - 1]).join(" · ");
  setState("er", { connId, title, loading: true, done: 0, total: 0, error: "", truncated: 0, tables: [], edges: [], objects: {} });
  const opened = await openSessionFor(connId).catch((err) => {
    setState("er", { loading: false, error: errorText(err) });
    return null;
  });
  if (!opened) return;
  const current = () => token === erToken && state.er !== null;
  try {
    if (path[0]) await api().useDatabase(opened.sessionId, path[0]).catch(() => {});
    const folders = await api().metaChildren(opened.sessionId, path);
    const folder = folders.find((node) => node.kind === "folder" && (node.path[node.path.length - 1] === "tables" || /^(tablas|tables)$/i.test(node.name)));
    if (!folder) throw new Error("Aquí no hay una carpeta de tablas");
    const all = (await api().metaChildren(opened.sessionId, folder.path)).filter((node) => node.obj?.kind === "table");
    const nodes = all.slice(0, ER_LIMIT);
    if (!current()) return;
    setState("er", { total: nodes.length, truncated: all.length - nodes.length });
    const tables: ErTable[] = [];
    const edges: ErEdge[] = [];
    const objects: Record<string, ObjectRef> = {};
    for (const [i, node] of nodes.entries()) {
      const obj = node.obj!;
      const id = `${obj.schema}.${obj.name}`;
      const [columns, fkNodes] = await Promise.all([
        api().tableColumns(opened.sessionId, obj).catch(() => [] as TableColumn[]),
        api().metaChildren(opened.sessionId, [...node.path, "fks"]).catch(() => [] as MetaNode[]),
      ]);
      if (!current()) return;
      const fks = parseForeignKeys(fkNodes, obj).filter((fk) => fk.columns.length);
      const fkCols = new Set(fks.flatMap((fk) => fk.columns));
      tables.push({ id, name: obj.name, schema: obj.schema, columns: columns.map((c) => ({ name: c.name, type: c.typeName, pk: c.primaryKey, fk: fkCols.has(c.name), nullable: c.nullable })) });
      for (const fk of fks) edges.push({ name: fk.name, from: id, to: `${fk.target.schema}.${fk.target.name}`, fromCols: fk.columns, toCols: fk.targetColumns });
      objects[id] = obj;
      // Show progress (and the tables so far) every few tables.
      if (i % 8 === 7 || i === nodes.length - 1) setState("er", { done: i + 1, tables: [...tables], edges: [...edges], objects: { ...objects } });
    }
    if (current()) setState("er", { loading: false, done: nodes.length });
  } catch (err) {
    if (current()) setState("er", { loading: false, error: errorText(err) });
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
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
  setState("activity", { connId, title: conn.name, sessionId: "", selfId: "", loading: true, error: "", sessions: [], updatedAt: 0, canCancel: Boolean(spec.cancel), canKill: Boolean(spec.kill) });
  const opened = await openSessionFor(connId).catch((err) => {
    setState("activity", { loading: false, error: errorText(err) });
    return null;
  });
  if (!opened) return;
  if (state.activity?.connId !== connId) {
    void api().closeSession(opened.sessionId).catch(() => {});
    return;
  }
  const self = await api()
    .execute(opened.sessionId, spec.self, 1)
    .then((out) => String(out.results[0]?.rows[0]?.[0] ?? ""))
    .catch(() => "");
  setState("activity", { sessionId: opened.sessionId, selfId: self });
  await refreshActivity();
}

export async function refreshActivity() {
  const current = state.activity;
  const spec = activitySpec(kindOf(current?.connId));
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
  const spec = activitySpec(kindOf(current?.connId));
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
  setState({ testOutput: "", testOk: null, testing: false });
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
  setState({ testOutput: "", testOk: null, testing: true });
  try {
    setState({ testOutput: await api().testConnection(cfg), testOk: true });
  } catch (err) {
    setState({ testOutput: errorText(err), testOk: false });
  } finally {
    setState("testing", false);
  }
}

export async function connect(connId: string, password?: string) {
  const conn = connectionById(connId);
  if (!conn || state.connecting[connId]) return;
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
    const databases = await api().listDatabases(opened.sessionId).catch(() => [] as string[]);
    // Disconnected while this was connecting: drop the new session instead of bringing the connection back.
    if (connectGeneration(connId) !== generation) {
      void api().closeSession(opened.sessionId).catch(() => {});
      return;
    }
    setState("sessions", connId, { metaId: opened.sessionId, database: opened.database, serverInfo: opened.serverInfo, databases });
    try {
      localStorage.setItem(`celer.server.${connId}`, opened.serverInfo.slice(0, 120));
    } catch {
      /* only cosmetic */
    }
    void api()
      .completion(opened.sessionId, opened.database)
      .then((schema) => setState("catalog", connId, { database: opened.database, tables: schema.tables }))
      .catch(() => {});
    await loadChildren(connId, [], true);
    if (connectGeneration(connId) !== generation) return;
    autoExpand(connId);
    gib("connected", { production: conn.production, detail: conn.name });
    const current = activeTab();
    if (!current) {
      openQuery(connId, "");
    } else if (current.kind === "sql" && !current.connId) {
      setState("tabs", tabIndex(current.id), { connId, database: opened.database, serverInfo: opened.serverInfo, title: current.title === "console" ? conn.name : current.title });
    }
    persistSoon();
  } catch (err) {
    const message = errorText(err);
    notify(`No se pudo conectar a «${conn.name}»`, "error", message);
    gib("connect-failed", { detail: message });
    // Forget a typed password that did not work, so the next attempt asks again.
    if (!conn.hasPassword) {
      setState(produce((draft) => {
        delete draft.passwords[connId];
      }));
    }
    if (message.includes("IBM_DRIVER_MISSING")) setState("settingsOpen", true);
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
  for (const tab of affected) bumpToken(tab.id);
  if (exporting) void cancelExport();
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
  await api().closeConnectionSessions(connId).catch(() => 0);
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

export async function refreshNode(connId: string, path: string[]) {
  await loadChildren(connId, path, true);
  if (!path.length) {
    const session = state.sessions[connId];
    if (!session) return;
    const databases = await api().listDatabases(session.metaId).catch(() => session.databases);
    // Disconnected (or reconnected) meanwhile: the entry is gone or belongs to another session.
    if (state.sessions[connId]?.metaId === session.metaId) setState("sessions", connId, "databases", databases);
  }
}

// ---------------------------------------------------------------- consoles

export function openQuery(connId: string | null, sql = "", title?: string) {
  const conn = connectionById(connId);
  const tab = blankSql(uid(), connId, sql, title ?? conn?.name ?? "console");
  const session = connId ? state.sessions[connId] : undefined;
  if (session) {
    tab.database = session.database;
    tab.serverInfo = session.serverInfo;
  }
  setState("tabs", [...state.tabs, tab]);
  setState("activeTabId", tab.id);
  persistSoon();
  return tab.id;
}

export function updateSql(id: string, sql: string, cursor: number, selection: string) {
  const index = tabIndex(id);
  if (index < 0) return;
  setState("tabs", index, { sql, cursor, selection } as Partial<SqlTab>);
  persistSoon();
}

export function setTabConnection(tabId: string, connId: string) {
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
    title: tab.title === "console" || connectionById(tab.connId)?.name === tab.title ? conn?.name ?? tab.title : tab.title,
  } as Partial<SqlTab>);
  if (!session) void connect(connId);
  persistSoon();
}

export function formatActive() {
  const tab = activeSql();
  if (!tab) return;
  setState("tabs", tabIndex(tab.id), { sql: formatSql(tab.sql, kindOf(tab.connId)), revision: tab.revision + 1 } as Partial<SqlTab>);
  persistSoon();
}

export function insertIntoActive(text: string) {
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

async function ensureSqlSession(tab: SqlTab): Promise<SqlTab> {
  if (!tab.connId) throw new Error("Elige una conexión para esta consola");
  if (!state.sessions[tab.connId]) await connect(tab.connId);
  if (!state.sessions[tab.connId]) throw new Error("Sin conexión");
  const fresh = state.tabs[tabIndex(tab.id)];
  if (!fresh || fresh.kind !== "sql") throw new Error("La pestaña ya no existe");
  if (fresh.sessionId) return fresh;
  const pwd = state.passwords[fresh.connId!];
  const generation = connectGeneration(fresh.connId!);
  const opened = await api().openSession(fresh.connId!, pwd);
  // Disconnected meanwhile (even if reconnected since): do not attach a session the core may have closed.
  if (!state.sessions[fresh.connId!] || connectGeneration(fresh.connId!) !== generation) {
    void api().closeSession(opened.sessionId).catch(() => {});
    throw new Error("La conexión se ha cerrado");
  }
  const wanted = fresh.database && fresh.database !== opened.database ? fresh.database : "";
  let database = opened.database;
  if (wanted) database = await api().useDatabase(opened.sessionId, wanted).catch(() => opened.database);
  // A console in Manual mode must stay manual on a new session (after a reconnect or a connection change).
  let inTransaction = false;
  if (!fresh.autocommit) inTransaction = await api().setAutocommit(opened.sessionId, false).catch(() => false);
  const now = state.tabs[tabIndex(fresh.id)];
  if (!now || now.kind !== "sql") {
    void api().closeSession(opened.sessionId).catch(() => {});
    throw new Error("La pestaña ya no existe");
  }
  patchTab(fresh.id, { sessionId: opened.sessionId, database, serverInfo: opened.serverInfo, inTransaction });
  void loadCompletion(fresh.id);
  return state.tabs[tabIndex(fresh.id)] as SqlTab;
}

async function loadCompletion(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "sql" || !tab.sessionId) return;
  try {
    const completion = await api().completion(tab.sessionId, tab.database);
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

export async function runActive(mode: "statement" | "script" | "explain" | "analyze") {
  const current = activeSql();
  if (!current || current.running) return;
  const conn = connectionById(current.connId);
  let sql = current.selection.trim() || (mode === "script" ? current.sql.trim() : statementAt(current.sql, current.cursor, conn?.kind));
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
  if (mode === "explain" || mode === "analyze") return explainStatement(current.id, sql.replace(/;\s*$/, ""), mode === "analyze");
  if (conn?.production && state.settings.confirmMutations && needsProductionConfirm(sql, conn.kind)) {
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
    const tab = await ensureSqlSession(fresh);
    const output = await api().execute(tab.sessionId!, sql, state.settings.pageSize);
    // Disconnected while it ran: this answer belongs to a closed session.
    if (tokenOf(current.id) !== token) return;
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
    gib("query-ok", { ms: output.elapsedMs, hasMore: output.results.some((result) => result.hasMore), detail: sql });
    pushOutput(tab.id, { at: Date.now(), sql, ok: true, text: [summary, ...output.messages].join("\n"), elapsedMs: output.elapsedMs });
    const rows = output.results.find((result) => result.columns.length)?.rows.length ?? output.results.find((result) => result.rowsAffected !== null)?.rowsAffected ?? null;
    if (isMutating(sql, conn?.kind) && /\b(create|drop|alter|rename)\b/i.test(sql)) {
      void loadCompletion(tab.id);
      if (tab.connId) void refreshNode(tab.connId, []);
    }
    await remember(tab, sql, true, output.elapsedMs, rows);
  } catch (err) {
    if (tokenOf(current.id) !== token) return;
    const message = errorText(err);
    const at = tabIndex(current.id);
    if (at >= 0) patchTab(current.id, { running: false, startedAt: null, error: message, elapsedMs: null, activeResult: -1, activePinned: null });
    pushOutput(current.id, { at: Date.now(), sql, ok: false, text: message, elapsedMs: null });
    gib("query-error", { detail: message });
    await remember(current, sql, false, 0, null);
    if (message.includes("IBM_DRIVER_MISSING")) setState("settingsOpen", true);
  }
}

/** ANALYZE runs the statement: only for reads, on engines whose analyzed plan Celer reads (PostgreSQL, MariaDB). */
export function canAnalyze(tab: SqlTab, sql: string): boolean {
  const kind = kindOf(tab.connId);
  const engineOk = kind === "postgres" || (kind === "mysql" && /mariadb/i.test(tab.serverInfo || state.sessions[tab.connId ?? ""]?.serverInfo || ""));
  return engineOk && /^(SELECT|WITH|VALUES|TABLE)$/.test(firstKeyword(sql)) && !isMutating(sql, kind);
}

/**
 * The execution plan of a statement, as a tree in its own result tab (the current results stay). Engines
 * without a plan reader show the raw EXPLAIN output instead.
 */
export async function explainStatement(tabId: string, sql: string, analyze = false) {
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
    if (kind === "postgres") {
      const out = await api().execute(session, `EXPLAIN (FORMAT JSON, VERBOSE, COSTS${analyze ? ", ANALYZE, BUFFERS" : ""}) ${sql}`, 10);
      plan = parsePostgresPlan(String(out.results[0]?.rows[0]?.[0] ?? "[]"));
    } else if (kind === "mysql") {
      const out = await api().execute(session, `${analyze && mariadb ? "ANALYZE" : "EXPLAIN"} FORMAT=JSON ${sql}`, 10);
      plan = parseMysqlPlan(String(out.results[0]?.rows[0]?.[0] ?? "{}"));
      plan.engine = mariadb ? "MariaDB" : "MySQL";
    } else if (kind === "sqlite") {
      const out = await api().execute(session, `EXPLAIN QUERY PLAN ${sql}`, 10_000);
      plan = parseSqlitePlan(out.results[0]?.rows ?? []);
    } else {
      // SQL Server: the XML plan, without running the statement.
      await api().execute(session, "SET SHOWPLAN_XML ON", 1);
      try {
        const out = await api().execute(session, sql, 10);
        plan = parseMssqlPlan(String(out.results.find((r) => r.columns.length)?.rows[0]?.[0] ?? ""));
      } finally {
        await api().execute(session, "SET SHOWPLAN_XML OFF", 1).catch(() => {});
      }
    }
    if (tokenOf(tabId) !== token) return;
    patchTab(tabId, { running: false, startedAt: null, plan: { plan, sql }, activePlan: true });
  } catch (err) {
    if (tokenOf(tabId) !== token) return;
    const message = errorText(err);
    patchTab(tabId, { running: false, startedAt: null, error: message, activePlan: false, activePinned: null, activeResult: -1 });
    pushOutput(tabId, { at: Date.now(), sql: `EXPLAIN ${sql}`, ok: false, text: message, elapsedMs: null });
    gib("query-error", { detail: message });
  }
}

function explainPrefix(kind: DbKind | undefined) {
  if (kind === "postgres") return "EXPLAIN (ANALYZE false, VERBOSE, COSTS)";
  if (kind === "mysql") return "EXPLAIN";
  if (kind === "sqlite") return "EXPLAIN QUERY PLAN";
  return "";
}

/** Runs a given SQL text in the active console without touching what the user wrote. */
export async function runText(sql: string) {
  const tab = activeSql();
  if (!tab) return;
  const keep = tab.selection;
  patchTab(tab.id, { selection: sql });
  await runActive("statement");
  patchTab(tab.id, { selection: keep });
}

/** Replaces the whole text of the active console. */
export function replaceActiveSql(sql: string) {
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
  const keep = tab.selection;
  patchTab(tab.id, { selection: tab.lastSql });
  await runActive("statement");
  patchTab(tab.id, { selection: keep });
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
    const opened = await openSessionFor(tab.connId);
    if (!opened) throw new Error("Sin conexión");
    if (tabIndex(tabId) < 0) {
      void api().closeSession(opened.sessionId).catch(() => {});
      throw new Error("La pestaña ya no existe");
    }
    patchTab(tabId, { sessionId: opened.sessionId });
    if (tab.obj.database) await api().useDatabase(opened.sessionId, tab.obj.database).catch(() => {});
    return opened.sessionId;
  })();
  reopening.set(tabId, job);
  void job.finally(() => reopening.delete(tabId)).catch(() => {});
  return job;
}

/** A new session for a connection (connecting first if needed); null when it cannot connect. */
async function openSessionFor(connId: string) {
  if (!state.sessions[connId]) await connect(connId);
  if (!state.sessions[connId]) return null;
  const generation = connectGeneration(connId);
  const opened = await api().openSession(connId, state.passwords[connId]);
  // Disconnected while it opened: the core may have closed it already.
  if (connectGeneration(connId) !== generation || !state.sessions[connId]) {
    void api().closeSession(opened.sessionId).catch(() => {});
    throw new Error("La conexión se ha cerrado");
  }
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

export async function openTable(connId: string, obj: ObjectRef, section: TableTab["section"] = "data", filters: ColumnFilter[] = []) {
  const existing = state.tabs.find((tab) => tab.kind === "table" && tab.connId === connId && tab.obj.name === obj.name && tab.obj.schema === obj.schema && tab.obj.database === obj.database);
  if (existing) {
    // A restored tab not loaded yet loads once here (with the filters, if any), not again when it is shown.
    const restored = existing.kind === "table" && existing.restored;
    if (restored) patchTab(existing.id, { restored: false, ...(filters.length ? { filters, where: "", section: "data" as const } : {}) });
    selectTab(existing.id);
    if (section !== "data") patchTab(existing.id, { section });
    if (restored) {
      void reloadTable(existing.id, true);
    } else if (filters.length && (await guardDirty(existing.id))) {
      patchTab(existing.id, { filters, where: "", section: "data" });
      void reloadTable(existing.id);
    }
    return;
  }
  const opened = await openSessionFor(connId).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) return;
  const id = uid();
  const tab = blankTable(id, connId, obj, opened.sessionId, obj.database || opened.database, section, filters);
  setState("tabs", [...state.tabs, tab]);
  persistSoon();
  setState("activeTabId", id);
  await reloadTable(id, true);
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
      if (tab.obj.database) await api().useDatabase(sid, tab.obj.database).catch(() => {});
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

function filterSql(tab: TableTab, filter: ColumnFilter): string | null {
  const index = tab.columnsMeta.findIndex((col) => col.name === filter.col);
  if (index < 0) return null;
  const ident = tab.quoted[index] ?? filter.col;
  const kind = tab.columnsMeta[index].kind;
  const engine = kindOf(tab.connId);
  const lit = (value: string) => sqlLiteral(value, kind, engine);
  const text = (value: string) => sqlLiteral(value, "text", engine);
  const like = engine === "postgres" ? "ILIKE" : "LIKE";
  const esc = (value: string) => value.replace(/[!%_]/g, (m) => `!${m}`).replace(/\[/g, engine === "mssql" ? "![" : "[");
  const asText = engine === "postgres" ? `${ident}::text` : engine === "mssql" ? `CAST(${ident} AS NVARCHAR(MAX))` : ident;
  switch (filter.op) {
    case "eq": return `${ident} = ${lit(filter.value)}`;
    case "ne": return `${ident} <> ${lit(filter.value)}`;
    case "gt": return `${ident} > ${lit(filter.value)}`;
    case "gte": return `${ident} >= ${lit(filter.value)}`;
    case "lt": return `${ident} < ${lit(filter.value)}`;
    case "lte": return `${ident} <= ${lit(filter.value)}`;
    // The value is literal text: % and _ (and [ on SQL Server) are escaped so they don't act as wildcards.
    case "contains": return `${asText} ${like} ${text(`%${esc(filter.value)}%`)} ESCAPE '!'`;
    case "not-contains": return `${asText} NOT ${like} ${text(`%${esc(filter.value)}%`)} ESCAPE '!'`;
    case "starts": return `${asText} ${like} ${text(`${esc(filter.value)}%`)} ESCAPE '!'`;
    case "ends": return `${asText} ${like} ${text(`%${esc(filter.value)}`)} ESCAPE '!'`;
    case "null": return `${ident} IS NULL`;
    case "not-null": return `${ident} IS NOT NULL`;
    case "empty": return `(${ident} IS NULL OR ${ident} = '')`;
    case "between": return `${ident} BETWEEN ${lit(filter.value)} AND ${lit(filter.value2)}`;
    case "in":
    case "not-in": {
      if (!filter.values.length) return null;
      const hasNull = filter.values.includes("\u0000NULL");
      const list = filter.values.filter((value) => value !== "\u0000NULL").map(lit);
      const parts: string[] = [];
      if (list.length) parts.push(`${ident} ${filter.op === "in" ? "IN" : "NOT IN"} (${list.join(", ")})`);
      if (hasNull) parts.push(`${ident} ${filter.op === "in" ? "IS NULL" : "IS NOT NULL"}`);
      return parts.length > 1 ? `(${parts.join(filter.op === "in" ? " OR " : " AND ")})` : parts[0];
    }
  }
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
  const parts = tab.filters.filter((filter) => filter.enabled).map((filter) => filterSql(tab, filter)).filter((part): part is string => Boolean(part));
  if (tab.where.trim()) parts.unshift(parts.length ? `(${tab.where.trim()})` : tab.where.trim());
  return parts.join(" AND ");
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
  const pk = tab.columnsMeta.map((col, index) => ({ col, index })).filter((item) => item.col.primaryKey);
  const lines: string[] = [];
  const whereFor = (row: number) => pk.map((item) => `${tab.quoted[item.index]} = ${literalOf(tab.rows[row][item.index], item.col.kind, kindOf(tab.connId))}`).join(" AND ");
  for (const rowIndex of tab.deleted) lines.push(`DELETE FROM ${tab.qualified} WHERE ${whereFor(rowIndex)};`);
  const byRow = new Map<number, number[]>();
  for (const key of Object.keys(tab.edits)) {
    const [rowText, colText] = key.split(":");
    const row = Number(rowText);
    if (tab.deleted.includes(row)) continue;
    byRow.set(row, [...(byRow.get(row) ?? []), Number(colText)]);
  }
  for (const [row, cols] of byRow) {
    const sets = cols.map((col) => `${tab.quoted[col]} = ${sqlLiteral(tab.edits[`${row}:${col}`], tab.columnsMeta[col].kind, kindOf(tab.connId))}`).join(", ");
    lines.push(`UPDATE ${tab.qualified} SET ${sets} WHERE ${whereFor(row)};`);
  }
  for (const insert of tab.inserts) {
    const usable = tab.columnsMeta.map((col, index) => ({ col, index })).filter((item) => !(item.col.identity && (insert[item.index] === null || insert[item.index] === "")) && !(insert[item.index] === null && item.col.default));
    const names = usable.map((item) => tab.quoted[item.index]).join(", ");
    const values = usable.map((item) => sqlLiteral(insert[item.index], item.col.kind, kindOf(tab.connId))).join(", ");
    lines.push(usable.length ? `INSERT INTO ${tab.qualified} (${names}) VALUES (${values});` : `INSERT INTO ${tab.qualified} DEFAULT VALUES;`);
  }
  return lines.join("\n");
}

export async function saveTable(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table" || !tableDirty(tab)) return;
  const pk = tab.columnsMeta.some((col) => col.primaryKey);
  if (!pk && (tab.deleted.length || Object.keys(tab.edits).length)) {
    notify("Esta tabla no tiene clave primaria: no se pueden generar UPDATE ni DELETE seguros.", "warning");
    return;
  }
  const sql = buildChanges(tab);
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
        output = await api().execute(session, sql, 1);
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

function literalOf(value: Cell, kind: TableColumn["kind"], dialect?: string) {
  if (value === null || value === undefined) return "NULL";
  return sqlLiteral(String(value), kind, dialect);
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
  return tab.obj.kind !== "view" && !conn?.readOnly && tab.columnsMeta.some((col) => col.primaryKey);
}

// ---------------------------------------------------------------- object actions

export type GenerateKind = "select" | "select-join" | "insert" | "update" | "delete" | "upsert" | "drop" | "ddl" | "count";

/** A :name parameter for a column (letters, digits and _; numbered when two columns clash). */
function paramNamesFor(columns: string[]): string[] {
  const used = new Set<string>();
  return columns.map((name, i) => {
    let base = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
    if (!/^[a-z_]/.test(base)) base = `p${i + 1}${base ? `_${base}` : ""}`;
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}${n}`;
    used.add(candidate);
    return `:${candidate}`;
  });
}

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
    let sql = "";
    if (kind === "select") sql = `SELECT ${quoted.length ? quoted.join(",\n       ") : "*"}\nFROM ${q}\n${limitClause(dialect, 100)};`;
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
      const lines = [`SELECT t0.*${fks.map((_, i) => `,\n       t${i + 1}.*`).join("")}`, `FROM ${q} t0`];
      for (const [i, fk] of fks.entries()) {
        const target = await api().objectSql(opened.sessionId, fk.target).then((r) => r.qualified).catch(() => fk.target.name);
        const left = await api().quoteIdents(opened.sessionId, fk.columns);
        const right = await api().quoteIdents(opened.sessionId, fk.targetColumns);
        lines.push(`LEFT JOIN ${target} t${i + 1} ON ${left.map((col, j) => `t${i + 1}.${right[j]} = t0.${col}`).join(" AND ")}`);
      }
      sql = `${lines.join("\n")}\n${limitClause(dialect, 100)};`;
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

/**
 * Insert-or-update in each engine's own syntax, keyed on the primary key. `cols` are the columns written (keys
 * included); `insertable` the ones MERGE may insert (identity columns are generated by the database).
 */
function upsertSql(dialect: DbKind, q: string, quoted: string[], params: string[], cols: number[], keys: number[], identityKey: boolean, insertable: number[]) {
  const names = cols.map((i) => quoted[i]);
  const values = cols.map((i) => params[i]);
  const updatable = cols.filter((i) => !keys.includes(i));
  const keyNames = keys.map((i) => quoted[i]).join(", ");
  if (dialect === "postgres" || dialect === "sqlite") {
    const action = updatable.length ? `DO UPDATE SET ${updatable.map((i) => `${quoted[i]} = EXCLUDED.${quoted[i]}`).join(",\n    ")}` : "DO NOTHING";
    // A GENERATED ALWAYS identity key only accepts a value with OVERRIDING SYSTEM VALUE (harmless otherwise).
    const overriding = dialect === "postgres" && identityKey ? "\nOVERRIDING SYSTEM VALUE" : "";
    return `INSERT INTO ${q} (${names.join(", ")})${overriding}\nVALUES (${values.join(", ")})\nON CONFLICT (${keyNames}) ${action};`;
  }
  if (dialect === "mysql") {
    const set = (updatable.length ? updatable : keys).map((i) => `${quoted[i]} = VALUES(${quoted[i]})`).join(",\n    ");
    return `INSERT INTO ${q} (${names.join(", ")})\nVALUES (${values.join(", ")})\nON DUPLICATE KEY UPDATE ${set};`;
  }
  // SQL Server, Informix and others: standard MERGE from a one-row source.
  const source = dialect === "mssql" ? `(VALUES (${values.join(", ")})) AS s (${names.join(", ")})` : `(SELECT ${cols.map((i) => `${params[i]} AS ${quoted[i]}`).join(", ")} FROM ${dialect === "informix" ? "sysmaster:sysdual" : "(VALUES (1)) AS one"}) s`;
  const on = keys.map((i) => `t.${quoted[i]} = s.${quoted[i]}`).join(" AND ");
  const update = updatable.length ? `\nWHEN MATCHED THEN\n  UPDATE SET ${updatable.map((i) => `${quoted[i]} = s.${quoted[i]}`).join(", ")}` : "";
  const inserted = cols.filter((i) => insertable.includes(i));
  return `MERGE INTO ${q} ${dialect === "mssql" ? "AS t" : "t"}\nUSING ${source}\nON ${on}${update}\nWHEN NOT MATCHED THEN\n  INSERT (${inserted.map((i) => quoted[i]).join(", ")}) VALUES (${inserted.map((i) => `s.${quoted[i]}`).join(", ")});`;
}

function limitClause(kind: DbKind, n: number) {
  if (kind === "mssql") return `ORDER BY 1 OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  if (kind === "informix") return "";
  return `LIMIT ${n}`;
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

export async function closeTab(id: string) {
  const tab = state.tabs.find((item) => item.id === id);
  if (tab?.kind === "table" && tableDirty(tab)) {
    const ok = await confirmDialog(`Descartar cambios en ${tab.title}`, "Hay ediciones sin guardar en esta tabla.", "Descartar", true);
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
  const pin: PinnedResult = {
    id: uid(),
    title: `Fijado ${tab.pinned.length + 1}`,
    sql: tab.resultsSql || tab.lastSql,
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

export function openInspector(mode: InspectorMode) {
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
}

const EXT: Record<ExportFormat, string> = { csv: "csv", tsv: "tsv", json: "json", sql: "sql", markdown: "md", html: "html", xml: "xml", xlsx: "xlsx" };

function openExport(source: ExportSource) {
  setState({ exportOpen: true, exportSource: source, exportRows: 0, exportRunning: false, exportPath: "" });
  setState("exportOpts", "tableName", source.tableName);
}

/**
 * Export the statement of the active console: `sqlOverride` (a pinned result's SQL), else the last run one,
 * the selection or the one under the cursor.
 */
export async function startExport(sqlOverride?: string) {
  const tab = activeTab();
  if (tab?.kind === "table") return startTableExport(tab.id);
  if (!tab || tab.kind !== "sql") return;
  if (!connectionById(tab.connId)) {
    notify("Elige una conexión", "warning");
    return;
  }
  const sql = sqlOverride || tab.lastSql || tab.selection.trim() || statementAt(tab.sql, tab.cursor, kindOf(tab.connId)) || tab.sql;
  if (!sql.trim()) return;
  const from = /\bfrom\s+([\w."`\[\]]+)/i.exec(sql)?.[1]?.replace(/["`\[\]]/g, "") ?? "resultado";
  openExport({ connId: tab.connId!, database: tab.database, sql: sql.replace(/;\s*$/, ""), label: "el resultado de la consulta", tableName: from });
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
  openExport({ connId: tab.connId, database: tab.obj.database || tab.database, sql, label: where ? `${tab.obj.name} (filtrada)` : tab.obj.name, tableName: tab.qualified });
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
    });
    setState({ exportRows: rows, exportRunning: false, exportOpen: false, exportId: "" });
    const target = path;
    notify(`Exportadas ${rows.toLocaleString()} filas en ${formatMs(performance.now() - started)}`, "success", target || undefined, target && isTauri() ? { label: "Mostrar en la carpeta", run: () => void revealPath(target) } : undefined);
    gib("saved");
  } catch (err) {
    const cancelled = !state.exportRunning;
    setState({ exportRunning: false, exportId: "" });
    if (!cancelled) notify("La exportación falló", "error", errorText(err));
  }
}

export async function cancelExport() {
  const id = state.exportId;
  setState("exportRunning", false);
  if (id) await api().cancel(id).catch(() => {});
  notify("Exportación cancelada", "warning");
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
    const { text: sql, encoding } = await api().readTextFile(path);
    const tab = activeSql();
    const title = path.split(/[\\/]/).pop() || "script.sql";
    if (tab && !tab.sql.trim()) {
      setState("tabs", tabIndex(tab.id), { sql, revision: tab.revision + 1, title, filePath: path, fileEncoding: encoding } as Partial<SqlTab>);
    } else {
      const id = openQuery(tab?.connId ?? null, sql, title);
      patchTab(id, { filePath: path, fileEncoding: encoding });
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
    const used = await api().writeTextFile(path, tab.sql, tab.fileEncoding);
    const title = path.split(/[\\/]/).pop() || tab.title;
    patchTab(tab.id, { filePath: isTauri() ? path : undefined, fileEncoding: used, title });
    persistSoon();
    if (tab.fileEncoding && used !== tab.fileEncoding) notify("Script guardado en UTF-8", "warning", `El texto tiene caracteres que ${tab.fileEncoding} no admite.`);
    else notify(isTauri() ? "Script guardado" : "Script descargado", "success", path);
  } catch (err) {
    notify("No se pudo guardar el script", "error", errorText(err));
  }
}

export async function downloadDriver() {
  setState("driverProgress", "0%");
  try {
    const path = await api().ibmDriverDownload();
    setState({ driverPath: path, driverProgress: "" });
    notify("Driver IBM instalado", "success");
  } catch (err) {
    setState("driverProgress", "");
    notify(errorText(err), "error");
  }
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
