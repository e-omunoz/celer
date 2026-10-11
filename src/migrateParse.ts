// Parsers for the migration assistant: DBeaver data-sources.json and DbVisualizer dbvis.xml → Celer connection
// configs. DBeaver's encrypted credentials-config.json is applied separately (applyDbeaverCredentials), only when the
// user asks to import the saved passwords. Pure functions (no store, no IPC) so they can be tested.
import { emptyConn, emptySsh, type ConnConfig, type DbKind } from "./types.ts";

export interface MigrationSource {
  tool: "dbeaver" | "dbvisualizer";
  project: string;
  path: string;
  text: string;
}

export interface Candidate {
  key: string;
  tool: MigrationSource["tool"];
  project: string;
  cfg: ConnConfig;
  /** Source driver as written in the tool (shown for unsupported ones). */
  driver: string;
  status: "new" | "exists" | "unsupported";
  reason: string;
  /** File it came from (DBeaver: its credentials-config.json sits next to it). */
  sourcePath: string;
  /** Id of the connection in that file (DBeaver keys its credentials by it). */
  sourceId: string;
  /** The tool says it keeps a password for this connection. */
  savedPassword: boolean;
  /** What the import left out (other hosts of a multi-host URL, properties Celer does not use…), for the list. */
  notes: string[];
}

const TOOL_LABEL = { dbeaver: "DBeaver", dbvisualizer: "DbVisualizer" } as const;
export const toolLabel = (tool: MigrationSource["tool"]) => TOOL_LABEL[tool];

// ---------------------------------------------------------------- shared helpers

/**
 * host, port, database, file, instance and extra parameters of a JDBC URL: a thin view of `parseJdbc` (which reads
 * everything else too), {} when Celer does not understand the URL.
 */
export function parseJdbcUrl(url: string): { host?: string; port?: number; database?: string; file?: string; instance?: string; params?: string } {
  const info = parseJdbc(url);
  if (!info) return {};
  const out: ReturnType<typeof parseJdbcUrl> = {};
  for (const key of ["host", "port", "database", "file", "instance", "params"] as const) {
    if (info[key] !== undefined) (out as Record<string, unknown>)[key] = info[key];
  }
  return out;
}

/** Everything a JDBC URL says about a connection (the connection form's "URL JDBC"). */
export interface JdbcInfo {
  kind: DbKind;
  host?: string;
  port?: number;
  database?: string;
  /** SQLite: the file (":memory:" for a database in memory). */
  file?: string;
  /** SQL Server: the named instance. Informix: INFORMIXSERVER. */
  instance?: string;
  user?: string;
  /** The URL carried a password. It is never copied: passwords live in the system's credential store. */
  password: boolean;
  /** Celer's encryption setting ("required" | "login" | "off") when the URL says. */
  encryption?: string;
  trustCert?: boolean;
  /** SQL Server: Windows authentication (integratedSecurity=true). */
  integratedAuth?: boolean;
  /** Informix: "drda" for jdbc:ids URLs, "auto" for informix-sqli (SQLI). */
  informixMode?: string;
  /** What has no field of its own but the driver understands, as Celer's "Parámetros extra" (k=v;k=v). */
  params?: string;
  /** URL properties Celer does not use. */
  ignored: string[];
  /** Other servers of a multi-host URL (Celer connects to the first one). */
  otherHosts: string[];
}

const isTrue = (value: string) => /^(true|yes|1|on)$/i.test(value.trim());

/** URL-decoded text, or the text as it is when it is not valid percent-encoding. */
function safeDecode(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** "a=1&b=2" (or ";"-separated) → decoded [key, value] pairs. */
function splitProps(text: string, separator: string): [string, string][] {
  const decode = safeDecode;
  return text
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => [decode(part.slice(0, part.indexOf("=")).trim()), decode(part.slice(part.indexOf("=") + 1).trim())] as [string, string])
    .filter(([key]) => key.length > 0);
}

/** "//user:pass@h1:5432,h2/db?x=1" → the first host and port, the credentials, the path and the query. */
function splitAuthorityUrl(info: JdbcInfo, rest: string): { path: string; query: string } {
  let body = rest;
  let query = "";
  const q = body.indexOf("?");
  if (q >= 0) {
    query = body.slice(q + 1);
    body = body.slice(0, q);
  }
  if (!body.startsWith("//")) return { path: body, query };
  body = body.slice(2);
  const slash = body.indexOf("/");
  let authority = slash >= 0 ? body.slice(0, slash) : body;
  const path = slash >= 0 ? body.slice(slash + 1) : "";
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const credentials = authority.slice(0, at);
    authority = authority.slice(at + 1);
    const colon = credentials.indexOf(":");
    const user = colon >= 0 ? credentials.slice(0, colon) : credentials;
    if (user) info.user = safeDecode(user);
    if (colon >= 0) info.password = true;
  }
  const hosts = authority.split(",").map((h) => h.trim()).filter(Boolean);
  const first = hosts[0] ?? "";
  const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(first) ?? /^([^:]*)(?::(\d+))?$/.exec(first);
  if (match) {
    if (match[1]) info.host = match[1];
    if (match[2]) info.port = Number(match[2]);
  }
  info.otherHosts = hosts.slice(1);
  return { path, query };
}

