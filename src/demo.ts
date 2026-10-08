import initSqlJs, { type Database, type QueryExecResult } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Backend } from "./api";
import { quoteIdent, resultToText } from "./sql";
import type {
  Cell,
  ColKind,
  ColumnInfo,
  CompletionSchema,
  ConnConfig,
  ConnSummary,
  ExecOutput,
  FetchOutput,
  HistoryEntry,
  MetaNode,
  ObjectRef,
  ResultSet,
  SessionInfo,
  TableColumn,
} from "./types";

export const SEED = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sku TEXT NOT NULL,
  total REAL NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE VIEW active_customers AS
  SELECT id, name, city FROM customers WHERE active = 1;
INSERT INTO customers (name, city, active) VALUES
  ('Ana Ruiz', 'Madrid', 1),
  ('Luis Gómez', 'Barcelona', 1),
  ('Mia Chen', 'Valencia', 0),
  ('Owen Park', 'Sevilla', 1),
  ('Nora Díaz', 'Bilbao', 1),
  ('Hugo Vidal', 'Zaragoza', 1),
  ('Elena Costa', 'Málaga', 1),
  ('Iker Soler', 'Vigo', 0);
INSERT INTO orders (customer_id, sku, total, created) VALUES
  (1, 'CEL-01', 120.5, '2026-01-12'),
  (1, 'CEL-04', 42, '2026-02-02'),
  (2, 'CEL-02', 890, '2026-02-18'),
  (4, 'CEL-01', 120.5, '2026-03-01'),
  (5, 'CEL-09', 15.75, '2026-03-11'),
  (6, 'CEL-02', 890, '2026-04-04'),
  (7, 'CEL-04', 42, '2026-04-19'),
  (2, 'CEL-09', 15.75, '2026-05-08');
`;

interface DemoCursor {
  rows: Cell[][];
  index: number;
  extra: ResultSet[];
}

interface DemoSession {
  connId: string;
  db: Database;
  database: string;
  inTx: boolean;
  cursor: DemoCursor | null;
}

const sessions = new Map<string, DemoSession>();
const databases = new Map<string, Database>();
const fileBytes = new Map<string, Uint8Array>();
const textFiles = new Map<string, string>();

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

async function sqlEngine() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmUrl });
  }
  return sqlPromise;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function demoConnection(): ConnConfig {
  return {
    id: "demo",
    name: "Demo SQLite",
    kind: "sqlite",
    host: "",
    port: null,
    instance: "",
    database: "main",
    user: "",
    password: null,
    savePassword: false,
    integratedAuth: false,
    encryption: "off",
    trustCert: true,
    informixMode: "auto",
    odbcConnStr: "",
    extra: "",
    color: "#c2410c",
    production: false,
    readOnly: false,
    folder: "Ejemplos",
    filePath: ":memory:",
  };
}

function loadConns(): ConnConfig[] {
  const list = readJson<ConnConfig[]>("celer.connections", []);
  if (!list.length) {
    const seeded = [demoConnection()];
    writeJson("celer.connections", seeded);
    return seeded;
  }
  return list;
}

function summaries(): ConnSummary[] {
  const secrets = readJson<Record<string, string>>("celer.secrets", {});
  return loadConns().map((cfg) => ({ ...cfg, password: undefined, hasPassword: Boolean(secrets[cfg.id]) }));
}

function cellOf(value: string | number | Uint8Array | null): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) {
    return `0x${Array.from(value.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  }
  return value;
}

function toResult(set: QueryExecResult, fetch?: number): { result: ResultSet; rest: Cell[][] } {
  const rows = set.values.map((row) => row.map(cellOf));
  const columns: ColumnInfo[] = set.columns.map((name, index) => {
    const sample = rows.map((row) => row[index]).find((value) => value !== null);
    const kind: ColKind = typeof sample === "number" ? "number" : "text";
    return { name, typeName: kind === "number" ? "numeric" : "text", kind };
  });
  if (fetch !== undefined && rows.length > fetch) {
    return {
      result: { columns, rows: rows.slice(0, fetch), hasMore: true, rowsAffected: null },
      rest: rows.slice(fetch),
    };
  }
  return { result: { columns, rows, hasMore: false, rowsAffected: null }, rest: [] };
}

