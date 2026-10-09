export type Cell = null | boolean | number | string;

export type ColKind = "number" | "text" | "bool" | "date" | "binary" | "other";

export interface ColumnInfo {
  name: string;
  typeName: string;
  kind: ColKind;
}

export interface ResultSet {
  columns: ColumnInfo[];
  rows: Cell[][];
  hasMore: boolean;
  rowsAffected: number | null;
}

export interface ExecOutput {
  results: ResultSet[];
  messages: string[];
  elapsedMs: number;
  inTransaction: boolean;
}

export interface FetchOutput {
  rows: Cell[][];
  hasMore: boolean;
  extra: ResultSet[];
}

export type DbKind = "postgres" | "mysql" | "mssql" | "sqlite" | "informix" | "odbc";

export const ENGINES: { kind: DbKind; label: string; hint: string; port: number | null; user: string; color: string }[] = [
  { kind: "postgres", label: "PostgreSQL", hint: "Nativo · también CockroachDB, Timescale, Supabase", port: 5432, user: "postgres", color: "#336791" },
  { kind: "mysql", label: "MySQL / MariaDB", hint: "Nativo · también TiDB, PlanetScale", port: 3306, user: "root", color: "#C0765A" },
  { kind: "mssql", label: "SQL Server", hint: "TDS nativo · autenticación SQL y Windows", port: 1433, user: "sa", color: "#CC2927" },
  { kind: "sqlite", label: "SQLite", hint: "Embebido · un fichero o en memoria", port: null, user: "", color: "#4F8FBF" },
  { kind: "informix", label: "Informix", hint: "JDBC o Client SDK (SQLI), IBM CLI (DRDA)", port: 9088, user: "informix", color: "#4B6EAF" },
  { kind: "odbc", label: "ODBC", hint: "Cualquier origen de datos ODBC", port: null, user: "", color: "#7C8796" },
];

export function engineOf(kind: DbKind | undefined) {
  return ENGINES.find((engine) => engine.kind === kind) ?? ENGINES[ENGINES.length - 1];
}

export interface ConnConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number | null;
  instance: string;
  database: string;
  user: string;
  password?: string | null;
  savePassword: boolean;
  integratedAuth: boolean;
  encryption: string;
  trustCert: boolean;
  /** Informix: "auto" (Client SDK if installed, else JDBC) | "jdbc" | "sqli" (Client SDK, ODBC) | "drda" (IBM CLI). */
  informixMode: string;
  odbcConnStr: string;
  extra: string;
  color: string;
  production: boolean;
  readOnly: boolean;
  folder: string;
  filePath: string;
  /** Statements run on every new session right after connecting (SET search_path…, SET LOCK_TIMEOUT…). */
  startupSql?: string;
}

export interface ConnSummary extends ConnConfig {
  hasPassword: boolean;
}

export interface MetaNode {
  name: string;
  kind: string;
  detail?: string | null;
  path: string[];
  leaf: boolean;
  obj?: ObjectRef | null;
}

export interface ObjectRef {
  database: string;
  schema: string;
  name: string;
  kind: string;
}

export interface TableColumn {
  name: string;
  typeName: string;
  nullable: boolean;
  primaryKey: boolean;
  identity: boolean;
  default?: string | null;
  kind: ColKind;
}

export interface CompletionTable {
  schema: string;
  name: string;
  columns: string[];
}

export interface CompletionSchema {
  tables: CompletionTable[];
}

export interface HistoryEntry {
  sql: string;
  connId: string;
  connName: string;
  database: string;
  at: number;
  elapsedMs: number;
  ok: boolean;
  rows: number | null;
}

export interface SessionInfo {
  sessionId: string;
  database: string;
  serverInfo: string;
  /** Time to get the session ready (login, or taking a free connection of the same settings). */
  connectMs: number;
  /** A free connection of the same settings was taken instead of logging in again. */
  reused: boolean;
}

/** How a session should start: right in a database and transaction mode (no extra round trips afterwards). */
export interface OpenSessionOptions {
  database?: string;
  autocommit?: boolean;
}

/** One step of "Probar conexión", timed. */
export interface ConnTestStep {
  /** resolve | tcp | tls | login | database */
  id: string;
  label: string;
  status: "ok" | "failed" | "skipped";
  ms: number;
  detail: string;
}