/** One "Parámetros extra" entry. */
const param = (key: string, value: string) => `${key}=${value}`;

/**
 * A JDBC URL of an engine Celer connects to, read in full: SQL Server (Microsoft and jTDS), Informix (informix-sqli,
 * and jdbc:ids over DRDA), PostgreSQL, MySQL, MariaDB and SQLite. null for anything else. The password is never
 * returned, only whether there was one.
 */
export function parseJdbc(url: string): JdbcInfo | null {
  const u = url.trim();
  const make = (kind: DbKind): JdbcInfo => ({ kind, password: false, ignored: [], otherHosts: [] });

  const sqlite = /^jdbc:sqlite:(.*)$/i.exec(u);
  if (sqlite) {
    const info = make("sqlite");
    let file = sqlite[1].trim().replace(/^file:/i, "");
    if (file.includes("?")) file = file.slice(0, file.indexOf("?"));
    info.file = !file || file.startsWith(":memory:") ? ":memory:" : file;
    return info;
  }

  const mssql = /^jdbc:sqlserver:\/\/([^;]*)(.*)$/i.exec(u);
  const jtds = /^jdbc:jtds:sqlserver:\/\/([^:/;\\]*)(?::(\d+))?(?:\/([^;]*))?(.*)$/i.exec(u);
  if (mssql || jtds) {
    const info = make("mssql");
    // server[\instance][:port]; the server can be a bracketed IPv6 address ([2001:db8::5]:1500) or a bare one.
    const setServer = (server: string): boolean => {
      const text = server.trim();
      if (/^[0-9a-f]*:[0-9a-f:.]*:[0-9a-f.]*$/i.test(text)) {
        info.host = text;
        return true;
      }
      const m = /^(\[[0-9a-f:.%a-z]+\]|[^:\\[\]]*)(?:\\([^:]+))?(?::(\d+))?$/i.exec(text);
      if (!m) return false;
      if (m[1]) info.host = m[1].replace(/^\[(.*)\]$/, "$1");
      if (m[2]) info.instance = m[2];
      if (m[3]) info.port = Number(m[3]);
      return true;
    };
    let props: [string, string][];
    if (mssql) {
      // A server part Celer cannot read is not taken for localhost: the URL is not understood.
      if (!setServer(mssql[1])) return null;
      props = splitProps(mssql[2], ";");
    } else {
      const j = jtds!;
      if (j[1]) info.host = j[1];
      if (j[2]) info.port = Number(j[2]);
      if (j[3]) info.database = j[3];
      props = splitProps(j[4], ";");
    }
    for (const [key, value] of props) {
      switch (key.toLowerCase()) {
        case "databasename":
        case "database":
          info.database = value;
          break;
        case "servername":
        case "server":
          if (!info.host) setServer(value);
          break;
        case "portnumber":
        case "port":
          if (/^\d+$/.test(value)) info.port = Number(value);
          break;
        case "instancename":
        case "instance":
          info.instance = value;
          break;
        case "user":
        case "username":
          info.user = value;
          break;
        case "password":
          info.password = true;
          break;
        case "encrypt":
          info.encryption = /^(true|yes|mandatory|strict)$/i.test(value) ? "required" : "login";
          break;
        case "ssl":
          info.encryption = /^(require|authenticate)$/i.test(value) ? "required" : /^request$/i.test(value) ? "login" : "off";
          break;
        case "trustservercertificate":
          info.trustCert = isTrue(value);
          break;
        case "integratedsecurity":
          info.integratedAuth = isTrue(value);
          break;
        case "authentication":
          if (/integrated/i.test(value)) info.integratedAuth = true;
          else info.ignored.push(key);
          break;
        default:
          info.ignored.push(key);
      }
    }
    return info;
  }

  const informix = /^jdbc:(informix-sqli|ids):\/\/([^:/;]+)(?::(\d+))?(?:\/([^:;]*))?(?:[:;](.*))?$/i.exec(u);
  if (informix) {
    const info = make("informix");
    const drda = informix[1].toLowerCase() === "ids";
    info.informixMode = drda ? "drda" : "auto";
    info.host = informix[2];
    if (informix[3]) info.port = Number(informix[3]);
    if (informix[4]) info.database = informix[4];
    const extra: string[] = [];
    for (const [key, value] of informixProps(informix[5] ?? "")) {
      const lower = key.toLowerCase();
      if (lower === "informixserver") info.instance = value;
      else if (lower === "user") info.user = value;
      else if (lower === "password") info.password = true;
      // The IBM CLI takes its own keywords, not the JDBC driver's properties.
      else if (drda) info.ignored.push(key);
      else extra.push(param(key, value));
    }
    if (extra.length) info.params = extra.join(";");
    return info;
  }

  const pg = /^jdbc:postgresql:(.*)$/i.exec(u);
  if (pg) {
    const info = make("postgres");
    const { path, query } = splitAuthorityUrl(info, pg[1]);
    if (path) info.database = safeDecode(path.replace(/\/$/, ""));
    const extra: string[] = [];
    for (const [key, value] of splitProps(query, "&")) {
      switch (key.toLowerCase()) {
        case "user":
          info.user = value;
          break;
        case "password":
          info.password = true;
          break;
        case "sslmode": {
          const mode = value.toLowerCase();
          info.encryption = mode === "disable" ? "off" : mode === "allow" || mode === "prefer" ? "login" : "required";
          if (mode.startsWith("verify")) info.trustCert = false;
          else if (mode === "require") info.trustCert = true;
          break;
        }
        case "ssl":
          if (!query.toLowerCase().includes("sslmode=")) info.encryption = isTrue(value) ? "required" : "off";
          break;
        case "currentschema":
          // libpq has no currentSchema: the same through the session's search_path.
          extra.push(param("options", `-c search_path=${value}`));
          break;
        case "applicationname":
          extra.push(param("application_name", value));
          break;
        case "connecttimeout":
        case "logintimeout":
          if (/^\d+$/.test(value)) extra.push(param("connect_timeout", value));
          break;
        default:
          info.ignored.push(key);
      }
    }
    if (extra.length) info.params = extra.join(";");
    return info;
  }

  const my = /^jdbc:(mysql|mariadb)(?:\+srv)?(?::[\w-]+)?:(\/\/.*)$/i.exec(u);
  if (my) {
    const info = make("mysql");
    const { path, query } = splitAuthorityUrl(info, my[2]);
    if (path) info.database = safeDecode(path.replace(/\/$/, ""));
    const extra: string[] = [];
    const ms = (value: string) => Math.max(1, Math.ceil(Number(value) / 1000));
    for (const [key, value] of splitProps(query, "&")) {
      switch (key.toLowerCase()) {
        case "user":
          info.user = value;
          break;
        case "password":
          info.password = true;
          break;
        case "usessl":
        case "requiressl":
          info.encryption = isTrue(value) ? "required" : "off";
          break;
        case "sslmode": {
          const mode = value.toLowerCase().replace(/_/g, "-");
          if (mode === "disabled" || mode === "disable") info.encryption = "off";
          else if (mode === "preferred") info.encryption = "login";
          else {
            info.encryption = "required";
            info.trustCert = mode === "required" || mode === "trust";
          }
          break;
        }
        case "verifyservercertificate":
          info.trustCert = !isTrue(value);
          break;
        case "trustservercertificate":
          info.trustCert = isTrue(value);
          break;
        case "connecttimeout":
          if (/^\d+$/.test(value)) extra.push(param("connect_timeout", String(ms(value))));
          break;
        case "sockettimeout":
          if (/^\d+$/.test(value)) extra.push(param("read_timeout", String(ms(value))));
          break;
        case "usecompression":
          extra.push(param("compress", isTrue(value) ? "true" : "false"));
          break;
        case "sessionvariables":
          // "a=1,b='x'": each one a session variable, as Celer's extra parameters do.
          for (const pair of value.split(",")) if (pair.includes("=")) extra.push(pair.trim());
          break;
        default:
          info.ignored.push(key);
      }
    }
    if (extra.length) info.params = extra.join(";");
    return info;
  }
  return null;
}

