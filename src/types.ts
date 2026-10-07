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

export type DbKind = "mssql" | "informix" | "odbc" | "sqlite";

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
  format: "csv" | "tsv" | "json" | "sql" | "xlsx";
  path: string;
  delimiter: string;
  header: boolean;
  bom: boolean;
  tableName: string;
  nullText: string;
}

export type ThemeName = "system" | "light" | "dark" | "contrast";

export interface Settings {
  theme: ThemeName;
  accent: string;
  fontSize: number;
  editorFontSize: number;
  pageSize: number;
  ibmDriverPath: string;
  sidebarWidth: number;
}

export const defaultSettings: Settings = {
  theme: "system",
  accent: "#c2410c",
  fontSize: 13,
  editorFontSize: 13,
  pageSize: 200,
  ibmDriverPath: "",
  sidebarWidth: 280,
};

export function emptyConn(kind: DbKind = "sqlite"): ConnConfig {
  const port = kind === "mssql" ? 1433 : kind === "informix" ? 9088 : null;
  return {
    id: "",
    name: "",
    kind,
    host: kind === "sqlite" ? "" : "localhost",
    port,
    instance: "",
    database: "",
    user: kind === "mssql" ? "sa" : "",
    password: "",
    savePassword: true,
    integratedAuth: false,
    encryption: "required",
    trustCert: true,
    informixMode: "drda",
    odbcConnStr: "",
    extra: "",
    color: "#c2410c",
    production: false,
    readOnly: false,
    folder: "",
    filePath: kind === "sqlite" ? "" : "",
  };
}
