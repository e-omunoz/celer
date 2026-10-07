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
import { createDemoBackend } from "./demo";

export interface Backend {
  listConnections(): Promise<ConnSummary[]>;
  saveConnection(cfg: ConnConfig): Promise<ConnConfig>;
  reorderConnections(ids: string[]): Promise<void>;
  deleteConnection(id: string): Promise<void>;
  testConnection(cfg: ConnConfig): Promise<string>;
  openSession(connId: string, password?: string): Promise<SessionInfo>;
  closeSession(sessionId: string): Promise<void>;
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
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  odbcDrivers(): Promise<string[]>;
  odbcDsns(): Promise<string[]>;
  ibmDriverStatus(): Promise<string | null>;
  ibmDriverDownload(): Promise<string>;
  appInfo(): Promise<{ version: string; dataDir: string }>;
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
    openSession: (connId, password) => invoke("open_session", { conn_id: connId, password: password ?? null }),
    closeSession: (sessionId) => invoke("close_session", { session_id: sessionId }),
    execute: (sessionId, sql, fetch) => invoke("execute", { session_id: sessionId, sql, fetch }),
    fetch: (sessionId, n) => invoke("fetch", { session_id: sessionId, n }),
    closeCursor: (sessionId) => invoke("close_cursor", { session_id: sessionId }),
    cancel: (sessionId) => invoke("cancel", { session_id: sessionId }),
    setAutocommit: (sessionId, on) => invoke("set_autocommit", { session_id: sessionId, on }),
    commit: (sessionId) => invoke("commit", { session_id: sessionId }),
    rollback: (sessionId) => invoke("rollback", { session_id: sessionId }),
    metaChildren: (sessionId, path) => invoke("meta_children", { session_id: sessionId, path }),
    tableColumns: (sessionId, obj) => invoke("table_columns", { session_id: sessionId, obj }),
    objectDdl: (sessionId, obj) => invoke("object_ddl", { session_id: sessionId, obj }),
    completion: (sessionId, database) => invoke("completion", { session_id: sessionId, database }),
    listDatabases: (sessionId) => invoke("list_databases", { session_id: sessionId }),
    useDatabase: (sessionId, database) => invoke("use_database", { session_id: sessionId, database }),
    objectSql: (sessionId, obj) => invoke("object_sql", { session_id: sessionId, obj }),
    quoteIdents: (sessionId, names) => invoke("quote_idents", { session_id: sessionId, names }),
    exportQuery: (connId, database, sql, exportId, options) =>
      invoke("export_query", { conn_id: connId, database, sql, export_id: exportId, options }),
    addHistory: (entry) => invoke("add_history", { entry }),
    getHistory: (filter, limit) => invoke("get_history", { filter, limit }),
    clearHistory: () => invoke("clear_history"),
    loadJson: (name) => invoke("load_json", { name }),
    saveJson: (name, value) => invoke("save_json", { name, value }),
    readTextFile: (path) => invoke("read_text_file", { path }),
    writeTextFile: (path, content) => invoke("write_text_file", { path, content }),
    odbcDrivers: () => invoke("odbc_drivers"),
    odbcDsns: () => invoke("odbc_dsns"),
    ibmDriverStatus: () => invoke("ibm_driver_status"),
    ibmDriverDownload: () => invoke("ibm_driver_download"),
    appInfo: () => invoke("app_info"),
    pickSavePath: async (filters) => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({ filters });
      return picked ?? null;
    },
    pickOpenPath: async (filters) => {
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