/** "informixserver=x;DB_LOCALE=es_ES.819" → [key, value] pairs (a value may hold "="). */
function informixProps(text: string): [string, string][] {
  return text
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => [part.slice(0, part.indexOf("=")).trim(), part.slice(part.indexOf("=") + 1).trim()] as [string, string])
    .filter(([key]) => key.length > 0);
}

function kindFor(source: string): DbKind | null {
  const s = source.toLowerCase();
  if (/postgres|greenplum|timescale/.test(s)) return "postgres";
  if (/mariadb|mysql/.test(s)) return "mysql";
  if (/sqlserver|sql server|mssql|jtds|azure sql/.test(s)) return "mssql";
  if (/sqlite/.test(s)) return "sqlite";
  if (/informix|jdbc:ids:/.test(s)) return "informix";
  if (/odbc/.test(s)) return "odbc";
  return null;
}

/** A value of a tool's configuration, or undefined when it is missing or empty (an empty field never wins). */
function given(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "object") return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/** The fields a tool keeps besides the URL (DBeaver's host/port/database/server, DbVisualizer's UrlVariables). */
interface SourceFields {
  host?: string;
  port?: string;
  database?: string;
  /** Informix: INFORMIXSERVER. SQL Server: the instance. */
  server?: string;
}

/** A URL for a connection the tool keeps only as fields (no URL, or one Celer cannot read). */
function urlFromFields(kind: DbKind, f: SourceFields): string {
  const host = f.host ?? "localhost";
  const port = f.port ? `:${f.port}` : "";
  switch (kind) {
    case "postgres":
      return `jdbc:postgresql://${host}${port}/${f.database ?? ""}`;
    case "mysql":
      return `jdbc:mysql://${host}${port}/${f.database ?? ""}`;
    case "mssql":
      return `jdbc:sqlserver://${host}${f.server ? `\\${f.server}` : ""}${port}${f.database ? `;databaseName=${f.database}` : ""}`;
    case "informix":
      return `jdbc:informix-sqli://${host}${port}/${f.database ?? ""}${f.server ? `:INFORMIXSERVER=${f.server}` : ""}`;
    case "sqlite":
      return `jdbc:sqlite:${f.database ?? ""}`;
    default:
      return "";
  }
}

