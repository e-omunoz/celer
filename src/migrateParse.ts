// Parsers for the migration assistant: DBeaver data-sources.json (+ encrypted credentials-config.json) and
// DbVisualizer dbvis.xml → Celer connection configs. Pure functions (no store, no IPC) so they can be tested.
import { emptyConn, type ConnConfig, type DbKind } from "./types";

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

/** host, port, database from a JDBC URL (jdbc:postgresql://h:p/db, jdbc:sqlserver://h:p;databaseName=db, jdbc:sqlite:path). */
export function parseJdbcUrl(url: string): { host?: string; port?: number; database?: string; file?: string; instance?: string } {
  const u = url.trim();
  const sqlite = /^jdbc:sqlite:(.+)$/i.exec(u);
  if (sqlite) return { file: sqlite[1] };
  const mssql = /^jdbc:(?:sqlserver|jtds:sqlserver):\/\/([^:;/\\]+)(?:\\([^:;/]+))?(?::(\d+))?(?:\/([^;]+))?(.*)$/i.exec(u);
  if (mssql) {
    const db = /databaseName=([^;]+)/i.exec(mssql[5] ?? "")?.[1] ?? mssql[4];
    return { host: mssql[1], instance: mssql[2], port: mssql[3] ? Number(mssql[3]) : undefined, database: db };
  }
  const informix = /^jdbc:informix-sqli:\/\/([^:/]+):(\d+)\/([^:;]+)/i.exec(u);
  if (informix) return { host: informix[1], port: Number(informix[2]), database: informix[3] };
  const generic = /^jdbc:[\w-]+(?::[\w-]+)?:\/\/([^:/?;]+)(?::(\d+))?(?:\/([^?;]*))?/i.exec(u);
  if (generic) return { host: generic[1], port: generic[2] ? Number(generic[2]) : undefined, database: generic[3] || undefined };
  return {};
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
    out.push({ key: `dbvis:${db.getAttribute("id") ?? index}`, tool: "dbvisualizer", project: source.project, cfg, driver: driverName, status: kind ? "new" : "unsupported", reason: kind ? "" : `Driver no soportado (${driverName || "desconocido"})` });
  });
  return out;
}

