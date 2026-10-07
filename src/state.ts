import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { formatSql, isMutating, needsProductionConfirm, sqlLiteral, statementAt } from "./sql";
import type {
  Cell,
  CompletionSchema,
  ConnConfig,
  ConnSummary,
  HistoryEntry,
  MetaNode,
  ObjectRef,
  ResultSet,
  Settings,
  TableColumn,
} from "./types";
import { defaultSettings, emptyConn } from "./types";

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
  revision: number;
  results: ResultSet[];
  activeResult: number;
  messages: string[];
  error: string;
  elapsedMs: number | null;
  running: boolean;
  inTransaction: boolean;
  autocommit: boolean;
  completion: CompletionSchema | null;
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
  quoted: string[];
  section: "data" | "columns" | "indexes" | "keys" | "ddl";
  columnsMeta: TableColumn[];
  gridCols: ResultSet["columns"];
  rows: Cell[][];
  hasMore: boolean;
  ddl: string;
  indexes: MetaNode[];
  keys: MetaNode[];
  loading: boolean;
  error: string;
  edits: Record<string, string | null>;
  deleted: number[];
  inserts: (string | null)[][];
}

export type Tab = SqlTab | TableTab;

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
}

interface WorkspaceFile {
  tabs: { id: string; kind: "sql"; title: string; connId: string | null; sql: string; database: string }[];
  activeTabId: string;
  sidebarWidth: number;
}

export const [state, setState] = createStore({
  connections: [] as ConnSummary[],
  sessions: {} as Record<string, ConnSession>,
  passwords: {} as Record<string, string>,
  tree: {} as Record<string, TreeEntry>,
  treeFilter: "",
  tabs: [] as Tab[],
  activeTabId: "",
  settings: { ...defaultSettings } as Settings,
  historyOpen: false,
  historyQuery: "",
  history: [] as HistoryEntry[],
  settingsOpen: false,
  connDialog: null as ConnConfig | null,
  testOutput: "",
  exportOpen: false,
  exportFormat: "csv" as "csv" | "tsv" | "json" | "sql" | "xlsx",
  exportPath: "",
  exportRows: 0,
  exportRunning: false,
  valueText: null as string | null,
  previewSql: "",
  previewRun: null as (() => Promise<void>) | null,
  toast: "",
  appInfo: { version: "", dataDir: "" },
  driverPath: null as string | null,
  driverProgress: "",
  confirm: null as { title: string; body: string; confirmLabel: string; run: () => void } | null,
  passwordAsk: null as { name: string; resolve: (value: string | null) => void } | null,
  ready: false,
});

export const [resolvedTheme, setResolvedTheme] = createSignal<"light" | "dark" | "contrast">("light");

let toastTimer = 0;
let saveTimer = 0;
let confirmResolve: ((value: boolean) => void) | null = null;
let pendingExportSql = "";

export function notify(message: string) {
  setState("toast", message);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setState("toast", ""), 7000);
}

export function pathKey(connId: string, path: string[]) {
  return `${connId}\u0000${path.join("\u0000")}`;
}

function uid(): string {
  return crypto.randomUUID();
}

function patchTab(id: string, patch: Record<string, unknown>) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const current = state.tabs[index];
  if (!current) return;
  setState("tabs", index, { ...current, ...patch } as Tab);
}

export function activeTab(): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

export function connectionById(id: string | null | undefined) {
  return state.connections.find((conn) => conn.id === id);
}

function tabIndex(id: string) {
  return state.tabs.findIndex((tab) => tab.id === id);
}

export function applyTheme(settings: Settings = state.settings) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = settings.theme === "system" ? (dark ? "dark" : "light") : settings.theme;
  setResolvedTheme(theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--accent", settings.accent);
  document.documentElement.style.fontSize = `${settings.fontSize}px`;
  if (isTauri() && theme !== "contrast") {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === "dark" ? "dark" : "light"))
      .catch(() => {});
  }
}