/**
 * The driver properties of the tool (DBeaver's `properties`) added to the URL, so that the URL parser maps them as it
 * maps URL properties (encrypt, sslmode, currentSchema, INFORMIXSERVER, DB_LOCALE…). One the URL already has wins;
 * user and password are never taken.
 */
function withProperties(url: string, kind: DbKind, properties: Record<string, unknown> | undefined): string {
  const entries = Object.entries(properties ?? {})
    .map(([key, value]) => [key.trim(), given(value)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0]) && entry[1] !== undefined && !/^(user|password)$/i.test(entry[0]))
    .filter(([key]) => !new RegExp(`[?&;:]${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`, "i").test(url));
  if (!entries.length) return url;
  if (kind === "postgres" || kind === "mysql") {
    const query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
  }
  const props = entries.map(([key, value]) => `${key}=${value}`).join(";");
  if (kind === "informix") {
    // Informix properties start with ":" after the database (jdbc:informix-sqli://h:9088/db:INFORMIXSERVER=x;…).
    const existing = /^jdbc:(?:informix-sqli|ids):\/\/[^:/;]+(?::\d+)?(?:\/[^:;]*)?(?:[:;](.*))?$/i.exec(url)?.[1]?.trim();
    return existing ? `${url.replace(/;$/, "")};${props}` : `${url.replace(/[:;]$/, "")}:${props}`;
  }
  if (kind === "mssql") return `${url.replace(/;$/, "")};${props}`;
  return url;
}

/** The connection's settings from everything the URL says (parseJdbc), like «URL JDBC» in the connection form. */
function applyJdbcInfo(cfg: ConnConfig, info: JdbcInfo, notes: string[]) {
  if (info.kind === "sqlite") {
    cfg.filePath = info.file ?? ":memory:";
    cfg.host = "";
    cfg.database = "";
    return;
  }
  if (info.kind === "informix") cfg.informixMode = info.informixMode === "drda" ? "drda" : "auto";
  cfg.host = info.host ?? "localhost";
  cfg.instance = info.instance ?? "";
  cfg.database = info.database ?? "";
  const informixPort = cfg.informixMode === "drda" ? 9089 : 9088;
  cfg.port = info.port ?? (info.kind === "informix" ? informixPort : info.kind === "mssql" && cfg.instance ? null : cfg.port);
  if (info.kind === "mssql") cfg.integratedAuth = info.integratedAuth ?? false;
  if (info.encryption) cfg.encryption = info.encryption;
  if (info.trustCert !== undefined) cfg.trustCert = info.trustCert;
  cfg.extra = info.params ?? "";
  if (info.otherHosts.length) notes.push(`Celer conecta al primer servidor; no se usan: ${info.otherHosts.join(", ")}.`);
  if (info.ignored.length) notes.push(`Propiedades que Celer no usa: ${info.ignored.join(", ")}.`);
}

