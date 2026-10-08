// Parsers for the migration assistant: DBeaver data-sources.json (+ encrypted credentials-config.json) and
// DbVisualizer dbvis.xml → Celer connection configs. Pure functions (no store, no IPC) so they can be tested.
import { emptyConn, type ConnConfig, type DbKind } from "./types.ts";

export interface MigrationSource {
  tool: "dbeaver" | "dbvisualizer";
  project: string;
  path: string;
  text: string;
  credentialsHex?: string | null;
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
}

const TOOL_LABEL = { dbeaver: "DBeaver", dbvisualizer: "DbVisualizer" } as const;
export const toolLabel = (tool: MigrationSource["tool"]) => TOOL_LABEL[tool];

// ---------------------------------------------------------------- shared helpers

/**
 * host, port, database from a JDBC URL (jdbc:postgresql://h:p/db, jdbc:sqlserver://h:p;databaseName=db, jdbc:sqlite:path).
 * Informix (jdbc:informix-sqli://h:p/db:informixserver=x;prop=v…): the server name, and the other properties as
 * Celer's "Parámetros extra" (`params`; user and password are not taken from the URL).
 */
export function parseJdbcUrl(url: string): { host?: string; port?: number; database?: string; file?: string; instance?: string; params?: string } {
  const u = url.trim();
  const sqlite = /^jdbc:sqlite:(.+)$/i.exec(u);
  if (sqlite) return { file: sqlite[1] };
  const mssql = /^jdbc:(?:sqlserver|jtds:sqlserver):\/\/([^:;/\\]+)(?:\\([^:;/]+))?(?::(\d+))?(?:\/([^;]+))?(.*)$/i.exec(u);
  if (mssql) {
    const db = /(?:^|;)\s*database(?:Name)?=([^;]+)/i.exec(mssql[5] ?? "")?.[1] ?? mssql[4];
    return { host: mssql[1], instance: mssql[2], port: mssql[3] ? Number(mssql[3]) : undefined, database: db };
  }
  const informix = /^jdbc:informix-sqli:\/\/([^:/]+):(\d+)(?:\/([^:;]*))?(?:[:;](.*))?$/i.exec(u);
  if (informix) {
    const props = informixProps(informix[4] ?? "");
    const server = props.find(([key]) => key.toLowerCase() === "informixserver")?.[1];
    const params = props.filter(([key]) => !["informixserver", "user", "password"].includes(key.toLowerCase())).map(([key, value]) => `${key}=${value}`).join(";");
    return { host: informix[1], port: Number(informix[2]), database: informix[3] || undefined, instance: server, params: params || undefined };
  }
  const generic = /^jdbc:[\w-]+(?::[\w-]+)?:\/\/([^:/?;]+)(?::(\d+))?(?:\/([^?;]*))?/i.exec(u);
  if (generic) return { host: generic[1], port: generic[2] ? Number(generic[2]) : undefined, database: generic[3] || undefined };
  return {};
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
    const setServer = (server: string) => {
      const m = /^([^:\\]*)(?:\\([^:]+))?(?::(\d+))?$/.exec(server.trim());
      if (!m) return;
      if (m[1]) info.host = m[1];
      if (m[2]) info.instance = m[2];
      if (m[3]) info.port = Number(m[3]);
    };
    let props: [string, string][];
    if (mssql) {
      setServer(mssql[1]);
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

/** Informix: the server name and extra parameters from the URL (and DBeaver's driver properties); "Automático". */
function applyInformix(cfg: ConnConfig, fromUrl: ReturnType<typeof parseJdbcUrl>, server: string | undefined, properties?: Record<string, unknown>) {
  cfg.informixMode = "auto";
  cfg.instance = fromUrl.instance || server || cfg.instance;
  const extra = informixProps(fromUrl.params ?? "");
  const skip = new Set(["user", "password", "informixserver", ...extra.map(([key]) => key.toLowerCase())]);
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (skip.has(key.toLowerCase()) || value === null || typeof value === "object") continue;
    extra.push([key, String(value)]);
  }
  cfg.extra = extra.map(([key, value]) => `${key}=${value}`).join(";");
}

function kindFor(source: string): DbKind | null {
  const s = source.toLowerCase();
  if (/postgres|greenplum|timescale/.test(s)) return "postgres";
  if (/mariadb|mysql/.test(s)) return "mysql";
  if (/sqlserver|sql server|mssql|jtds|azure sql/.test(s)) return "mssql";
  if (/sqlite/.test(s)) return "sqlite";
  if (/informix/.test(s)) return "informix";
  if (/odbc/.test(s)) return "odbc";
  return null;
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
async function decryptDbeaverCredentials(hex: string): Promise<Record<string, { "#connection"?: { user?: string; password?: string } }>> {
  const data = hexToBytes(hex);
  if (data.length <= 16) return {};
  const key = await crypto.subtle.importKey("raw", hexToBytes("babb4a9f774ab853c96c2d653dfe544a"), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: data.slice(0, 16) }, key, data.slice(16));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------------------------------------------------------- DBeaver

interface DbeaverConnection {
  provider?: string;
  driver?: string;
  name?: string;
  folder?: string;
  "read-only"?: boolean;
  "save-password"?: boolean;
  configuration?: Record<string, unknown> & { host?: string; port?: string | number; database?: string; url?: string; user?: string; type?: string; server?: string };
}

export async function parseDbeaver(source: MigrationSource): Promise<Candidate[]> {
  const doc = JSON.parse(source.text) as { connections?: Record<string, DbeaverConnection> };
  let creds: Awaited<ReturnType<typeof decryptDbeaverCredentials>> = {};
  if (source.credentialsHex) creds = await decryptDbeaverCredentials(source.credentialsHex).catch(() => ({}));
  const out: Candidate[] = [];
  for (const [id, c] of Object.entries(doc.connections ?? {})) {
    const conf = c.configuration ?? {};
    const driver = [c.provider, c.driver].filter(Boolean).join(" / ");
    const kind = kindFor(`${c.provider ?? ""} ${c.driver ?? ""} ${conf.url ?? ""}`);
    const fromUrl = parseJdbcUrl(String(conf.url ?? ""));
    const cfg = emptyConn(kind ?? "postgres");
    cfg.name = c.name || id;
    cfg.folder = c.folder ? `DBeaver · ${c.folder}` : "DBeaver";
    cfg.host = String(conf.host ?? fromUrl.host ?? cfg.host);
    cfg.port = Number(conf.port ?? fromUrl.port ?? cfg.port) || cfg.port;
    cfg.database = String(conf.database ?? fromUrl.database ?? "");
    cfg.instance = fromUrl.instance ?? "";
    const cred = creds[id]?.["#connection"];
    cfg.user = String(cred?.user ?? conf.user ?? cfg.user);
    cfg.password = cred?.password ?? "";
    cfg.production = conf.type === "prod";
    cfg.readOnly = Boolean(c["read-only"]);
    if (kind === "sqlite") {
      cfg.filePath = String(conf.database ?? fromUrl.file ?? "");
      cfg.host = "";
      cfg.database = "";
    }
    if (kind === "mssql" && cfg.host.includes("\\")) [cfg.host, cfg.instance] = cfg.host.split("\\");
    if (kind === "informix") applyInformix(cfg, fromUrl, conf.server, conf.properties as Record<string, unknown> | undefined);
    out.push({ key: `dbeaver:${source.project}:${id}`, tool: "dbeaver", project: source.project, cfg, driver, status: kind ? "new" : "unsupported", reason: kind ? "" : `Driver no soportado (${c.provider ?? c.driver ?? "desconocido"})` });
  }
  return out;
}

// ---------------------------------------------------------------- DbVisualizer

export function parseDbVisualizer(source: MigrationSource): Candidate[] {
  const xml = new DOMParser().parseFromString(source.text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("dbvis.xml no es un XML válido");
  const text = (el: Element | null | undefined, sel: string) => el?.querySelector(`:scope > ${sel}`)?.textContent?.trim() ?? "";
  const out: Candidate[] = [];
  xml.querySelectorAll("Database").forEach((db, index) => {
    const alias = text(db, "Alias") || `Conexión ${index + 1}`;
    const url = text(db, "Url");
    const driverName = text(db, "Driver") || db.querySelector("UrlVariables > Driver")?.textContent?.trim() || "";
    const vars: Record<string, string> = {};
    db.querySelectorAll("UrlVariables > UrlVariable").forEach((v) => (vars[(v.getAttribute("UrlVariableName") ?? "").toLowerCase()] = v.textContent?.trim() ?? ""));
    const kind = kindFor(`${driverName} ${url}`);
    const fromUrl = parseJdbcUrl(url);
    const cfg = emptyConn(kind ?? "postgres");
    cfg.name = alias;
    // Folders are nested <Folder name="…"> (or <Name>) elements around the database.
    const folders: string[] = [];
    for (let p = db.parentElement; p; p = p.parentElement) {
      if (p.tagName === "Folder") folders.unshift(p.getAttribute("name") ?? text(p, "Name") ?? "");
    }
    cfg.folder = ["DbVisualizer", ...folders.filter(Boolean)].join(" · ");
    cfg.host = vars.server || fromUrl.host || cfg.host;
    cfg.port = Number(vars.port || fromUrl.port || cfg.port) || cfg.port;
    cfg.database = vars.database || fromUrl.database || "";
    cfg.instance = vars.instance || fromUrl.instance || "";
    cfg.user = text(db, "Userid") || cfg.user;
    cfg.password = ""; // DbVisualizer passwords are not imported: Celer asks on first connect.
    if (kind === "sqlite") {
      cfg.filePath = vars.database || fromUrl.file || "";
      cfg.host = "";
      cfg.database = "";
    }
    if (kind === "informix") applyInformix(cfg, fromUrl, vars.informixserver || vars["informix server"] || vars.servername);
    out.push({ key: `dbvis:${db.getAttribute("id") ?? index}`, tool: "dbvisualizer", project: source.project, cfg, driver: driverName, status: kind ? "new" : "unsupported", reason: kind ? "" : `Driver no soportado (${driverName || "desconocido"})` });
  });
  return out;
}