export async function boot() {
  try {
    const loaded = await api().loadJson("settings");
    if (loaded && typeof loaded === "object") {
      setState("settings", { ...defaultSettings, ...(loaded as Settings) });
    }
  } catch {
    /* ajustes vacíos */
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
    notify(errorText(err));
  }
  try {
    const workspace = (await api().loadJson("workspace")) as WorkspaceFile | null;
    if (workspace?.tabs?.length) {
      setState(
        "tabs",
        workspace.tabs.map((tab) => newSqlTab(tab.connId, tab.sql, tab.title, tab.id)),
      );
      setState("activeTabId", workspace.activeTabId || state.tabs[0]?.id || "");
      if (workspace.sidebarWidth) setState("settings", "sidebarWidth", workspace.sidebarWidth);
    }
  } catch {
    /* sin espacio de trabajo */
  }
  if (!state.tabs.length) {
    const id = uid();
    setState("tabs", [blankSql(id)]);
    setState("activeTabId", id);
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

function blankSql(id: string, connId: string | null = null, sql = "", title = "Consulta"): SqlTab {
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
    revision: 0,
    results: [],
    activeResult: 0,
    messages: [],
    error: "",
    elapsedMs: null,
    running: false,
    inTransaction: false,
    autocommit: true,
    completion: null,
  };
}

function newSqlTab(connId: string | null, sql: string, title: string, id = uid()): SqlTab {
  return blankSql(id, connId, sql, title);
}

function persistSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const file: WorkspaceFile = {
      activeTabId: state.activeTabId,
      sidebarWidth: state.settings.sidebarWidth,
      tabs: state.tabs
        .filter((tab): tab is SqlTab => tab.kind === "sql")
        .map((tab) => ({ id: tab.id, kind: "sql", title: tab.title, connId: tab.connId, sql: tab.sql, database: tab.database })),
    };
    void api().saveJson("workspace", file);
  }, 400);
}

export async function saveSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch };
  setState("settings", settings);
  applyTheme(settings);
  await api().saveJson("settings", settings);
}

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
  setState("testOutput", "");
  setState("connDialog", cfg ? { ...cfg, password: "" } : emptyConn(isTauri() ? "mssql" : "sqlite"));
}

export async function submitConnection(cfg: ConnConfig) {
  const saved = await api().saveConnection(cfg);
  if (cfg.password) setState("passwords", saved.id, cfg.password);
  setState("connDialog", null);
  await refreshConnections();
}

export async function removeConnection(id: string) {
  await disconnect(id);
  await api().deleteConnection(id);
  await refreshConnections();
}

export async function testConnection(cfg: ConnConfig) {
  setState("testOutput", "Conectando…");
  try {
    setState("testOutput", await api().testConnection(cfg));
  } catch (err) {
    setState("testOutput", errorText(err));
  }
}

export async function connect(connId: string, password?: string) {
  const conn = connectionById(connId);
  if (!conn) return;
  if (password) setState("passwords", connId, password);
  else if (needsPassword(conn)) {
    const typed = await askPassword(conn.name);
    if (!typed) return;
    setState("passwords", connId, typed);
  }
  const pwd = state.passwords[connId];
  try {
    const opened = await api().openSession(connId, pwd);
    const databases = await api().listDatabases(opened.sessionId).catch(() => [] as string[]);
    setState("sessions", connId, { metaId: opened.sessionId, database: opened.database, serverInfo: opened.serverInfo, databases });
    await loadChildren(connId, [], true);
    const current = activeTab();
    if (!current || current.kind !== "sql" || (current.connId && current.connId !== connId)) {
      const tab = blankSql(uid(), connId, current?.kind === "sql" ? current.sql : "SELECT 1;", conn.name);
      tab.database = opened.database;
      tab.serverInfo = opened.serverInfo;
      setState("tabs", [...state.tabs, tab]);
      setState("activeTabId", tab.id);
    } else {
      const index = tabIndex(current.id);
      setState("tabs", index, { connId, database: opened.database, serverInfo: opened.serverInfo, title: current.title === "Consulta" ? conn.name : current.title });
    }
    persistSoon();
  } catch (err) {
    const message = errorText(err);
    notify(message);
    if (message.includes("IBM_DRIVER_MISSING")) setState("settingsOpen", true);
  }
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
    state.tabs.map((tab) => (tab.connId === connId ? { ...tab, sessionId: null, inTransaction: false } : tab)) as Tab[],
  );
  const tree = { ...state.tree };
  for (const key of Object.keys(tree)) {
    if (key.startsWith(`${connId}\u0000`)) delete tree[key];
  }
  setState("tree", tree);
}

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

export async function toggleNode(connId: string, node: MetaNode) {
  if (node.leaf) return;
  const key = pathKey(connId, node.path);
  const current = state.tree[key];
  if (current?.open) {
    setState("tree", key, "open", false);
    return;
  }
  if (current?.status === "ready") setState("tree", key, "open", true);
  else await loadChildren(connId, node.path, true);
}