/**
 * One connection of a tool, read in full: its URL (with the driver properties) through parseJdbc, and the fields the
 * tool keeps beside it. The fields win when the tool says the connection is made of fields (`fieldsWin`, DBeaver's
 * MANUAL), the URL when it says it is made of a URL; an empty field never wins. Returns the engine Celer uses (null
 * when it is not one Celer connects to).
 */
function readConnection(cfg: ConnConfig, hint: DbKind | null, rawUrl: string, fields: SourceFields, properties: Record<string, unknown> | undefined, fieldsWin: boolean, notes: string[]): DbKind | null {
  const odbc = /^jdbc:odbc:(.+)$/i.exec(rawUrl.trim());
  if (odbc || (hint === "odbc" && !rawUrl.trim())) {
    const dsn = odbc?.[1].split(";")[0].trim() || fields.database || fields.host || "";
    Object.assign(cfg, { ...emptyConn("odbc"), host: "", name: cfg.name, folder: cfg.folder, user: cfg.user, production: cfg.production, readOnly: cfg.readOnly, odbcConnStr: dsn ? `DSN=${dsn}` : "" });
    return "odbc";
  }
  const parsedUrl = rawUrl.trim() ? parseJdbc(rawUrl) : null;
  const kind = parsedUrl?.kind ?? hint;
  if (!kind || kind === "odbc") return kind;
  const url = parsedUrl ? rawUrl.trim() : urlFromFields(kind, fields);
  const info = parseJdbc(withProperties(url, kind, properties)) ?? parseJdbc(url);
  if (!info) return null;
  if (fieldsWin || !parsedUrl) {
    if (kind === "sqlite") {
      if (fields.database) info.file = fields.database;
    } else {
      // "server\instance" in DBeaver's host field (SQL Server).
      const [host, instanceInHost] = (fields.host ?? "").split("\\");
      if (host) info.host = host;
      if (kind === "mssql" && instanceInHost) info.instance = instanceInHost;
      if (fields.port && /^\d+$/.test(fields.port)) info.port = Number(fields.port);
      if (fields.database) info.database = fields.database;
      if (fields.server) info.instance = fields.server;
    }
  } else if (kind !== "sqlite" && fields.server && !info.instance) {
    info.instance = fields.server;
  }
  // The tool's own user field wins over one in the URL; without either, the engine's usual one.
  const user = cfg.user || info.user || emptyConn(kind).user;
  Object.assign(cfg, { ...emptyConn(kind), name: cfg.name, folder: cfg.folder, user, production: cfg.production, readOnly: cfg.readOnly });
  applyJdbcInfo(cfg, info, notes);
  if (info.password) notes.push("La URL traía una contraseña: no se copia.");
  return kind;
}

function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * DBeaver's credentials-config.json: AES-128-CBC with DBeaver's fixed, publicly documented default key;
 * the first 16 bytes are the IV. Returns { "<connection id>": { "#connection": { user, password } } }.
 */
export async function decryptDbeaverCredentials(hex: string): Promise<Record<string, DbeaverCredentials>> {
  const data = hexToBytes(hex);
  if (data.length <= 16) return {};
  const key = await crypto.subtle.importKey("raw", hexToBytes("babb4a9f774ab853c96c2d653dfe544a"), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: data.slice(0, 16) }, key, data.slice(16));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** What DBeaver keeps for one connection in credentials-config.json. */
export interface DbeaverCredentials {
  "#connection"?: { user?: string; password?: string };
  /** The SSH tunnel's user and password (or key passphrase). */
  "network/ssh_tunnel"?: { user?: string; password?: string };
}

// ---------------------------------------------------------------- DBeaver

interface DbeaverConnection {
  provider?: string;
  driver?: string;
  name?: string;
  folder?: string;
  "read-only"?: boolean;
  "save-password"?: boolean;
  configuration?: Record<string, unknown> & {
    host?: string;
    port?: string | number;
    database?: string;
    url?: string;
    user?: string;
    type?: string;
    server?: string;
    /** MANUAL (made of fields; the URL is derived from them) or URL (typed as a URL). */
    configurationType?: string;
    "configuration-type"?: string;
    properties?: Record<string, unknown>;
    handlers?: Record<string, DbeaverHandler>;
  };
}

interface DbeaverHandler {
  type?: string;
  enabled?: boolean;
  "save-password"?: boolean;
  user?: string;
  properties?: Record<string, unknown>;
}