/** "Probar conexión": the steps, the way Celer reached the server and, when it failed, what to do. */
export interface ConnTestReport {
  ok: boolean;
  steps: ConnTestStep[];
  /** Driver and protocol used ("TDS nativo · TLS obligatorio", "Automático → SQLI por JDBC · Java 21…"). */
  route: string;
  serverInfo: string;
  totalMs: number;
  /** The driver's error as it came (it may carry a code: INFORMIX_GUIDE:…, JDBC_SETUP:…). */
  error: string;
  /** What the error means and what to do, in plain words ("" when Celer does not know). */
  hint: string;
}

/** A session checked (and reconnected if it had dropped). */
export interface SessionHealth {
  ok: boolean;
  /** The connection had dropped and a new one took its place. */
  reconnected: boolean;
  /** What the session had and lost with the old connection ("" if nothing): transaction, #temp tables, SET… */
  lost: string;
  ms: number;
  error: string;
}

export interface ExportOptions {
  format: "csv" | "tsv" | "json" | "sql" | "markdown" | "html" | "xml" | "xlsx";
  sqlBatch?: number;
  path: string;
  delimiter: string;
  header: boolean;
  bom: boolean;
  tableName: string;
  nullText: string;
  /** The grid's column order (src/columnOrder.ts); the core applies it only to the columns it was made for. */
  columnOrder?: { names: string[]; order: number[] } | null;
}

export type ThemeName = "system" | "light" | "dark" | "darcula" | "contrast" | "contrast-light" | "fjord" | "sand";

export type CompanionMode = "off" | "quiet" | "normal";

export const ACCENTS = [
  { name: "Clay", value: "#D97757" },
  { name: "Ember", value: "#F26B1D" },
  { name: "Blue", value: "#3B82F6" },
  { name: "Teal", value: "#14B8A6" },
  { name: "Violet", value: "#8B5CF6" },
  { name: "Green", value: "#22C55E" },
] as const;

export interface Settings {
  theme: ThemeName;
  accent: string;
  fontSize: number;
  editorFontSize: number;
  pageSize: number;
  ibmDriverPath: string;
  /** Java for Informix over JDBC: an executable or a JRE/JDK folder (empty: found on its own). */
  javaPath: string;
  /** Informix JDBC driver: a jar or a folder with one (empty: DBeaver's or the one Celer downloaded). */
  informixJdbcPath: string;
  sidebarWidth: number;
  inspectorWidth: number;
  editorRatio: number;
  companion: CompanionMode;
  density: "compact" | "comfortable";
  zebra: boolean;
  confirmMutations: boolean;
  aiModel: string;
  /** The start-up guide was completed or skipped. */
  onboarded: boolean;
  /** Look for a new release on start-up (and every few hours). */
  checkUpdates: boolean;
  /** A release the user chose to skip: no reminders until a newer one appears. */
  skippedVersion: string;
  /** The user's live templates (they replace built-in ones with the same name). */
  snippets: Snippet[];
  /** Ask for the values of :name, ? and ${name} parameters before running. */
  askParams: boolean;
  /** On every connection, confirm a DELETE or UPDATE without WHERE. */
  confirmNoWhere: boolean;
  /** Animations: follow the system setting, keep them to a minimum, or always on. */
  motion: "system" | "reduce" | "full";
  /** Shortcuts the user changed, per command id (keymap.ts); an empty list leaves the command without one. */
  keymap: Record<string, string[]>;
  /** Explorer: folders the user created, shown even when empty ("/" between nested levels: "Clientes/Egarsat"). */
  connFolders: string[];
  /** Explorer: folders shown closed. */
  collapsedFolders: string[];
  /** Explorer: connections in the order they were placed (manual) or by name. */
  connSort: "manual" | "alpha";
  /** Explorer: favourite connections (a star, and the "Favoritas" section on top). */
  favoriteConns: string[];
  /** Explorer: the connections connected to last, newest first. */
  recentConns: { id: string; at: number }[];
}

/** A live template for the SQL editor (see src/snippets.ts). */
export interface Snippet {
  name: string;
  description: string;
  body: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  publishedAt: string;
  htmlUrl: string;
  assetUrl: string;
  assetName: string;
  assetSize: number;
  sumsUrl: string;
  /** Installed with Celer Setup: the update installs itself and reopens Celer. */
  installed: boolean;
  /** setup: automatic, after «Actualizar» · portable / msi / other (macOS, Linux): the release page, nothing is run. */
  installKind: "setup" | "portable" | "msi" | "other";
}