export function openQuery(connId: string | null, sql = "") {
  const conn = connectionById(connId);
  const tab = blankSql(uid(), connId, sql, conn?.name ?? "Consulta");
  const session = connId ? state.sessions[connId] : undefined;
  if (session) {
    tab.database = session.database;
    tab.serverInfo = session.serverInfo;
  }
  setState("tabs", [...state.tabs, tab]);
  setState("activeTabId", tab.id);
  persistSoon();
}

export function updateSql(id: string, sql: string, cursor: number) {
  const index = tabIndex(id);
  if (index < 0) return;
  setState("tabs", index, { sql, cursor });
  persistSoon();
}

export function formatActive() {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;
  const index = tabIndex(tab.id);
  setState("tabs", index, { sql: formatSql(tab.sql), revision: tab.revision + 1 });
  persistSoon();
}

async function ensureSqlSession(tab: SqlTab): Promise<SqlTab> {
  if (!tab.connId) throw new Error("Elige una conexión en el panel izquierdo");
  if (!state.sessions[tab.connId]) await connect(tab.connId);
  const fresh = state.tabs[tabIndex(tab.id)];
  if (!fresh || fresh.kind !== "sql") throw new Error("La pestaña ya no existe");
  if (fresh.sessionId) return fresh;
  const pwd = state.passwords[fresh.connId!];
  const opened = await api().openSession(fresh.connId!, pwd);
  const index = tabIndex(fresh.id);
  setState("tabs", index, { sessionId: opened.sessionId, database: opened.database, serverInfo: opened.serverInfo });
  void loadCompletion(fresh.id);
  return state.tabs[index] as SqlTab;
}

async function loadCompletion(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "sql" || !tab.sessionId) return;
  try {
    const completion = await api().completion(tab.sessionId, tab.database);
    const index = tabIndex(tabId);
    if (index >= 0) patchTab(tabId, { completion });
  } catch {
    /* el autocompletado es opcional */
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
}

export async function runActive(mode: "statement" | "script") {
  const current = activeTab();
  if (!current || current.kind !== "sql" || current.running) return;
  const sql = mode === "script" ? current.sql.trim() : statementAt(current.sql, current.cursor);
  if (!sql) return;
  const conn = connectionById(current.connId);
  if (conn?.production && needsProductionConfirm(sql)) {
    const ok = await confirmDialog("Conexión de producción", "La sentencia modifica datos sin un filtro WHERE, o cambia la estructura. ¿Continuar?", "Ejecutar");
    if (!ok) return;
  }
  const index = tabIndex(current.id);
  setState("tabs", index, { running: true, error: "", messages: [] });
  try {
    const tab = await ensureSqlSession(state.tabs[index] as SqlTab);
    const output = await api().execute(tab.sessionId!, sql, state.settings.pageSize);
    const at = tabIndex(tab.id);
    setState("tabs", at, {
      running: false,
      results: output.results,
      activeResult: 0,
      messages: output.messages,
      elapsedMs: output.elapsedMs,
      inTransaction: output.inTransaction,
      error: "",
    });
    const rows = output.results.find((result) => result.columns.length)?.rows.length ?? output.results.find((result) => result.rowsAffected !== null)?.rowsAffected ?? null;
    await remember(tab, sql, true, output.elapsedMs, rows);
  } catch (err) {
    const message = errorText(err);
    const at = tabIndex(current.id);
    if (at >= 0) setState("tabs", at, { running: false, error: message, elapsedMs: null });
    await remember(current, sql, false, 0, null);
    if (message.includes("IBM_DRIVER_MISSING")) setState("settingsOpen", true);
  }
}

export async function cancelActive() {
  const tab = activeTab();
  if (!tab?.sessionId) return;
  await api().cancel(tab.sessionId).catch((err) => notify(errorText(err)));
}

export async function fetchMore(tabId: string) {
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || !tab.sessionId) return;
  if (tab.kind === "sql") {
    const resultIndex = tab.results.findIndex((result) => result.hasMore);
    if (resultIndex < 0) return;
    const more = await api().fetch(tab.sessionId, state.settings.pageSize);
    const result = tab.results[resultIndex];
    const results = tab.results.slice();
    results[resultIndex] = { ...result, rows: [...result.rows, ...more.rows], hasMore: more.hasMore };
    if (!more.hasMore) results.push(...more.extra);
    patchTab(tab.id, { results });
    return;
  }
  if (!tab.hasMore) return;
  const more = await api().fetch(tab.sessionId, state.settings.pageSize);
  setState("tabs", index, { rows: [...tab.rows, ...more.rows], hasMore: more.hasMore });
}