/** DBeaver's SSL handlers (postgre_ssl, mysql_ssl, ssl…), when they are on: the encryption they ask for. */
function dbeaverSsl(cfg: ConnConfig, handlers: Record<string, DbeaverHandler> | undefined) {
  for (const [id, handler] of Object.entries(handlers ?? {})) {
    if (!/ssl/i.test(id) || handler.enabled !== true || cfg.kind === "sqlite" || cfg.kind === "odbc") continue;
    const props = handler.properties ?? {};
    const mode = (given(props.sslMode) ?? given(props["ssl.mode"]) ?? "").toLowerCase();
    cfg.encryption = mode === "disable" || mode === "disabled" ? "off" : mode === "allow" || mode === "prefer" || mode === "preferred" ? "login" : "required";
    if (/^verify/.test(mode) || given(props.verifyServerCert) === "true") cfg.trustCert = false;
    else if (mode === "require" || mode === "required") cfg.trustCert = true;
  }
}

const SSH_ENGINES: DbKind[] = ["postgres", "mysql", "mssql", "informix"];

/** How a tool names the SSH login: Celer's "password" | "key" | "agent". */
function sshAuth(value: string | undefined): string {
  const v = (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (/publickey|privatekey|key|pubkey/.test(v)) return "key";
  if (/agent|pageant/.test(v)) return "agent";
  return "password";
}

/**
 * DBeaver's SSH tunnel (the ssh_tunnel handler), when it is on: bastion, port, user and how it logs in. The user and
 * the password of newer DBeaver versions are in its credentials file (applyDbeaverCredentials).
 */
function dbeaverSsh(cfg: ConnConfig, handlers: Record<string, DbeaverHandler> | undefined, notes: string[]) {
  const entry = Object.entries(handlers ?? {}).find(([id, handler]) => id === "ssh_tunnel" || (/ssh/i.test(id) && handler.type === "TUNNEL"));
  const handler = entry?.[1];
  if (!handler || handler.enabled !== true || !SSH_ENGINES.includes(cfg.kind)) return;
  const props = handler.properties ?? {};
  const port = Number(given(props.port) ?? 22);
  cfg.ssh = {
    ...emptySsh(),
    enabled: true,
    host: given(props.host) ?? "",
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    user: given(handler.user) ?? given(props.user) ?? "",
    auth: sshAuth(given(props.authType)),
    keyPath: given(props.keyPath) ?? "",
  };
  if (!cfg.ssh.user) notes.push("Túnel SSH: el usuario está en las credenciales de DBeaver (marca «Importar también las contraseñas guardadas») o escríbelo en la conexión.");
  if (Object.keys(props).some((key) => /^jump/i.test(key))) notes.push("Túnel SSH: los saltos (jump servers) de DBeaver no se importan; añádelos en «Túnel SSH».");
}

/** DBeaver's connections, without credentials: the user comes from the plain configuration if it is there. */
export function parseDbeaver(source: MigrationSource): Candidate[] {
  const doc = JSON.parse(source.text) as { connections?: Record<string, DbeaverConnection> };
  const out: Candidate[] = [];
  for (const [id, c] of Object.entries(doc.connections ?? {})) {
    const conf = c.configuration ?? {};
    const driver = [c.provider, c.driver].filter(Boolean).join(" / ");
    const url = given(conf.url) ?? "";
    const hint = kindFor(`${c.provider ?? ""} ${c.driver ?? ""} ${url}`);
    const cfg = emptyConn(hint ?? "postgres");
    cfg.name = c.name || id;
    cfg.folder = c.folder ? `DBeaver · ${c.folder}` : "DBeaver";
    cfg.user = given(conf.user) ?? "";
    cfg.production = conf.type === "prod";
    cfg.readOnly = Boolean(c["read-only"]);
    const notes: string[] = [];
    const type = (given(conf.configurationType) ?? given(conf["configuration-type"]) ?? "").toUpperCase();
    const fields = { host: given(conf.host), port: given(conf.port), database: given(conf.database), server: given(conf.server) };
    const kind = readConnection(cfg, hint, url, fields, conf.properties as Record<string, unknown> | undefined, type !== "URL", notes);
    if (kind) {
      dbeaverSsl(cfg, conf.handlers);
      dbeaverSsh(cfg, conf.handlers, notes);
    }
    out.push({ key: `dbeaver:${source.project}:${id}`, tool: "dbeaver", project: source.project, cfg, driver, status: kind ? "new" : "unsupported", reason: kind ? "" : `Driver no soportado (${c.provider ?? c.driver ?? "desconocido"})`, sourcePath: source.path, sourceId: id, savedPassword: Boolean(c["save-password"]), notes });
  }
  return out;
}

/**
 * The user and password DBeaver keeps for each connection (its credentials-config.json, hex-encoded, read only when
 * the user ticked «Importar también las contraseñas guardadas») applied to the candidates that came from that file.
 */
export async function applyDbeaverCredentials(candidates: Candidate[], sourcePath: string, hex: string): Promise<Candidate[]> {
  const creds = await decryptDbeaverCredentials(hex).catch(() => ({}) as Awaited<ReturnType<typeof decryptDbeaverCredentials>>);
  return candidates.map((c) => {
    const saved = c.tool === "dbeaver" && c.sourcePath === sourcePath ? creds[c.sourceId] : undefined;
    const cred = saved?.["#connection"];
    // The SSH tunnel's user and its password (or the key's passphrase, with a key).
    const tunnel = saved?.["network/ssh_tunnel"];
    if (!cred && !tunnel) return c;
    const cfg = { ...c.cfg };
    if (cred) Object.assign(cfg, { user: cred.user ?? c.cfg.user, password: cred.password ?? "" });
    if (tunnel && cfg.ssh?.enabled) {
      const secret = tunnel.password ?? "";
      cfg.ssh = { ...cfg.ssh, user: tunnel.user || cfg.ssh.user, ...(cfg.ssh.auth === "key" ? { passphrase: secret } : cfg.ssh.auth === "password" ? { password: secret } : {}) };
    }
    return { ...c, cfg };
  });
}

// ---------------------------------------------------------------- DbVisualizer

/** An element of dbvis.xml. */
export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
  parent: XmlNode | null;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * A small XML reader for dbvis.xml (elements, attributes, text, CDATA, comments): the same in the app and in the Node
 * checks, which have no DOMParser. Throws on a document that is not well formed.
 */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: "#document", attrs: {}, children: [], text: "", parent: null };
  const stack: XmlNode[] = [root];
  const bad = (why: string): never => {
    throw new Error(`dbvis.xml no es un XML válido (${why})`);
  };
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf("<", i);
    top.text += decodeEntities(lt < 0 ? src.slice(i) : src.slice(i, lt));
    if (lt < 0) break;
    const skipTo = (close: string, from: number) => {
      const end = src.indexOf(close, from);
      if (end < 0) bad(`falta «${close}»`);
      return end + close.length;
    };
    if (src.startsWith("<!--", lt)) {
      i = skipTo("-->", lt + 4);
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = skipTo("]]>", lt + 9);
      top.text += src.slice(lt + 9, end - 3);
      i = end;
      continue;
    }
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      i = skipTo(">", lt + 2);
      continue;
    }
    // The end of the tag, past quoted attribute values.
    let end = lt + 1;
    let quote = "";
    while (end < src.length && (quote || src[end] !== ">")) {
      if (quote && src[end] === quote) quote = "";
      else if (!quote && (src[end] === '"' || src[end] === "'")) quote = src[end];
      end++;
    }
    if (end >= src.length) bad("etiqueta sin cerrar");
    const body = src.slice(lt + 1, end).trim();
    i = end + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      if (stack.length < 2 || top.tag !== name) bad(`</${name}> no cierra <${top.tag}>`);
      stack.pop();
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const name = /^[^\s/>]+/.exec(inner)?.[0];
    if (!name) bad("etiqueta vacía");
    const node: XmlNode = { tag: name!, attrs: {}, children: [], text: "", parent: top };
    for (const a of inner.slice(name!.length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) bad(`<${stack[stack.length - 1].tag}> sin cerrar`);
  if (!root.children.length) bad("vacío");
  return root;
}

