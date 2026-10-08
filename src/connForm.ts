// The connection form's rules, as pure functions (no store, no IPC) so they can be tested
// (dev/connform-check.ts): which fields apply to a connection, what is wrong with them, and filling the form from
// a JDBC URL.
import { emptyConn, engineOf, type ConnConfig, type DbKind } from "./types.ts";
import { parseJdbc, type JdbcInfo } from "./migrateParse.ts";

const NETWORK: DbKind[] = ["postgres", "mysql", "mssql", "informix"];

export const isNetwork = (kind: DbKind) => NETWORK.includes(kind);

/** The fields of the form that apply to this connection (the others are hidden, not disabled). */
export interface VisibleFields {
  file: boolean;
  odbc: boolean;
  host: boolean;
  port: boolean;
  user: boolean;
  password: boolean;
  savePassword: boolean;
  integratedAuth: boolean;
  database: boolean;
  instance: boolean;
  /** "Instancia" (SQL Server) or "INFORMIXSERVER". */
  instanceLabel: string;
  informixMode: boolean;
  encryption: boolean;
  trustCert: boolean;
  extra: boolean;
}

export function visibleFields(cfg: ConnConfig): VisibleFields {
  const kind = cfg.kind;
  const network = isNetwork(kind);
  const windows = kind === "mssql" && cfg.integratedAuth;
  // Generic ODBC: user and password only when the connection string does not carry them.
  const odbcUser = kind === "odbc" && !/(^|;)\s*UID\s*=/i.test(cfg.odbcConnStr);
  const odbcPassword = kind === "odbc" && !/(^|;)\s*PWD\s*=/i.test(cfg.odbcConnStr);
  const tls = kind === "postgres" || kind === "mysql" || kind === "mssql";
  const user = (network && !windows) || odbcUser;
  const password = (network && !windows) || odbcPassword;
  return {
    file: kind === "sqlite",
    odbc: kind === "odbc",
    host: network,
    port: network,
    user,
    password,
    savePassword: password,
    integratedAuth: kind === "mssql",
    database: network,
    // DRDA has no INFORMIXSERVER: the IBM CLI reaches the database by host and port.
    instance: kind === "mssql" || (kind === "informix" && cfg.informixMode !== "drda"),
    instanceLabel: kind === "informix" ? "INFORMIXSERVER" : "Instancia",
    informixMode: kind === "informix",
    encryption: tls,
    trustCert: tls && cfg.encryption !== "off",
    // SQL Server and SQLite do not read "Parámetros extra".
    extra: kind === "postgres" || kind === "mysql" || kind === "informix",
  };
}

export type IssueField = "name" | "host" | "port" | "user" | "database" | "instance" | "filePath" | "odbcConnStr" | "extra";

/** Something wrong with a field: an error blocks saving and testing; a warning does not. */
export interface FieldIssue {
  field: IssueField;
  level: "error" | "warning";
  message: string;
  /** A one-click fix the form can offer ("Separar"). */
  fix?: Partial<ConnConfig>;
  fixLabel?: string;
}