export async function changeAutocommit(on: boolean) {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;
  const ready = await ensureSqlSession(tab);
  const inTransaction = await api().setAutocommit(ready.sessionId!, on);
  setState("tabs", tabIndex(ready.id), { autocommit: on, inTransaction });
}

export async function commitActive(rollback = false) {
  const tab = activeTab();
  if (!tab?.sessionId || tab.kind !== "sql") return;
  const inTransaction = rollback ? await api().rollback(tab.sessionId) : await api().commit(tab.sessionId);
  patchTab(tab.id, { inTransaction });
}

export async function switchDatabase(database: string) {
  const tab = activeTab();
  const connId = tab?.connId;
  if (!connId) return;
  const session = state.sessions[connId];
  if (!session) return;
  const current = await api().useDatabase(session.metaId, database);
  setState("sessions", connId, "database", current);
  if (tab?.kind === "sql" && tab.sessionId) {
    const used = await api().useDatabase(tab.sessionId, database);
    setState("tabs", tabIndex(tab.id), "database", used);
    void loadCompletion(tab.id);
  }
  await loadChildren(connId, [], true);
}

export async function openTable(connId: string, obj: ObjectRef) {
  if (!state.sessions[connId]) await connect(connId);
  if (!state.sessions[connId]) return;
  const pwd = state.passwords[connId];
  const opened = await api().openSession(connId, pwd);
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
    quoted: [],
    section: "data",
    columnsMeta: [],
    gridCols: [],
    rows: [],
    hasMore: false,
    ddl: "",
    indexes: [],
    keys: [],
    loading: true,
    error: "",
    edits: {},
    deleted: [],
    inserts: [],
  };
  setState("tabs", [...state.tabs, tab]);
  setState("activeTabId", id);
  await reloadTable(id);
}

export async function reloadTable(tabId: string) {
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "table") return;
  setState("tabs", index, { loading: true, error: "", edits: {}, deleted: [], inserts: [] });
  try {
    if (tab.obj.database) await api().useDatabase(tab.sessionId, tab.obj.database).catch(() => {});
    const [columnsMeta, sqlInfo, ddl] = await Promise.all([
      api().tableColumns(tab.sessionId, tab.obj),
      api().objectSql(tab.sessionId, tab.obj),
      api().objectDdl(tab.sessionId, tab.obj).catch((err) => errorText(err)),
    ]);
    const quoted = await api().quoteIdents(tab.sessionId, columnsMeta.map((col) => col.name));
    const output = await api().execute(tab.sessionId, sqlInfo.select, state.settings.pageSize);
    const result = output.results.find((item) => item.columns.length) ?? { columns: [], rows: [], hasMore: false, rowsAffected: null };
    const schema = tab.obj.schema || "main";
    const folder = tab.obj.kind === "view" ? "views" : "tables";
    const base = [tab.obj.database || tab.database || "main", schema, folder, tab.obj.name];
    const [indexes, keys] = await Promise.all([
      api().metaChildren(tab.sessionId, [...base, "indexes"]).catch(() => [] as MetaNode[]),
      api().metaChildren(tab.sessionId, [...base, "fks"]).catch(() => [] as MetaNode[]),
    ]);
    setState("tabs", index, {
      loading: false,
      columnsMeta,
      quoted,
      qualified: sqlInfo.qualified,
      gridCols: result.columns.length ? result.columns : columnsMeta.map((col) => ({ name: col.name, typeName: col.typeName, kind: col.kind })),
      rows: result.rows,
      hasMore: result.hasMore,
      ddl,
      indexes,
      keys,
    });
  } catch (err) {
    setState("tabs", index, { loading: false, error: errorText(err) });
  }
}

export function tableDirty(tab: TableTab) {
  return Object.keys(tab.edits).length > 0 || tab.deleted.length > 0 || tab.inserts.length > 0;
}

export function displayRows(tab: TableTab): Cell[][] {
  const edited = tab.rows.map((row, rowIndex) =>
    row.map((cell, colIndex) => {
      const key = `${rowIndex}:${colIndex}`;
      return Object.prototype.hasOwnProperty.call(tab.edits, key) ? tab.edits[key] : cell;
    }),
  );
  return [...edited, ...tab.inserts];
}

