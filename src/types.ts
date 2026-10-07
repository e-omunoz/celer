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
  { kind: "informix", label: "Informix", hint: "IBM CLI (DRDA) o Client SDK", port: 9088, user: "informix", color: "#4B6EAF" },
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
  informixMode: string;
  odbcConnStr: string;
  extra: string;
  color: string;
  production: boolean;
  readOnly: boolean;
  folder: string;
  filePath: string;
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
}

export interface ExportOptions {
  format: "csv" | "tsv" | "json" | "sql" | "markdown" | "html" | "xlsx";
  sqlBatch?: number;
  path: string;
  delimiter: string;
  header: boolean;
  bom: boolean;
  tableName: string;
  nullText: string;
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
}

export const defaultSettings: Settings = {
  theme: "dark",
  accent: "#D97757",
  fontSize: 13,
  editorFontSize: 13,
  pageSize: 500,
  ibmDriverPath: "",
  sidebarWidth: 280,
  inspectorWidth: 320,
  editorRatio: 0.45,
  companion: "normal",
  density: "compact",
  zebra: true,
  confirmMutations: true,
  aiModel: "claude-opus-5-5",
  onboarded: false,
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
    informixMode: "drda",
    odbcConnStr: "",
    extra: "",
    color: "",
    production: false,
    readOnly: false,
    folder: "",
    filePath: kind === "sqlite" ? "" : "",
  };
}

export type McpLevel = "none" | "schema" | "read" | "write";

export interface McpConfig {
  enabled: boolean;
  maxRows: number;
  timeoutSecs: number;
  redactPattern: string;
  connections: Record<string, { level: McpLevel; maxRows?: number | null }>;
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
}

export interface McpClientInfo {
  exePath: string;
  args: string[];
  claudeDesktopConfigPath: string;
  claudeDesktopConfigured: boolean;
  claudeCodeCommand: string;
}