/** The problems of a connection's fields; `others` are the saved connections (for repeated names). */
export function validateConn(cfg: ConnConfig, others: { id: string; name: string }[] = []): FieldIssue[] {
  const out: FieldIssue[] = [];
  const show = visibleFields(cfg);
  const error = (field: IssueField, message: string, fix?: Partial<ConnConfig>, fixLabel?: string) => out.push({ field, level: "error", message, fix, fixLabel });
  const warn = (field: IssueField, message: string, fix?: Partial<ConnConfig>, fixLabel?: string) => out.push({ field, level: "warning", message, fix, fixLabel });

  const name = cfg.name.trim().toLowerCase();
  if (name && others.some((other) => other.id !== cfg.id && other.name.trim().toLowerCase() === name)) {
    warn("name", "Ya hay otra conexión con este nombre.");
  }

  if (show.host) {
    const host = cfg.host.trim();
    if (!host) error("host", "Indica el servidor: un nombre o una dirección IP.");
    else if (/^jdbc:/i.test(host)) error("host", "Es una URL JDBC: pégala en «URL JDBC» y Celer rellena el formulario.");
    else if (/\s/.test(host)) error("host", "El servidor no puede llevar espacios.");
    else {
      const withPort = /^([^:\\[\]]+):(\d{1,5})$/.exec(host);
      const withInstance = /^([^\\]+)\\([^\\]+)$/.exec(host);
      if (withPort) {
        warn("host", `Parece que lleva el puerto (${withPort[2]}): va en «Puerto».`, { host: withPort[1], port: Number(withPort[2]) }, "Separar");
      } else if (withInstance && cfg.kind === "mssql") {
        warn("host", `Lleva la instancia (${withInstance[2]}): mejor en «Instancia».`, withInstanceName(cfg, withInstance[2], { host: withInstance[1] }), "Separar");
      } else if (withInstance) {
        error("host", "El servidor no puede llevar «\\»: escribe solo el nombre o la IP.");
      }
    }
  }

  if (show.port && cfg.port !== null && cfg.port !== undefined) {
    const port = cfg.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) error("port", "El puerto es un número entero entre 1 y 65535.");
  }

  if (show.user && isNetwork(cfg.kind) && !cfg.user.trim()) error("user", "Indica el usuario.");

  if (cfg.kind === "informix") {
    if (cfg.informixMode === "drda" && !cfg.database.trim()) {
      error("database", "Por DRDA hay que indicar la base de datos: el driver IBM CLI no conecta sin ella.");
    }
    if (show.instance && !cfg.instance.trim()) {
      if (cfg.informixMode === "sqli") error("instance", "El Client SDK necesita INFORMIXSERVER: el nombre del servidor (DBSERVERNAME) o uno de sus alias.");
      else if (cfg.informixMode === "auto") warn("instance", "Sin INFORMIXSERVER conecta por JDBC; el Client SDK lo necesita.");
    }
  }

  if (show.file && !cfg.filePath.trim()) error("filePath", "Elige el fichero de la base de datos, o «Memoria».");

  if (show.odbc) {
    const text = cfg.odbcConnStr.trim();
    if (!text) error("odbcConnStr", "Escribe la cadena de conexión: DSN=… o DRIVER={…};…");
    else if (!/(^|;)\s*(DSN|FILEDSN|DRIVER)\s*=/i.test(text)) error("odbcConnStr", "La cadena ODBC tiene que llevar DSN=, FILEDSN= o DRIVER=.");
  }

  if (show.extra && cfg.extra.trim()) {
    for (const part of cfg.extra.split(/[;\n\r]/).map((p) => p.trim()).filter(Boolean)) {
      const at = part.indexOf("=");
      if (at < 0) {
        error("extra", `«${part}» no tiene la forma clave=valor (separa los parámetros con «;»).`);
        break;
      }
      const key = part.slice(0, at).trim();
      if (!key || /\s/.test(key)) {
        error("extra", `«${part}»: la clave no puede estar vacía ni llevar espacios.`);
        break;
      }
    }
  }
  return out;
}

/** Whether some issue is an error (they block saving and testing). */
export const hasErrors = (issues: FieldIssue[]) => issues.some((issue) => issue.level === "error");

const ENCRYPTION_LABEL: Record<string, string> = { required: "cifrado obligatorio", login: "cifrado preferido", off: "sin cifrado" };

/**
 * Fills a connection from a JDBC URL: the engine (keeping name, folder, colour and flags when it changes) and every
 * field the URL gives. The URL describes the whole connection, so database, instance and extra parameters it does
 * not mention are cleared; the user stays when the URL has none. Never the password. `notes`: a summary of what was
 * filled, then what was left out. null when it is not a JDBC URL of an engine Celer connects to.
 */