export function editCell(tabId: string, row: number, col: number, value: string | null) {
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "table") return;
  if (row >= tab.rows.length) {
    const insertIndex = row - tab.rows.length;
    const next = tab.inserts.map((line) => line.slice());
    next[insertIndex][col] = value;
    patchTab(tab.id, { inserts: next });
    return;
  }
  patchTab(tab.id, { edits: { ...tab.edits, [`${row}:${col}`]: value } });
}

export function insertTableRow(tabId: string) {
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "table") return;
  patchTab(tab.id, { inserts: [...tab.inserts, tab.columnsMeta.map(() => null)] });
}

export function deleteTableRows(tabId: string, rows: number[]) {
  const index = tabIndex(tabId);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "table") return;
  const existing = rows.filter((row) => row < tab.rows.length);
  const inserts = tab.inserts.filter((_, offset) => !rows.includes(tab.rows.length + offset));
  setState("tabs", index, { deleted: Array.from(new Set([...tab.deleted, ...existing])), inserts });
}

export async function saveTable(tabId: string) {
  const tab = state.tabs[tabIndex(tabId)];
  if (!tab || tab.kind !== "table" || !tableDirty(tab)) return;
  const pk = tab.columnsMeta.map((col, index) => ({ col, index })).filter((item) => item.col.primaryKey);
  if (!pk.length && (tab.deleted.length || Object.keys(tab.edits).length)) {
    notify("Esta tabla no tiene clave primaria: no se pueden generar UPDATE ni DELETE.");
    return;
  }
  const lines: string[] = [];
  for (const rowIndex of tab.deleted) {
    const where = pk.map((item) => `${tab.quoted[item.index]} = ${literalOf(tab.rows[rowIndex][item.index], item.col.kind)}`).join(" AND ");
    lines.push(`DELETE FROM ${tab.qualified} WHERE ${where};`);
  }
  const byRow = new Map<number, number[]>();
  for (const key of Object.keys(tab.edits)) {
    const [rowText, colText] = key.split(":");
    const row = Number(rowText);
    if (tab.deleted.includes(row)) continue;
    const cols = byRow.get(row) ?? [];
    cols.push(Number(colText));
    byRow.set(row, cols);
  }
  for (const [row, cols] of byRow) {
    const sets = cols.map((col) => `${tab.quoted[col]} = ${sqlLiteral(tab.edits[`${row}:${col}`], tab.columnsMeta[col].kind)}`).join(", ");
    const where = pk
      .map((item) => `${tab.quoted[item.index]} = ${literalOf(tab.rows[row][item.index], item.col.kind)}`)
      .join(" AND ");
    lines.push(`UPDATE ${tab.qualified} SET ${sets} WHERE ${where};`);
  }
  for (const insert of tab.inserts) {
    const usable = tab.columnsMeta.map((col, index) => ({ col, index })).filter((item) => !(item.col.identity && (insert[item.index] === null || insert[item.index] === "")));
    const names = usable.map((item) => tab.quoted[item.index]).join(", ");
    const values = usable.map((item) => sqlLiteral(insert[item.index], item.col.kind)).join(", ");
    lines.push(`INSERT INTO ${tab.qualified} (${names}) VALUES (${values});`);
  }
  const sql = lines.join("\n");
  setState({ previewSql: sql, previewRun: async () => {
    const current = state.tabs[tabIndex(tabId)];
    if (!current || current.kind !== "table") return;
    await api().execute(current.sessionId, sql, 1);
    setState({ previewSql: "", previewRun: null });
    await reloadTable(tabId);
  } });
}

function literalOf(value: Cell, kind: TableColumn["kind"]) {
  if (value === null || value === undefined) return "NULL";
  return sqlLiteral(String(value), kind);
}

export async function runPreview() {
  try {
    await state.previewRun?.();
  } catch (err) {
    notify(errorText(err));
  }
}

export async function closeTab(id: string) {
  const tab = state.tabs.find((item) => item.id === id);
  if (tab?.sessionId && !(tab.kind === "sql" && state.sessions[tab.connId ?? ""]?.metaId === tab.sessionId)) {
    await api().closeSession(tab.sessionId).catch(() => {});
  }
  const tabs = state.tabs.filter((item) => item.id !== id);
  setState("tabs", tabs);
  if (state.activeTabId === id) setState("activeTabId", tabs[tabs.length - 1]?.id ?? "");
  persistSoon();
}