export const defaultSettings: Settings = {
  theme: "dark",
  accent: "#D97757",
  fontSize: 13,
  editorFontSize: 13,
  pageSize: 500,
  ibmDriverPath: "",
  javaPath: "",
  informixJdbcPath: "",
  sidebarWidth: 280,
  inspectorWidth: 320,
  editorRatio: 0.45,
  companion: "normal",
  density: "compact",
  zebra: true,
  confirmMutations: true,
  aiModel: "claude-opus-5-5",
  onboarded: false,
  checkUpdates: true,
  skippedVersion: "",
  snippets: [],
  askParams: true,
  confirmNoWhere: true,
  motion: "system",
  keymap: {},
  connFolders: [],
  collapsedFolders: [],
  connSort: "manual",
  favoriteConns: [],
  recentConns: [],
};

export function emptyConn(kind: DbKind = "sqlite"): ConnConfig {
  const engine = engineOf(kind);
  const port = engine.port;
  return {
    id: "",
    name: "",
    kind,
    host: kind === "sqlite" ? "" : "localhost",
    port,
    instance: "",
    database: "",
    user: engine.user,
    password: "",
    savePassword: true,
    integratedAuth: false,
    encryption: kind === "mssql" ? "required" : "login",
    trustCert: true,
    informixMode: "auto",
    odbcConnStr: "",
    extra: "",
    color: "",
    production: false,
    readOnly: false,
    folder: "",
    filePath: kind === "sqlite" ? "" : "",
  };
}

export interface JavaFound {
  path: string;
  major: number;
  version: string;
  /** settings | JAVA_HOME | DBeaver | PATH | Celer */
  source: string;
}

export interface JdbcFound {
  jars: string[];
  version: string;
  /** settings | DBeaver | Celer */
  source: string;
}

/** What Informix can connect with on this machine (Settings › Drivers). */
export interface InformixDrivers {
  cli: string | null;
  java: JavaFound[];
  javaUsed: JavaFound | null;
  javaMin: number;
  jdbc: JdbcFound[];
  jdbcUsed: JdbcFound | null;
  jdbcVersion: string;
  /** Informix ODBC drivers registered (the Client SDK's). */
  odbc: string[];
  sdkReady: boolean;
  /** The JDBC bridge is part of this build. */
  bridge: boolean;
  jreDownload: boolean;
}

export type McpLevel = "none" | "schema" | "read" | "write";

export interface McpConfig {
  enabled: boolean;
  maxRows: number;
  timeoutSecs: number;
  redactPattern: string;
  connections: Record<string, { level: McpLevel; maxRows?: number | null }>;
  /** «Controlar la aplicación» (#100): what an assistant may do in the running Celer. */
  appControl: { enabled: boolean; openTabs: boolean; writeLibrary: boolean; runOpened: boolean };
}

export interface McpAuditEntry {
  at: number;
  tool: string;
  connId?: string | null;
  connName?: string | null;
  detail?: string | null;
  ok: boolean;
  rows?: number | null;
  ms?: number | null;
  error?: string | null;
  /** Where the assistant ran: "Windows", "WSL (Ubuntu)"… (older entries: none). */
  client?: string | null;
  /** The MCP client program ("claude-code"…). */
  clientApp?: string | null;
}

export interface McpClientInfo {
  exePath: string;
  args: string[];
  claudeDesktopConfigPath: string;
  claudeDesktopConfigured: boolean;
  claudeCodeCommand: string;
  /** Claude Code on this system: "yes", "stale" (registered with another path) or "no". */
  claudeCodeRegistered: "yes" | "stale" | "no";
  /** Windows: the WSL section applies. */
  wslSupported: boolean;
}

/** A WSL distro as Settings › IA y MCP shows it (src-tauri/src/mcp_wsl.rs). */
export interface WslDistro {
  name: string;
  default: boolean;
  running: boolean;
  /** Looked into (it was running, or the user asked). */
  checked: boolean;
  interop: boolean | null;
  home: string;
  /** Where `claude` is in the distro ("" when not found). */
  claude: string;
  automountRoot: string;
  /** celer.exe as the distro sees it (/mnt/c/…). */
  exePath: string;
  command: string;
  registered: "yes" | "stale" | "no" | "unknown";
  registeredCommand: string;
  error: string;
}

export interface WslInfo {
  available: boolean;
  distros: WslDistro[];
  error: string;
  checkedAt: number;
}

/** The status bar's MCP indicator. */
export interface McpStatus {
  enabled: boolean;
  /** «Controlar la aplicación» is on. */
  appControl: boolean;
  clients: { name: string; place: string; state: "yes" | "stale" }[];
  /** The WSL distros have been read (it takes a moment after start). */
  wslChecked: boolean;
  lastCall: McpAuditEntry | null;
}
