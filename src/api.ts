import type {
  CompletionSchema,
  ConnConfig,
  ConnSummary,
  ExecOutput,
  ExportOptions,
  FetchOutput,
  HistoryEntry,
  MetaNode,
  ObjectRef,
  SessionInfo,
  TableColumn,
} from "./types";
import type { McpAuditEntry, McpClientInfo, McpConfig, UpdateInfo } from "./types";
import type { MigrationSource } from "./migrate";
import { createDemoBackend } from "./demo";

export interface Backend {
  listConnections(): Promise<ConnSummary[]>;
  saveConnection(cfg: ConnConfig): Promise<ConnConfig>;
  reorderConnections(ids: string[]): Promise<void>;
  deleteConnection(id: string): Promise<void>;
  testConnection(cfg: ConnConfig): Promise<string>;
  openSession(connId: string, password?: string): Promise<SessionInfo>;
  closeSession(sessionId: string): Promise<void>;
  /** Closes every session of a connection (disconnect); returns how many were open. */
  closeConnectionSessions(connId: string): Promise<number>;
  execute(sessionId: string, sql: string, fetch: number): Promise<ExecOutput>;
  fetch(sessionId: string, n: number): Promise<FetchOutput>;
  closeCursor(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  setAutocommit(sessionId: string, on: boolean): Promise<boolean>;
  commit(sessionId: string): Promise<boolean>;
  rollback(sessionId: string): Promise<boolean>;
  metaChildren(sessionId: string, path: string[]): Promise<MetaNode[]>;
  tableColumns(sessionId: string, obj: ObjectRef): Promise<TableColumn[]>;
  objectDdl(sessionId: string, obj: ObjectRef): Promise<string>;
  completion(sessionId: string, database: string): Promise<CompletionSchema>;
  listDatabases(sessionId: string): Promise<string[]>;
  useDatabase(sessionId: string, database: string): Promise<string>;
  objectSql(sessionId: string, obj: ObjectRef): Promise<{ qualified: string; select: string }>;
  quoteIdents(sessionId: string, names: string[]): Promise<string[]>;
  exportQuery(connId: string, database: string, sql: string, exportId: string, options: ExportOptions): Promise<number>;
  addHistory(entry: HistoryEntry): Promise<void>;
  getHistory(filter: string, limit: number): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;
  loadJson(name: "settings" | "workspace"): Promise<unknown>;
  saveJson(name: "settings" | "workspace", value: unknown): Promise<void>;
  /** The text and the encoding it was in (utf-8, utf-8-bom, utf-16le, utf-16be, windows-1252). */
  readTextFile(path: string): Promise<{ text: string; encoding: string }>;
  /** A sheet of an Excel / OpenDocument workbook as text cells (the first sheet when `sheet` is not given). */
  readSpreadsheet(path: string, sheet?: string): Promise<{ sheets: string[]; sheet: string; rows: string[][] }>;
  /** Writes in `encoding` (UTF-8 by default); returns the encoding used (UTF-8 when Windows-1252 cannot hold the text). */
  writeTextFile(path: string, content: string, encoding?: string): Promise<string>;
  odbcDrivers(): Promise<string[]>;
  odbcDsns(): Promise<string[]>;
  ibmDriverStatus(): Promise<string | null>;
  ibmDriverDownload(): Promise<string>;
  appInfo(): Promise<{ version: string; dataDir: string }>;
  migrationSources(): Promise<MigrationSource[]>;
  updateCheck(): Promise<UpdateInfo>;
  updateDownload(url: string, name: string, sumsUrl: string): Promise<string>;
  updateInstall(path: string, relaunch: boolean): Promise<void>;
  onUpdateDownload(cb: (progress: { done: number; total: number }) => void): Promise<() => void>;
  aiKeyStatus(): Promise<boolean>;
  aiKeySet(key: string): Promise<void>;
  aiKeyGet(): Promise<string | null>;
  mcpConfigGet(): Promise<McpConfig>;
  mcpConfigSet(config: McpConfig): Promise<void>;
  mcpAudit(limit: number): Promise<McpAuditEntry[]>;
  mcpClearAudit(): Promise<void>;
  mcpClientInfo(): Promise<McpClientInfo>;
  mcpInstallClaudeDesktop(): Promise<string>;
  mcpTestTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  pickSavePath(filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  pickOpenPath(filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  onExportProgress(cb: (progress: { exportId: string; rows: number }) => void): Promise<() => void>;
  onDriverDownload(cb: (progress: { done: number; total: number }) => void): Promise<() => void>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

function tauriBackend(): Backend {
  return {
    listConnections: () => invoke("list_connections"),
    saveConnection: (cfg) => invoke("save_connection", { cfg: { ...cfg, password: cfg.password || null } }),
    reorderConnections: (ids) => invoke("reorder_connections", { ids }),
    deleteConnection: (id) => invoke("delete_connection", { id }),
    testConnection: (cfg) => invoke("test_connection", { cfg }),
    openSession: (connId, password) => invoke("open_session", { connId: connId, password: password ?? null }),
    closeSession: (sessionId) => invoke("close_session", { sessionId: sessionId }),
    closeConnectionSessions: (connId) => invoke("close_connection_sessions", { connId }),
    execute: (sessionId, sql, fetch) => invoke("execute", { sessionId: sessionId, sql, fetch }),
    fetch: (sessionId, n) => invoke("fetch", { sessionId: sessionId, n }),
    closeCursor: (sessionId) => invoke("close_cursor", { sessionId: sessionId }),
    cancel: (sessionId) => invoke("cancel", { sessionId: sessionId }),
    setAutocommit: (sessionId, on) => invoke("set_autocommit", { sessionId: sessionId, on }),
    commit: (sessionId) => invoke("commit", { sessionId: sessionId }),
    rollback: (sessionId) => invoke("rollback", { sessionId: sessionId }),
    metaChildren: (sessionId, path) => invoke("meta_children", { sessionId: sessionId, path }),
    tableColumns: (sessionId, obj) => invoke("table_columns", { sessionId: sessionId, obj }),
    objectDdl: (sessionId, obj) => invoke("object_ddl", { sessionId: sessionId, obj }),
    completion: (sessionId, database) => invoke("completion", { sessionId: sessionId, database }),
    listDatabases: (sessionId) => invoke("list_databases", { sessionId: sessionId }),
    useDatabase: (sessionId, database) => invoke("use_database", { sessionId: sessionId, database }),
    objectSql: (sessionId, obj) => invoke("object_sql", { sessionId: sessionId, obj }),
    quoteIdents: (sessionId, names) => invoke("quote_idents", { sessionId: sessionId, names }),
    exportQuery: (connId, database, sql, exportId, options) =>
      invoke("export_query", { connId: connId, database, sql, exportId: exportId, options }),
    addHistory: (entry) => invoke("add_history", { entry }),
    getHistory: (filter, limit) => invoke("get_history", { filter, limit }),
    clearHistory: () => invoke("clear_history"),
    loadJson: (name) => invoke("load_json", { name }),
    saveJson: (name, value) => invoke("save_json", { name, value }),
    readTextFile: (path) => invoke("read_text_file", { path }),
    readSpreadsheet: (path, sheet) => invoke("read_spreadsheet", { path, sheet: sheet ?? null }),
    writeTextFile: (path, content, encoding) => invoke("write_text_file", { path, content, encoding: encoding ?? null }),
    odbcDrivers: () => invoke("odbc_drivers"),
    odbcDsns: () => invoke("odbc_dsns"),
    ibmDriverStatus: () => invoke("ibm_driver_status"),
    ibmDriverDownload: () => invoke("ibm_driver_download"),
    appInfo: () => invoke("app_info"),
    migrationSources: () => invoke("migration_sources"),
    updateCheck: () => invoke("update_check"),
    updateDownload: (url, name, sumsUrl) => invoke("update_download", { url, name, sumsUrl }),
    updateInstall: (path, relaunch) => invoke("update_install", { path, relaunch }),
    onUpdateDownload: async (cb) => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<{ done: number; total: number }>("update-download", (e) => cb(e.payload));
    },
    aiKeyStatus: () => invoke("ai_key_status"),
    aiKeySet: (key) => invoke("ai_key_set", { key }),
    aiKeyGet: () => invoke("ai_key_get"),
    mcpConfigGet: () => invoke("mcp_config_get"),
    mcpConfigSet: (config) => invoke("mcp_config_set", { config }),
    mcpAudit: (limit) => invoke("mcp_audit", { limit }),
    mcpClearAudit: () => invoke("mcp_clear_audit"),
    mcpClientInfo: () => invoke("mcp_client_info"),
    mcpInstallClaudeDesktop: () => invoke("mcp_install_claude_desktop"),
    mcpTestTool: (name, args) => invoke("mcp_test_tool", { name, args }),
    pickSavePath: async (filters) => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({ filters });
      return picked ?? null;
    },
    pickOpenPath: async (filters) => {
      // End-to-end checks (dev/*-check.mjs) hand over the file the native dialog would have picked. Nothing a
      // script in the page could not already do through invoke().
      const scripted = (window as { __celerNextOpenPath?: string }).__celerNextOpenPath;
      if (scripted) {
        delete (window as { __celerNextOpenPath?: string }).__celerNextOpenPath;
        return scripted;
      }
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false, directory: false, filters });
      return typeof picked === "string" ? picked : null;
    },
    onExportProgress: async (cb) => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<{ exportId: string; rows: number }>("export-progress", (e) => cb(e.payload));
    },
    onDriverDownload: async (cb) => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<{ done: number; total: number }>("driver-download", (e) => cb(e.payload));
    },
  };
}

let backend: Backend | null = null;

export function api(): Backend {
  if (!backend) backend = isTauri() ? tauriBackend() : createDemoBackend();
  return backend;
}

export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Error inesperado";
}