export function selectTab(id: string) {
  setState("activeTabId", id);
  persistSoon();
}

export async function refreshHistory() {
  setState("history", await api().getHistory(state.historyQuery, 200));
}

export async function useHistory(sql: string) {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") {
    openQuery(null, sql);
    return;
  }
  setState("tabs", tabIndex(tab.id), { sql, revision: tab.revision + 1, cursor: sql.length });
  setState("historyOpen", false);
  persistSoon();
}

export async function clearHistory() {
  await api().clearHistory();
  setState("history", []);
}

export function confirmDialog(title: string, body: string, confirmLabel: string) {
  dismissConfirm();
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
    setState("confirm", {
      title,
      body,
      confirmLabel,
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

export async function startExport() {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;
  const conn = connectionById(tab.connId);
  if (!conn) {
    notify("Elige una conexión");
    return;
  }
  const sql = statementAt(tab.sql, tab.cursor) || tab.sql;
  if (!sql.trim()) return;
  pendingExportSql = sql;
  setState({ exportOpen: true, exportRows: 0, exportRunning: false, exportPath: `export.${state.exportFormat === "xlsx" ? "xlsx" : state.exportFormat}` });
}

export async function runExport() {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql" || !tab.connId) return;
  const sql = pendingExportSql || tab.sql;
  if (state.exportFormat === "xlsx" && !state.exportPath) {
    notify("Indica una ruta");
    return;
  }
  let path = state.exportPath;
  if (isTauri() && !path) {
    path =
      (await api().pickSavePath([
        { name: state.exportFormat.toUpperCase(), extensions: [state.exportFormat === "xlsx" ? "xlsx" : state.exportFormat] },
      ])) ?? "";
    if (!path) return;
    setState("exportPath", path);
  }
  setState("exportRunning", true);
  try {
    const rows = await api().exportQuery(tab.connId, tab.database, sql, uid(), {
      format: state.exportFormat,
      path: path || `export.${state.exportFormat}`,
      delimiter: state.exportFormat === "tsv" ? "\t" : ";",
      header: true,
      bom: true,
      tableName: "resultado",
      nullText: "",
    });
    setState({ exportRows: rows, exportRunning: false, exportOpen: false });
    notify(`Exportadas ${rows} filas`);
  } catch (err) {
    setState("exportRunning", false);
    notify(errorText(err));
  }
}

export async function browseSqlite(cfg: ConnConfig, assign: (path: string) => void) {
  const path = await api().pickOpenPath([
    { name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] },
  ]);
  if (path) assign(path);
  void cfg;
}

export async function openScript() {
  const path = await api().pickOpenPath([{ name: "SQL", extensions: ["sql"] }]);
  if (!path) return;
  try {
    const sql = await api().readTextFile(path);
    const tab = activeTab();
    if (tab?.kind === "sql") setState("tabs", tabIndex(tab.id), { sql, revision: tab.revision + 1, title: path.split(/[\\/]/).pop() || tab.title });
    else openQuery(null, sql);
  } catch (err) {
    notify(errorText(err));
  }
}

export async function saveScript() {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;
  let path = `${tab.title || "consulta"}.sql`;
  if (isTauri()) {
    const picked = await api().pickSavePath([{ name: "SQL", extensions: ["sql"] }]);
    if (!picked) return;
    path = picked;
  }
  await api().writeTextFile(path, tab.sql);
  notify(isTauri() ? "Script guardado" : "Script descargado");
}

export async function downloadDriver() {
  setState("driverProgress", "0%");
  try {
    const path = await api().ibmDriverDownload();
    setState({ driverPath: path, driverProgress: "" });
    notify("Driver IBM instalado");
  } catch (err) {
    setState("driverProgress", "");
    notify(errorText(err));
  }
}

export function canEdit(tab: TableTab) {
  const conn = connectionById(tab.connId);
  return tab.obj.kind !== "view" && !conn?.readOnly && tab.columnsMeta.some((col) => col.primaryKey);
}

export function schemaMap(tab: SqlTab | undefined) {
  const map: Record<string, string[]> = {};
  for (const table of tab?.completion?.tables ?? []) {
    map[table.name] = table.columns;
    if (table.schema) map[`${table.schema}.${table.name}`] = table.columns;
  }
  return map;
}

export function mutatingActive() {
  const tab = activeTab();
  return tab?.kind === "sql" ? isMutating(statementAt(tab.sql, tab.cursor)) : false;
}