/** Direct children named `tag` (case-insensitive, as DbVisualizer versions differ in case). */
const kids = (node: XmlNode | undefined, tag: string) => (node?.children ?? []).filter((c) => c.tag.toLowerCase() === tag.toLowerCase());
const kid = (node: XmlNode | undefined, tag: string) => kids(node, tag)[0];
const textOf = (node: XmlNode | undefined, tag: string) => kid(node, tag)?.text.trim() ?? "";

/** Every element named `tag` below `node`, in document order. */
function descendants(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.tag === tag) out.push(child);
    descendants(child, tag, out);
  }
  return out;
}

/**
 * DbVisualizer's SSH tunnel: the Ssh* elements of the database (SshEnabled, SshHost, SshPort, SshUserid,
 * SshPrivateKeyFile, SshAuthenticationType, also inside <SshSettings>), or the SSH servers it refers to by id
 * (<SshServerIds>a,b</SshServerIds> or <SshServerId> elements, defined in <SshServers>): the last one is the SSH
 * server, the ones before it are crossed first.
 */
function dbvisSsh(cfg: ConnConfig, db: XmlNode, doc: XmlNode, notes: string[]) {
  if (!SSH_ENGINES.includes(cfg.kind)) return;
  const own = (tag: string) => textOf(db, tag) || textOf(kid(db, "SshSettings"), tag);
  const portOf = (text: string) => (/^\d+$/.test(text) && Number(text) > 0 && Number(text) < 65536 ? Number(text) : 22);
  if (/^true$/i.test(own("SshEnabled"))) {
    const keyPath = own("SshPrivateKeyFile");
    cfg.ssh = { ...emptySsh(), enabled: true, host: own("SshHost"), port: portOf(own("SshPort")), user: own("SshUserid") || own("SshUser"), auth: keyPath ? "key" : sshAuth(own("SshAuthenticationType")), keyPath };
    return;
  }
  const ids = [...own("SshServerIds").split(/[,;\s]+/), ...kids(db, "SshServerId").map((n) => n.text.trim())].filter(Boolean);
  if (!ids.length) return;
  const servers = descendants(doc, "SshServer");
  const chain = ids.map((id) => servers.find((s) => (s.attrs.id ?? textOf(s, "Id")) === id));
  if (chain.some((s) => !s)) {
    notes.push("Túnel SSH: dbvis.xml nombra un servidor SSH que no define; revisa «Túnel SSH».");
  }
  const found = chain.filter((s): s is XmlNode => Boolean(s) && !/^false$/i.test(textOf(s, "Enabled")));
  if (!found.length) return;
  const server = (s: XmlNode) => {
    const keyPath = textOf(s, "PrivateKeyFile");
    return { host: textOf(s, "Host"), port: portOf(textOf(s, "Port")), user: textOf(s, "Userid") || textOf(s, "User"), auth: keyPath ? "key" : sshAuth(textOf(s, "AuthenticationType")), keyPath };
  };
  const last = server(found[found.length - 1]);
  const jumps = found.slice(0, -1).map(server).map((s) => `${s.user ? `${s.user}@` : ""}${s.host.includes(":") ? `[${s.host}]` : s.host}:${s.port}`);
  cfg.ssh = { ...emptySsh(), enabled: true, ...last, jumps };
}

