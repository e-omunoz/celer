import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { raw } from "./raw";
import { busy, endBusy, nextPaint, startBusy, updateBusy } from "./busy";
import { formatSql, isMutating, needsProductionConfirm, sqlLiteral, statementAt, wherePosition } from "./sql";
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

interface WorkspaceFile {
  tabs: { id: string; kind: "sql"; title: string; connId: string | null; sql: string; database: string }[];
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
  type: "query-ok" | "query-error" | "connected" | "connect-failed" | "commit" | "rollback" | "saved" | "mouse-run" | "running";
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
  root.style.setProperty("--accent", settings.accent);
  root.style.fontSize = `${settings.fontSize}px`;
  if (isTauri()) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(LIGHT_THEMES.has(theme) ? "light" : "dark"))
      .catch(() => {});
  }
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
  try {
    setState("connections", await api().listConnections());
    setState("appInfo", await api().appInfo());
    setState("driverPath", await api().ibmDriverStatus());
  } catch (err) {
    notify(errorText(err), "error");
  }
  try {
    const workspace = (await api().loadJson("workspace")) as WorkspaceFile | null;
    if (workspace?.tabs?.length) {
      setState(
        "tabs",
        workspace.tabs.map((tab) => ({ ...blankSql(tab.id, tab.connId, tab.sql, tab.title), database: tab.database ?? "" })),
      );
      // The saved active tab may have been a table tab (not persisted): fall back to the first console.
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
  };
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
    tabs: state.tabs
      .filter((tab): tab is SqlTab => tab.kind === "sql")
      .map((tab) => ({ id: tab.id, kind: "sql", title: tab.title, connId: tab.connId, sql: tab.sql, database: tab.database })),
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
  await disconnect(id);
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
  setState("connecting", connId, true);
  try {
    const opened = await api().openSession(connId, pwd);
    const databases = await api().listDatabases(opened.sessionId).catch(() => [] as string[]);
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
      const passwords = { ...state.passwords };
      delete passwords[connId];
      setState("passwords", passwords);
    }
    if (message.includes("IBM_DRIVER_MISSING")) setState("settingsOpen", true);
  } finally {
    setState("connecting", connId, false);
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

export async function disconnect(connId: string) {
  const session = state.sessions[connId];
  if (session) await api().closeSession(session.metaId).catch(() => {});
  for (const tab of state.tabs) {
    if (tab.connId === connId && tab.sessionId) await api().closeSession(tab.sessionId).catch(() => {});
  }
  const sessions = { ...state.sessions };
  delete sessions[connId];
  setState("sessions", sessions);
  setState(
    "tabs",
    // Consoles reopen a session on their next run; table tabs reopen one on reload.
    state.tabs.map((tab) => (tab.connId !== connId ? tab : tab.kind === "sql" ? { ...tab, sessionId: null, inTransaction: false } : { ...tab, sessionId: "" })) as Tab[],
  );
  const tree = { ...state.tree };
  for (const key of Object.keys(tree)) {
    if (key.startsWith(`${connId}\u0000`)) delete tree[key];
  }
  setState("tree", tree);
}

// ---------------------------------------------------------------- explorer

export async function loadChildren(connId: string, path: string[], open = true) {
  const session = state.sessions[connId];
  if (!session) return;
  const key = pathKey(connId, path);
  setState("tree", key, { open, status: "loading", nodes: state.tree[key]?.nodes ?? [] });
  try {
    const nodes = await api().metaChildren(session.metaId, path);
    setState("tree", key, { open, status: "ready", nodes });
  } catch (err) {
    setState("tree", key, { open, status: "error", nodes: [], error: errorText(err) });
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
    if (session) setState("sessions", connId, "databases", await api().listDatabases(session.metaId).catch(() => session.databases));
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
  const opened = await api().openSession(fresh.connId!, pwd);
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
      ? `${result.rows.length.toLocaleString()}${result.hasMore ? "+" : ""} filas`
      : `${(result.rowsAffected ?? 0).toLocaleString()} filas afectadas`,
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

export async function runActive(mode: "statement" | "script" | "explain") {
  const current = activeSql();
  if (!current || current.running) return;
  const conn = connectionById(current.connId);
  let sql = current.selection.trim() || (mode === "script" ? current.sql.trim() : statementAt(current.sql, current.cursor, conn?.kind));
  if (!sql) return;
  if (mode === "explain") {
    const prefix = explainPrefix(conn?.kind);
    if (!prefix) {
      notify("EXPLAIN no está disponible para este motor", "warning");
      return;
    }
    sql = `${prefix} ${sql.replace(/;\s*$/, "")}`;
  }
  if (conn?.production && state.settings.confirmMutations && needsProductionConfirm(sql, conn.kind)) {
    const ok = await confirmDialog(
      `Ejecutar en ${conn.name} (producción)`,
      "La sentencia modifica datos sin WHERE o cambia la estructura (DROP, TRUNCATE, ALTER). Revisa antes de continuar.",
      "Ejecutar de todos modos",
      true,
    );
    if (!ok) return;
  }
  const fresh = state.tabs[tabIndex(current.id)];
  if (!fresh || fresh.kind !== "sql") return;
  patchTab(current.id, { running: true, error: "", messages: [], startedAt: Date.now(), lastSql: sql });
  try {
    const tab = await ensureSqlSession(fresh);
    const output = await api().execute(tab.sessionId!, sql, state.settings.pageSize);
    const firstGrid = output.results.findIndex((result) => result.columns.length);
    patchTab(tab.id, {
      runId: (tab.runId ?? 0) + 1,
      running: false,
      startedAt: null,
      results: output.results,
      activeResult: firstGrid >= 0 ? firstGrid : -1,
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
    const message = errorText(err);
    const at = tabIndex(current.id);
    if (at >= 0) patchTab(current.id, { running: false, startedAt: null, error: message, elapsedMs: null, activeResult: -1 });
    pushOutput(current.id, { at: Date.now(), sql, ok: false, text: message, elapsedMs: null });
    gib("query-error", { detail: message });
    await remember(current, sql, false, 0, null);
    if (message.includes("IBM_DRIVER_MISSING")) setState("settingsOpen", true);
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

/** Loads the next page. Returns false when nothing could be loaded (error, closed tab, nothing pending). */
export async function fetchMore(tabId: string, n = state.settings.pageSize): Promise<boolean> {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || !tab.sessionId) return false;
  if (tab.kind === "sql") {
    const resultIndex = tab.results.findIndex((result) => result.hasMore);
    if (resultIndex < 0 || tab.running) return false;
    patchTab(tab.id, { running: true });
    try {
      const more = await api().fetch(tab.sessionId, n);
      const fresh = state.tabs[tabIndex(tabId)];
      if (!fresh || fresh.kind !== "sql") return false;
      const result = fresh.results[resultIndex];
      const results = fresh.results.slice();
      results[resultIndex] = { ...result, rows: concatRows(result.rows, more.rows), hasMore: more.hasMore };
      if (!more.hasMore) results.push(...more.extra);
      patchTab(tab.id, { results, running: false });
      return true;
    } catch (err) {
      patchTab(tab.id, { running: false });
      notify("No se pudieron cargar más filas", "error", errorText(err));
      return false;
    }
  }
  if (!tab.hasMore || tab.loading) return false;
  patchTab(tab.id, { loading: true });
  try {
    const more = await api().fetch(tab.sessionId, n);
    const fresh = state.tabs[tabIndex(tabId)];
    if (!fresh || fresh.kind !== "table") return false;
    patchTab(tab.id, { rows: concatRows(fresh.rows, more.rows), hasMore: more.hasMore, loading: false });
    return true;
  } catch (err) {
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

async function openSessionFor(connId: string) {
  if (!state.sessions[connId]) await connect(connId);
  if (!state.sessions[connId]) return null;
  return api().openSession(connId, state.passwords[connId]);
}

export async function openTable(connId: string, obj: ObjectRef, section: TableTab["section"] = "data") {
  const existing = state.tabs.find((tab) => tab.kind === "table" && tab.connId === connId && tab.obj.name === obj.name && tab.obj.schema === obj.schema && tab.obj.database === obj.database);
  if (existing) {
    selectTab(existing.id);
    if (section !== "data") patchTab(existing.id, { section });
    return;
  }
  const opened = await openSessionFor(connId).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) return;
  const id = uid();
  const tab: TableTab = {
    id,
    kind: "table",
    title: obj.name,
    connId,
    sessionId: opened.sessionId,
    database: obj.database || opened.database,
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
    filters: [],
    sort: null,
    totalCount: null,
    counting: false,
    elapsedMs: null,
    edits: {},
    deleted: [],
    inserts: [],
  };
  setState("tabs", [...state.tabs, tab]);
  setState("activeTabId", id);
  await reloadTable(id, true);
}

export async function reloadTable(tabId: string, full = false) {
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "table") return;
  patchTab(tabId, { loading: true, error: "", errorAt: null, edits: {}, deleted: [], inserts: [] });
  let select = "";
  try {
    // After a disconnect the tab has no session: open a new one (connecting first if needed).
    if (!tab.sessionId) {
      const opened = await openSessionFor(tab.connId);
      if (!opened) throw new Error("Sin conexión");
      patchTab(tabId, { sessionId: opened.sessionId });
      if (tab.obj.database) await api().useDatabase(opened.sessionId, tab.obj.database).catch(() => {});
    }
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
    const result = output.results.find((item) => item.columns.length) ?? { columns: [], rows: [], hasMore: false, rowsAffected: null };
    if (tabIndex(tabId) < 0) return;
    patchTab(tabId, {
      loading: false,
      elapsedMs: output.elapsedMs,
      gridCols: result.columns.length ? withColumnTypes(result.columns, current.columnsMeta) : current.columnsMeta.map((col) => ({ name: col.name, typeName: col.typeName, kind: col.kind })),
      rows: result.rows,
      hasMore: result.hasMore,
    });
  } catch (err) {
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
      const session = current.sessionId;
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
      notify(`Cambios guardados · ${affected} filas afectadas`, "success");
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

export async function generateSql(connId: string, obj: ObjectRef, kind: "select" | "insert" | "update" | "delete" | "ddl" | "count") {
  const opened = await openSessionFor(connId).catch((err) => {
    notify(errorText(err), "error");
    return null;
  });
  if (!opened) return;
  try {
    if (obj.database) await api().useDatabase(opened.sessionId, obj.database).catch(() => {});
    if (kind === "ddl") {
      const ddl = await api().objectDdl(opened.sessionId, obj);
      openQuery(connId, ddl, `${obj.name}.sql`);
      return;
    }
    const [columns, info] = await Promise.all([api().tableColumns(opened.sessionId, obj).catch(() => [] as TableColumn[]), api().objectSql(opened.sessionId, obj)]);
    const quoted = await api().quoteIdents(opened.sessionId, columns.map((col) => col.name));
    const q = info.qualified;
    const pk = columns.map((col, index) => ({ col, index })).filter((item) => item.col.primaryKey);
    const where = (pk.length ? pk : columns.slice(0, 1).map((col, index) => ({ col, index }))).map((item) => `${quoted[item.index]} = ?`).join("\n  AND ");
    let sql = "";
    if (kind === "select") sql = `SELECT ${quoted.length ? quoted.join(",\n       ") : "*"}\nFROM ${q}\n${limitClause(kindOf(connId), 100)};`;
    if (kind === "count") sql = `SELECT COUNT(*) FROM ${q};`;
    if (kind === "insert") {
      const usable = columns.map((col, index) => ({ col, index })).filter((item) => !item.col.identity);
      sql = `INSERT INTO ${q} (${usable.map((item) => quoted[item.index]).join(", ")})\nVALUES (${usable.map(() => "?").join(", ")});`;
    }
    if (kind === "update") {
      const sets = columns.map((col, index) => ({ col, index })).filter((item) => !item.col.primaryKey).map((item) => `${quoted[item.index]} = ?`).join(",\n    ");
      sql = `UPDATE ${q}\nSET ${sets}\nWHERE ${where};`;
    }
    if (kind === "delete") sql = `DELETE FROM ${q}\nWHERE ${where};`;
    const tab = activeSql();
    if (tab && tab.connId === connId) insertIntoActive((tab.sql.trim() ? "\n\n" : "") + sql);
    else openQuery(connId, sql);
  } catch (err) {
    notify(errorText(err), "error");
  } finally {
    void api().closeSession(opened.sessionId).catch(() => {});
  }
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
  patchTab(tabId, { activeResult: index });
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

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown" | "html" | "xlsx";

export interface ExportSource {
  connId: string;
  database: string;
  sql: string;
  /** What is being exported, for the dialog title ("orders", "consulta"). */
  label: string;
  /** Table name used by SQL INSERT exports. */
  tableName: string;
}

const EXT: Record<ExportFormat, string> = { csv: "csv", tsv: "tsv", json: "json", sql: "sql", markdown: "md", html: "html", xlsx: "xlsx" };

function openExport(source: ExportSource) {
  setState({ exportOpen: true, exportSource: source, exportRows: 0, exportRunning: false, exportPath: "" });
  setState("exportOpts", "tableName", source.tableName);
}

/** Export the statement of the active console (the last run one, the selection or the one under the cursor). */
export async function startExport() {
  const tab = activeTab();
  if (tab?.kind === "table") return startTableExport(tab.id);
  if (!tab || tab.kind !== "sql") return;
  if (!connectionById(tab.connId)) {
    notify("Elige una conexión", "warning");
    return;
  }
  const sql = tab.lastSql || tab.selection.trim() || statementAt(tab.sql, tab.cursor, kindOf(tab.connId)) || tab.sql;
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
    const sql = await api().readTextFile(path);
    const tab = activeSql();
    const title = path.split(/[\\/]/).pop() || "script.sql";
    if (tab && !tab.sql.trim()) {
      setState("tabs", tabIndex(tab.id), { sql, revision: tab.revision + 1, title } as Partial<SqlTab>);
      persistSoon();
    } else openQuery(tab?.connId ?? null, sql, title);
  } catch (err) {
    notify(errorText(err), "error");
  }
}

export async function saveScript() {
  const tab = activeSql();
  if (!tab) return;
  let path = tab.title.endsWith(".sql") ? tab.title : `${tab.title || "consulta"}.sql`;
  if (isTauri()) {
    const picked = await api().pickSavePath([{ name: "SQL", extensions: ["sql"] }]);
    if (!picked) return;
    path = picked;
  }
  await api().writeTextFile(path, tab.sql);
  notify(isTauri() ? "Script guardado" : "Script descargado", "success", path);
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