async function databaseFor(cfg: ConnConfig): Promise<Database> {
  const existing = databases.get(cfg.id);
  if (existing) return existing;
  const SQL = await sqlEngine();
  const bytes = fileBytes.get(cfg.id) ?? (cfg.filePath ? fileBytes.get(cfg.filePath) : undefined);
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  if (!bytes && (cfg.id === "demo" || cfg.filePath === ":memory:" || cfg.filePath === "")) {
    if (cfg.id === "demo" || cfg.name === "Demo SQLite") db.run(SEED);
  }
  databases.set(cfg.id, db);
  return db;
}

function requireSession(id: string): DemoSession {
  const session = sessions.get(id);
  if (!session) throw new Error("Sesión no encontrada o ya cerrada");
  return session;
}

function query(db: Database, sql: string): Cell[][] {
  const sets = db.exec(sql);
  if (!sets[0]) return [];
  return sets[0].values.map((row) => row.map(cellOf));
}

function text(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? "" : String(cell);
}

function num(cell: Cell | undefined): number {
  return typeof cell === "number" ? cell : Number(text(cell) || 0);
}

function schemaName(dbName: string, schema: string): string {
  if (schema && schema !== "main") return schema;
  return dbName || "main";
}

function meta(db: Database, path: string[]): MetaNode[] {
  if (path.length === 0) {
    return query(db, "SELECT name, file FROM pragma_database_list ORDER BY seq").map((row) => ({
      name: text(row[0]),
      kind: "database",
      detail: text(row[1]) || null,
      path: [text(row[0])],
      leaf: false,
    }));
  }
  if (path.length === 1) {
    return [{ name: "main", kind: "schema", detail: null, path: [path[0], "main"], leaf: false }];
  }
  if (path.length === 2) {
    return [
      ["Tablas", "tables"],
      ["Vistas", "views"],
      ["Índices", "indexes"],
      ["Triggers", "triggers"],
    ].map(([label, key]) => ({
      name: label,
      kind: "folder",
      detail: null,
      path: [...path, key],
      leaf: false,
    }));
  }
  const [dbName, schema, folder, name, sub] = path;
  const sch = schemaName(dbName, schema);
  if (path.length === 3) {
    const type = folder === "tables" ? "table" : folder === "views" ? "view" : folder === "indexes" ? "index" : "trigger";
    const branch = type === "table" || type === "view";
    const rows = query(
      db,
      `SELECT name FROM ${quoteIdent(sch)}.sqlite_schema WHERE type = '${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    return rows.map((row) => {
      const objectName = text(row[0]);
      const obj: ObjectRef = { database: dbName, schema, name: objectName, kind: type };
      let detail: string | null = null;
      if (type === "table") {
        const count = query(db, `SELECT COUNT(*) FROM ${quoteIdent(sch)}.${quoteIdent(objectName)}`);
        const n = num(count[0]?.[0]);
        detail = n === 1 ? "1 fila" : `${n} filas`;
      }
      return {
        name: objectName,
        kind: type,
        detail,
        path: branch ? [...path, objectName] : [],
        leaf: !branch,
        obj,
      };
    });
  }
  if (path.length === 4) {
    const cols = query(db, `SELECT name, type, "notnull", pk FROM pragma_table_info(${sqlString(name)})`);
    const nodes: MetaNode[] = cols.map((row) => {
      let detail = text(row[1]) || "any";
      if (num(row[3]) > 0) detail += " · PK";
      if (num(row[2]) === 1) detail += " · not null";
      return { name: text(row[0]), kind: num(row[3]) > 0 ? "pkcolumn" : "column", detail, path: [], leaf: true };
    });
    if (folder === "tables") {
      nodes.push(
        { name: "Índices", kind: "folder", detail: null, path: [...path, "indexes"], leaf: false },
        { name: "Claves foráneas", kind: "folder", detail: null, path: [...path, "fks"], leaf: false },
      );
    }
    return nodes;
  }
  if (sub === "indexes") {
    const rows = query(db, `SELECT name, "unique" FROM pragma_index_list(${sqlString(name)})`);
    return rows.map((row) => {
      const cols = query(db, `SELECT name FROM pragma_index_info(${sqlString(text(row[0]))})`);
      const list = cols.map((col) => text(col[0])).join(", ");
      return {
        name: text(row[0]),
        kind: "index",
        detail: `(${list})${num(row[1]) === 1 ? " · único" : ""}`,
        path: [],
        leaf: true,
      };
    });
  }
  if (sub === "fks") {
    const rows = query(db, `SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(${sqlString(name)})`);
    // Same shape as the core: "cols → table(cols)" and the referenced table in obj (one node per key).
    const keys = new Map<string, { table: string; from: string[]; to: string[] }>();
    for (const row of rows) {
      const id = text(row[0]);
      const key = keys.get(id) ?? { table: text(row[1]), from: [], to: [] };
      key.from.push(text(row[2]));
      key.to.push(text(row[3]));
      keys.set(id, key);
    }
    return [...keys.entries()].map(([id, key]) => ({
      name: `fk_${name}_${key.table}_${id}`,
      kind: "key",
      detail: `${key.from.join(", ")} → ${key.table}(${key.to.join(", ")})`,
      path: [],
      leaf: true,
      obj: { database: "", schema: "main", name: key.table, kind: "table" },
    }));
  }
  return [];
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tableColumns(db: Database, obj: ObjectRef): TableColumn[] {
  const rows = query(db, `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${sqlString(obj.name)})`);
  return rows.map((row) => {
    const typeName = text(row[1]) || "any";
    const kind: ColKind = /int|real|num|dec|floa|doub/i.test(typeName) ? "number" : /date|time/i.test(typeName) ? "date" : "text";
    return {
      name: text(row[0]),
      typeName,
      nullable: num(row[2]) === 0,
      primaryKey: num(row[4]) > 0,
      identity: /int/i.test(typeName) && num(row[4]) > 0,
      default: row[3] === null || row[3] === undefined ? null : text(row[3]),
      kind,
    };
  });
}

function download(filename: string, body: string, type: string) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "export.txt";
  a.click();
  URL.revokeObjectURL(url);
}

function pickFile(accept: string): Promise<{ name: string; text?: string; bytes?: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      if (!/\.(db|db3|sqlite|sqlite3)$/i.test(file.name)) {
        reader.onload = () => {
          const textContent = String(reader.result ?? "");
          textFiles.set(file.name, textContent);
          resolve({ name: file.name, text: textContent });
        };
        reader.readAsText(file);
        return;
      }
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        fileBytes.set(file.name, bytes);
        resolve({ name: file.name, bytes });
      };
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });
}

export function createDemoBackend(): Backend {
  return {
    async listConnections() {
      return summaries();
    },
    async saveConnection(cfg) {
      const list = loadConns();
      const next = { ...cfg, id: cfg.id || crypto.randomUUID(), password: null };
      const index = list.findIndex((item) => item.id === next.id);
      if (index >= 0) list[index] = next;
      else list.push(next);
      writeJson("celer.connections", list);
      if (cfg.savePassword && cfg.password) {
        const secrets = readJson<Record<string, string>>("celer.secrets", {});
        secrets[next.id] = cfg.password;
        writeJson("celer.secrets", secrets);
      } else if (!cfg.savePassword) {
        const secrets = readJson<Record<string, string>>("celer.secrets", {});
        delete secrets[next.id];
        writeJson("celer.secrets", secrets);
      }
      if (cfg.filePath && fileBytes.has(cfg.filePath)) fileBytes.set(next.id, fileBytes.get(cfg.filePath)!);
      return next;
    },
    async reorderConnections(ids) {
      const list = loadConns();
      list.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      writeJson("celer.connections", list);
    },
    async deleteConnection(id) {
      writeJson(
        "celer.connections",
        loadConns().filter((item) => item.id !== id),
      );
      databases.get(id)?.close();
      databases.delete(id);
      for (const [sid, session] of sessions) {
        if (session.connId === id) sessions.delete(sid);
      }
    },
    async testConnection(cfg) {
      const db = await databaseFor({ ...cfg, id: cfg.id || "test-tmp" });
      const version = text(query(db, "SELECT sqlite_version()")[0]?.[0]);
      if (!cfg.id) {
        db.close();
        databases.delete("test-tmp");
      }
      return `SQLite ${version} — ${cfg.filePath || ":memory:"}\nTiempo de respuesta: 1 ms`;
    },
    async openSession(connId, password) {
      const cfg = loadConns().find((item) => item.id === connId);
      if (!cfg) throw new Error("Conexión no encontrada");
      if (cfg.kind !== "sqlite" && cfg.kind !== "odbc") {
        throw new Error("En el navegador solo está disponible SQLite. Abre la aplicación de escritorio para SQL Server, Informix y ODBC.");
      }
      if (cfg.kind === "odbc") throw new Error("ODBC requiere la aplicación de escritorio.");
      const secrets = readJson<Record<string, string>>("celer.secrets", {});
      if (!cfg.integratedAuth && cfg.kind !== "sqlite" && !password && !secrets[cfg.id]) {
        throw new Error("Hace falta la contraseña");
      }
      const db = await databaseFor(cfg);
      if (cfg.startupSql?.trim()) {
        try {
          db.exec(cfg.startupSql);
        } catch (err) {
          throw new Error(`El script de inicio de la conexión falló: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { connId, db, database: "main", inTx: false, cursor: null });
      const version = text(query(db, "SELECT sqlite_version()")[0]?.[0]);
      const info: SessionInfo = {
        sessionId,
        database: "main",
        serverInfo: `SQLite ${version} — ${cfg.filePath || "memoria"} (demo navegador)`,
      };
      return info;
    },
    async closeSession(sessionId) {
      sessions.delete(sessionId);
    },
    async closeConnectionSessions(connId) {
      let closed = 0;
      for (const [sid, session] of sessions) {
        if (session.connId === connId) {
          sessions.delete(sid);
          closed++;
        }
      }
      return closed;
    },
    async execute(sessionId, sql, fetch) {
      const session = requireSession(sessionId);
      if (loadConns().find((item) => item.id === session.connId)?.readOnly && /^\s*(insert|update|delete|drop|alter|create)\b/i.test(sql)) {
        throw new Error("La conexión es de solo lectura: no se permiten sentencias que modifiquen datos");
      }
      const started = performance.now();
      session.cursor = null;
      let sets: QueryExecResult[] = [];
      try {
        sets = session.db.exec(sql);
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
      const keyword = sql.trim().split(/\s+/)[0]?.toUpperCase();
      if (keyword === "BEGIN") session.inTx = true;
      if (keyword === "COMMIT" || keyword === "ROLLBACK" || keyword === "END") session.inTx = false;
      const elapsedMs = Math.max(1, Math.round(performance.now() - started));
      if (!sets.length) {
        const changed = session.db.getRowsModified();
        const output: ExecOutput = {
          results: [{ columns: [], rows: [], hasMore: false, rowsAffected: changed }],
          messages: [changed === 1 ? "1 fila afectada" : `${changed} filas afectadas`],
          elapsedMs,
          inTransaction: session.inTx,
        };
        return output;
      }
      const first = toResult(sets[0], fetch);
      const extra = sets.slice(1).map((set) => toResult(set).result);
      if (first.rest.length || extra.length) {
        session.cursor = { rows: first.rest, index: 0, extra: first.rest.length ? extra : [] };
      }
      if (!first.rest.length && extra.length) {
        return {
          results: [first.result, ...extra],
          messages: [],
          elapsedMs,
          inTransaction: session.inTx,
        };
      }
      return { results: [first.result], messages: [], elapsedMs, inTransaction: session.inTx };
    },
    async fetch(sessionId, n) {
      const session = requireSession(sessionId);
      const cursor = session.cursor;
      if (!cursor) return { rows: [], hasMore: false, extra: [] } satisfies FetchOutput;
      const rows = cursor.rows.slice(cursor.index, cursor.index + n);
      cursor.index += rows.length;
      const hasMore = cursor.index < cursor.rows.length;
      if (hasMore) return { rows, hasMore: true, extra: [] };
      const extra = cursor.extra;
      session.cursor = null;
      return { rows, hasMore: false, extra };
    },
    async closeCursor(sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.cursor = null;
    },
    async cancel() {},
    async setAutocommit(sessionId, on) {
      const session = requireSession(sessionId);
      try {
        session.db.run(on ? "COMMIT" : "BEGIN");
        session.inTx = !on;
      } catch (err) {
        if (!on && !session.inTx) throw err instanceof Error ? err : new Error(String(err));
        if (on) session.inTx = false;
      }
      return session.inTx;
    },
    async commit(sessionId) {
      const session = requireSession(sessionId);
      if (session.inTx) session.db.run("COMMIT");
      session.inTx = false;
      return false;
    },
    async rollback(sessionId) {
      const session = requireSession(sessionId);
      if (session.inTx) session.db.run("ROLLBACK");
      session.inTx = false;
      return false;
    },
    async metaChildren(sessionId, path) {
      return meta(requireSession(sessionId).db, path);
    },
    async tableColumns(sessionId, obj) {
      return tableColumns(requireSession(sessionId).db, obj);
    },
    async objectDdl(sessionId, obj) {
      const rows = query(requireSession(sessionId).db, `SELECT sql FROM sqlite_schema WHERE name = ${sqlString(obj.name)}`);
      const ddl = text(rows[0]?.[0]);
      if (!ddl) throw new Error("No hay definición disponible");
      return ddl.endsWith(";") ? ddl : `${ddl};`;
    },
    async completion(sessionId) {
      const db = requireSession(sessionId).db;
      const tables = query(db, "SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const schema: CompletionSchema = { tables: [] };
      for (const row of tables) {
        const name = text(row[0]);
        const cols = query(db, `SELECT name FROM pragma_table_info(${sqlString(name)})`);
        schema.tables.push({ schema: "main", name, columns: cols.map((col) => text(col[0])) });
      }
      return schema;
    },
    async listDatabases(sessionId) {
      return query(requireSession(sessionId).db, "SELECT name FROM pragma_database_list ORDER BY seq").map((row) => text(row[0]));
    },
    async useDatabase(sessionId, database) {
      const session = requireSession(sessionId);
      const found = query(session.db, `SELECT name FROM pragma_database_list WHERE name = ${sqlString(database)}`);
      if (!found.length) throw new Error(`Base de datos no encontrada: ${database}`);
      session.database = database;
      return database;
    },
    async objectSql(_sessionId, obj) {
      const schema = obj.schema || "main";
      const qualified = `${quoteIdent(schema)}.${quoteIdent(obj.name)}`;
      return { qualified, select: `SELECT * FROM ${qualified}` };
    },
    async quoteIdents(_sessionId, names) {
      return names.map(quoteIdent);
    },
    async exportQuery(connId, _database, sql, _exportId, options) {
      const cfg = loadConns().find((item) => item.id === connId);
      if (!cfg) throw new Error("Conexión no encontrada");
      const db = await databaseFor(cfg);
      const sets = db.exec(sql);
      if (!sets[0]) throw new Error("La consulta no devuelve filas para exportar");
      const { result } = toResult(sets[0]);
      const format = options.format === "xlsx" ? "csv" : options.format;
      const body = resultToText(result, format, options.tableName || "tabla", options.delimiter);
      const filename = options.path || `export.${format === "markdown" ? "md" : format}`;
      download(filename.split(/[\\/]/).pop() || filename, body, "text/plain");
      return result.rows.length;
    },
    async addHistory(entry) {
      const all = readJson<HistoryEntry[]>("celer.history", []);
      all.push(entry);
      writeJson("celer.history", all.slice(-2000));
    },
    async getHistory(filter, limit) {
      const f = filter.toLowerCase();
      return readJson<HistoryEntry[]>("celer.history", [])
        .filter((entry) => !f || entry.sql.toLowerCase().includes(f) || entry.connName.toLowerCase().includes(f))
        .reverse()
        .slice(0, limit);
    },
    async clearHistory() {
      localStorage.removeItem("celer.history");
    },
    async loadJson(name) {
      const value = localStorage.getItem(`celer.${name}`);
      return value ? JSON.parse(value) : null;
    },
    async saveJson(name, value) {
      writeJson(`celer.${name}`, value);
    },
    async readTextFile(path) {
      const hit = textFiles.get(path);
      if (hit !== undefined) return { text: hit, encoding: "utf-8" };
      throw new Error("En el navegador abre el script con el botón Abrir");
    },
    async readSpreadsheet() {
      throw new Error("Las hojas de cálculo se importan en la aplicación de escritorio; en el navegador, guárdala como CSV");
    },
    async writeTextFile(path, content) {
      textFiles.set(path, content);
      download(path.split(/[\\/]/).pop() || "script.sql", content, "text/plain");
      return "utf-8";
    },
    async odbcDrivers() {
      return [];
    },
    async odbcDsns() {
      return [];
    },
    async ibmDriverStatus() {
      return null;
    },
    async ibmDriverDownload() {
      throw new Error("La descarga del driver IBM solo está disponible en la aplicación de escritorio");
    },
    async informixDrivers() {
      return { cli: null, java: [], javaUsed: null, javaMin: 11, jdbc: [], jdbcUsed: null, jdbcVersion: "4.50.10.1", odbc: [], sdkReady: false, bridge: false, jreDownload: false };
    },
    async jdbcDownload() {
      throw new Error("Las descargas de drivers solo están disponibles en la aplicación de escritorio");
    },
    async jdbcCheck() {
      throw new Error("Informix por JDBC solo está disponible en la aplicación de escritorio");
    },
    async jdbcPrewarm() {},
    async driverDownloadCancel() {},
    async mcpConfigGet() {
      return { enabled: false, maxRows: 200, timeoutSecs: 30, redactPattern: "", connections: {} };
    },
    async mcpConfigSet() {
      throw new Error("El servidor MCP solo está disponible en la aplicación de escritorio");
    },
    async mcpAudit() {
      return [];
    },
    async mcpClearAudit() {},
    async mcpClientInfo() {
      return { exePath: "celer.exe", args: ["--mcp"], claudeDesktopConfigPath: "", claudeDesktopConfigured: false, claudeCodeCommand: "claude mcp add celer -- celer.exe --mcp" };
    },
    async mcpInstallClaudeDesktop() {
      throw new Error("Solo en la aplicación de escritorio");
    },
    async mcpTestTool() {
      throw new Error("Solo en la aplicación de escritorio");
    },
    async aiKeyStatus() {
      return Boolean(sessionStorage.getItem("celer.ai-key"));
    },
    async aiKeySet(key) {
      // Browser demo only: kept for this tab session, never persisted.
      if (key) sessionStorage.setItem("celer.ai-key", key);
      else sessionStorage.removeItem("celer.ai-key");
    },
    async aiKeyGet() {
      return sessionStorage.getItem("celer.ai-key");
    },
    async appInfo() {
      return { version: "dev", dataDir: "navegador (localStorage)" };
    },
    async migrationSources() {
      return [];
    },
    // Browser demo: "?update" in the URL simulates a new release to design the update flow.
    async updateCheck() {
      const simulate = new URLSearchParams(location.search).has("update");
      return {
        current: "1.1.0",
        latest: simulate ? "1.2.0" : "1.1.0",
        available: simulate,
        notes: "### Added\n- Celer se actualiza solo desde la barra de estado.\n- Gib tiene brazos y anima todo el cuerpo.\n\n### Fixed\n- El filtro *entre* acepta fechas.",
        publishedAt: new Date().toISOString(),
        htmlUrl: "https://github.com/e-omunoz/celer/releases",
        assetUrl: "",
        assetName: "Celer-Setup-1.2.0.exe",
        assetSize: 12_538_880,
        sumsUrl: "",
        installed: true,
        installKind: "setup" as const,
      };
    },
    async updateDownload() {
      throw new Error("En el navegador no se pueden instalar actualizaciones.");
    },
    async updateInstall() {},
    async onUpdateDownload() {
      return () => {};
    },
    async pickSavePath() {
      return null;
    },
    async pickOpenPath(filters) {
      const accept = filters.flatMap((filter) => filter.extensions.map((ext) => `.${ext}`)).join(",");
      const picked = await pickFile(accept || "*");
      return picked?.name ?? null;
    },
    async onExportProgress() {
      return () => {};
    },
    async onDriverDownload() {
      return () => {};
    },
  };
}