export function parseDbVisualizer(source: MigrationSource): Candidate[] {
  const doc = parseXml(source.text);
  const out: Candidate[] = [];
  descendants(doc, "Database").forEach((db, index) => {
    const alias = textOf(db, "Alias") || `Conexión ${index + 1}`;
    const url = textOf(db, "Url");
    const urlVariables = kid(db, "UrlVariables");
    const driverName = textOf(db, "Driver") || textOf(urlVariables, "Driver");
    const vars: Record<string, string> = {};
    for (const v of kids(urlVariables, "UrlVariable")) vars[(v.attrs.UrlVariableName ?? "").toLowerCase()] = v.text.trim();
    // Driver properties: <Properties><Property key="…">value</Property></Properties> (DbVisualizer's own: dbvis.*).
    const properties: Record<string, string> = {};
    for (const p of kids(kid(db, "Properties"), "Property")) {
      const key = p.attrs.key ?? p.attrs.name ?? "";
      if (key && !key.startsWith("dbvis.")) properties[key] = p.text.trim();
    }
    const hint = kindFor(`${driverName} ${url}`);
    const cfg = emptyConn(hint ?? "postgres");
    cfg.name = alias;
    // Folders are nested <Folder name="…"> (or <Name>) elements around the database.
    const folders: string[] = [];
    for (let p = db.parent; p; p = p.parent) {
      if (p.tag === "Folder") folders.unshift(p.attrs.name ?? textOf(p, "Name"));
    }
    cfg.folder = ["DbVisualizer", ...folders.filter(Boolean)].join(" · ");
    cfg.user = textOf(db, "Userid");
    cfg.password = ""; // DbVisualizer passwords are not imported: Celer asks on first connect.
    const notes: string[] = [];
    // With variables (the "Server Info" mode) DbVisualizer builds the URL from them: they win when not empty.
    const fields = { host: given(vars.server), port: given(vars.port), database: given(vars.database), server: given(vars.informixserver ?? vars["informix server"] ?? vars.servername ?? vars.instance) };
    const fieldsWin = Object.values(fields).some(Boolean);
    const kind = readConnection(cfg, hint, url, fields, properties, fieldsWin, notes);
    if (kind) dbvisSsh(cfg, db, doc, notes);
    const id = db.attrs.id ?? String(index);
    out.push({ key: `dbvis:${id}`, tool: "dbvisualizer", project: source.project, cfg, driver: driverName, status: kind ? "new" : "unsupported", reason: kind ? "" : `Driver no soportado (${driverName || "desconocido"})`, sourcePath: source.path, sourceId: id, savedPassword: false, notes });
  });
  return out;
}