export function applyJdbcUrl(cfg: ConnConfig, url: string): { cfg: ConnConfig; notes: string[] } | null {
  const info = parseJdbc(url);
  if (!info) return null;
  const same = cfg.kind === info.kind;
  const base = emptyConn(info.kind);
  const next: ConnConfig = same
    ? { ...cfg }
    : {
        ...base,
        id: cfg.id,
        name: cfg.name,
        folder: cfg.folder,
        color: cfg.color,
        production: cfg.production,
        readOnly: cfg.readOnly,
        savePassword: cfg.savePassword,
        startupSql: cfg.startupSql,
        password: cfg.password,
      };
  const filled: string[] = [];
  if (info.kind === "sqlite") {
    next.filePath = info.file ?? ":memory:";
    next.host = "";
    filled.push(next.filePath === ":memory:" ? "base en memoria" : `fichero ${next.filePath}`);
  } else {
    if (info.kind === "informix") next.informixMode = informixModeFor(info, same ? cfg.informixMode : base.informixMode);
    next.host = info.host ?? "localhost";
    next.instance = info.instance ?? "";
    next.port = info.port ?? defaultPort(next);
    next.database = info.database ?? "";
    if (info.user) next.user = info.user;
    if (info.kind === "mssql") next.integratedAuth = info.integratedAuth ?? false;
    if (info.encryption) next.encryption = info.encryption;
    if (info.trustCert !== undefined) next.trustCert = info.trustCert;
    next.extra = info.params ?? "";
    filled.push(`servidor ${next.host}`);
    if (next.instance) filled.push(`${info.kind === "informix" ? "INFORMIXSERVER" : "instancia"} ${next.instance}`);
    filled.push(`puerto ${next.port ?? "predeterminado"}`);
    if (next.database) filled.push(`base ${next.database}`);
    if (next.integratedAuth) filled.push("autenticación de Windows");
    else if (info.user) filled.push(`usuario ${info.user}`);
    if (info.kind === "informix") filled.push(next.informixMode === "drda" ? "protocolo DRDA" : "protocolo SQLI");
    if (info.encryption) filled.push(ENCRYPTION_LABEL[info.encryption] ?? info.encryption);
    if (info.trustCert === true && next.encryption !== "off") filled.push("confiar en el certificado");
    if (info.params) filled.push(`parámetros extra ${info.params}`);
  }
  const notes = [`${engineOf(info.kind).label}: ${filled.join(", ")}.`];
  if (info.password) notes.push("La URL traía una contraseña: no se ha copiado. Escríbela en «Contraseña».");
  if (info.otherHosts.length) notes.push(`Celer conecta al primer servidor; no se usan: ${info.otherHosts.join(", ")}.`);
  if (info.ignored.length) notes.push(`Parámetros de la URL que Celer no usa: ${info.ignored.join(", ")}.`);
  return { cfg: next, notes };
}

/** SQLI URLs keep a SQLI protocol the connection already had (Automático, JDBC or Client SDK). */
function informixModeFor(info: JdbcInfo, current: string): string {
  if (info.informixMode === "drda") return "drda";
  return current === "jdbc" || current === "sqli" || current === "auto" ? current : "auto";
}

/**
 * The usual port of a connection (Informix: 9089 for DRDA, 9088 for SQLI). None for a SQL Server named instance:
 * SQL Server Browser tells its port, as mssql-jdbc does.
 */
export function defaultPort(cfg: ConnConfig): number | null {
  if (cfg.kind === "informix") return cfg.informixMode === "drda" ? 9089 : 9088;
  if (cfg.kind === "mssql" && cfg.instance.trim()) return null;
  return engineOf(cfg.kind).port;
}

/**
 * The patch that sets a SQL Server instance (plus `patch`): the port, if it is still the default 1433, is left empty
 * so that SQL Server Browser gives the instance's own port. A port the user typed stays.
 */
export function withInstanceName(cfg: ConnConfig, instance: string, patch: Partial<ConnConfig> = {}): Partial<ConnConfig> {
  const out: Partial<ConnConfig> = { ...patch, instance };
  if (cfg.kind === "mssql" && instance.trim() && cfg.port === engineOf("mssql").port) out.port = null;
  return out;
}

/** Whether a text looks like a JDBC URL (pasted in the server field, for example). */
export const looksLikeJdbcUrl = (text: string) => /^\s*jdbc:[a-z]/i.test(text);
