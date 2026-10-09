// Lógica pura del explorador de conexiones: carpetas anidadas ("Clientes/Egarsat"), orden, búsqueda y filtros, y el
// formato portable para exportar e importar conexiones (sin contraseñas, o con ellas en un bloque que sella el núcleo). Sin solid-js ni efectos, para poder probarla
// con node (dev/explorer-check.ts).
import { emptyConn, ENGINES, type ConnConfig, type DbKind, type SshConfig } from "./types.ts";

/** Separador de niveles de carpeta en `ConnConfig.folder`. Las carpetas antiguas con " · " son nombres planos. */
export const FOLDER_SEP = "/";

export function folderParts(folder: string): string[] {
  return (folder ?? "")
    .split(FOLDER_SEP)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** "  a / b/ " → "a/b". */
export function normalizeFolder(folder: string): string {
  return folderParts(folder).join(FOLDER_SEP);
}

export function joinFolder(parent: string, name: string): string {
  return [...folderParts(parent), ...folderParts(name)].join(FOLDER_SEP);
}

export function parentFolder(folder: string): string {
  return folderParts(folder).slice(0, -1).join(FOLDER_SEP);
}

export function folderName(folder: string): string {
  const parts = folderParts(folder);
  return parts[parts.length - 1] ?? "";
}

/** `folder` es `ancestor` o está dentro de ella. */
export function isInside(folder: string, ancestor: string): boolean {
  const f = normalizeFolder(folder);
  const a = normalizeFolder(ancestor);
  if (!a) return true;
  return f === a || f.startsWith(a + FOLDER_SEP);
}

/** La carpeta `folder` después de renombrar (o mover) `from` a `to`; igual si no está dentro de `from`. */
export function renameFolderPath(folder: string, from: string, to: string): string {
  const f = normalizeFolder(folder);
  const a = normalizeFolder(from);
  if (!a || !isInside(f, a)) return f;
  return joinFolder(to, f.slice(a.length));
}

/** A folder path after a set of moves (`[from, to]`, none inside another): the first move that contains it applies. */
export function movedFolderPath(folder: string, moves: [string, string][]): string {
  const f = normalizeFolder(folder);
  const move = moves.find(([from]) => isInside(f, from));
  return move ? renameFolderPath(f, move[0], move[1]) : f;
}

export interface MovePlan {
  /** Folders that move, `[from, to]`: only the outermost ones (a folder inside another moved one goes with it). */
  moves: [string, string][];
  /** The new folder of every connection that changes folder. */
  folderOf: Map<string, string>;
  /** Selected folders that cannot go there: the target itself or one of its ancestors. */
  blocked: string[];
}

/**
 * Moving several connections (`ids`) and folders into `target` at once (a multi-selection dragged or moved from the
 * menu). Each folder goes inside the target with its contents; a selected connection that is inside a moved folder
 * travels with that folder instead of being taken out of it.
 */
export function planMove(conns: { id: string; folder: string }[], ids: string[], folders: string[], target: string): MovePlan {
  const to = normalizeFolder(target);
  const selected = [...new Set(folders.map(normalizeFolder).filter(Boolean))];
  const blocked = selected.filter((folder) => isInside(to, folder));
  const movable = selected.filter((folder) => !blocked.includes(folder));
  const outer = movable.filter((folder) => !movable.some((other) => other !== folder && isInside(folder, other)));
  const moves = outer.map((folder): [string, string] => [folder, joinFolder(to, folderName(folder))]).filter(([from, dest]) => from !== dest);
  const folderOf = new Map<string, string>();
  for (const conn of conns) {
    const now = normalizeFolder(conn.folder);
    const carried = outer.some((folder) => isInside(now, folder));
    const next = carried ? movedFolderPath(now, moves) : ids.includes(conn.id) ? to : now;
    if (next !== now) folderOf.set(conn.id, next);
  }
  return { moves, folderOf, blocked };
}

/** The connection order with `moving` (in their current order) right before `beforeId`; unchanged if it is one of them. */
export function placeBefore(order: string[], moving: string[], beforeId: string): string[] {
  const set = new Set(moving);
  const rest = order.filter((id) => !set.has(id));
  const at = rest.indexOf(beforeId);
  if (at < 0) return order.slice();
  return [...rest.slice(0, at), ...order.filter((id) => set.has(id)), ...rest.slice(at)];
}

/** A folder path once the `deleted` folders are gone: what was inside each one goes up a level (deepest first). */
export function liftDeleted(folder: string, deleted: string[]): string {
  const ordered = [...new Set(deleted.map(normalizeFolder).filter(Boolean))].sort((a, b) => folderParts(b).length - folderParts(a).length);
  return ordered.reduce((path, gone) => renameFolderPath(path, gone, parentFolder(gone)), normalizeFolder(folder));
}

/** Todas las carpetas (con sus antepasadas), en orden de aparición: primero las de las conexiones, luego las creadas. */
export function allFolders(connFolders: string[], explicit: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...connFolders, ...explicit]) {
    const parts = folderParts(raw);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join(FOLDER_SEP);
      if (!seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}

/** Un nombre que no esté en `taken` (sin distinguir mayúsculas): «Nueva carpeta», «Nueva carpeta 2»… */
export function uniqueName(base: string, taken: string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

// ---------------------------------------------------------------- orden y árbol

export type ConnSort = "manual" | "alpha";

interface Named {
  id: string;
  name: string;
  folder: string;
}

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/** Manual: el orden guardado. Alfabético: por nombre, sin distinguir mayúsculas ni acentos, números en su orden. */
export function sortConns<T extends Named>(conns: T[], mode: ConnSort): T[] {
  if (mode !== "alpha") return conns.slice();
  return conns.slice().sort((a, b) => collator.compare(a.name, b.name));
}

export interface FolderNode<T> {
  /** Ruta completa ("" en la raíz). */
  path: string;
  name: string;
  folders: FolderNode<T>[];
  conns: T[];
}

/**
 * El árbol de carpetas con sus conexiones. Las carpetas siguen el orden de aparición (manual) o el alfabético; las
 * conexiones, `sortConns`. `explicit` son las carpetas creadas por el usuario, que se muestran aunque estén vacías.
 */
export function buildConnTree<T extends Named>(conns: T[], explicit: string[], mode: ConnSort): FolderNode<T> {
  const root: FolderNode<T> = { path: "", name: "", folders: [], conns: [] };
  const index = new Map<string, FolderNode<T>>([["", root]]);
  const paths = allFolders(
    conns.map((conn) => conn.folder),
    explicit,
  );
  const ordered = mode === "alpha" ? paths.slice().sort((a, b) => collator.compare(a, b)) : paths;
  for (const path of ordered) {
    // Los antepasados ya están (allFolders los pone antes; el orden alfabético también los deja antes).
    const node: FolderNode<T> = { path, name: folderName(path), folders: [], conns: [] };
    index.set(path, node);
  }
  for (const path of ordered) {
    const parent = index.get(parentFolder(path)) ?? root;
    parent.folders.push(index.get(path)!);
  }
  if (mode === "alpha") {
    const sortDeep = (node: FolderNode<T>) => {
      node.folders.sort((a, b) => collator.compare(a.name, b.name));
      node.folders.forEach(sortDeep);
    };
    sortDeep(root);
  }
  for (const conn of sortConns(conns, mode)) (index.get(normalizeFolder(conn.folder)) ?? root).conns.push(conn);
  return root;
}

/** Cuántas conexiones hay en una carpeta y sus subcarpetas. */
export function countConns<T>(node: FolderNode<T>): number {
  return node.conns.length + node.folders.reduce((sum, child) => sum + countConns(child), 0);
}

// ---------------------------------------------------------------- búsqueda y filtros

/** Otros nombres con los que se busca cada motor («pg», «sqlserver», «ifx»…). */
const KIND_ALIASES: Record<DbKind, string[]> = {
  postgres: ["postgres", "postgresql", "pg", "psql"],
  mysql: ["mysql", "mariadb", "maria"],
  mssql: ["mssql", "sqlserver", "sql server", "sql-server", "azure", "tds"],
  sqlite: ["sqlite", "sqlite3"],
  informix: ["informix", "ifx"],
  odbc: ["odbc", "dsn"],
};

export interface SearchableConn {
  name: string;
  kind: DbKind;
  host: string;
  port: number | null;
  database: string;
  user: string;
  folder: string;
  filePath: string;
  instance: string;
}

function haystack(conn: SearchableConn): string {
  const engine = ENGINES.find((e) => e.kind === conn.kind)?.label ?? "";
  return [conn.name, conn.host, conn.port ? String(conn.port) : "", conn.database, conn.user, conn.folder, conn.filePath, conn.instance, engine, ...(KIND_ALIASES[conn.kind] ?? [])]
    .join("\n")
    .toLowerCase();
}

/**
 * La conexión cumple la búsqueda: cada palabra tiene que aparecer en el nombre, servidor, puerto, base, usuario,
 * carpeta, fichero, instancia o motor. Vacía: todas.
 */
export function connMatches(conn: SearchableConn, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = haystack(conn);
  return words.every((word) => text.includes(word));
}

export interface QuickFilter {
  favorites: boolean;
  connected: boolean;
  production: boolean;
  kinds: DbKind[];
}

export const NO_FILTER: QuickFilter = { favorites: false, connected: false, production: false, kinds: [] };

export function filterActive(filter: QuickFilter): boolean {
  return filter.favorites || filter.connected || filter.production || filter.kinds.length > 0;
}

/** Los filtros rápidos (se suman: favorita Y conectada Y…; los motores, cualquiera de los elegidos). */
export function passesFilter(conn: { id: string; kind: DbKind; production: boolean }, filter: QuickFilter, favorites: string[], connected: (id: string) => boolean): boolean {
  if (filter.favorites && !favorites.includes(conn.id)) return false;
  if (filter.connected && !connected(conn.id)) return false;
  if (filter.production && !conn.production) return false;
  if (filter.kinds.length && !filter.kinds.includes(conn.kind)) return false;
  return true;
}

// ---------------------------------------------------------------- favoritas y recientes

export interface RecentConn {
  id: string;
  at: number;
}

export const RECENT_MAX = 8;

/** La conexión pasa a la cabeza de las recientes (sin repetirse, como mucho RECENT_MAX). */
export function pushRecent(list: RecentConn[], id: string, at: number, max = RECENT_MAX): RecentConn[] {
  return [{ id, at }, ...list.filter((item) => item.id !== id)].slice(0, max);
}

export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/** Los ids de `order` con `id` puesto en la posición `at` (para devolver una conexión a su sitio al deshacer). */
export function insertAt(order: string[], id: string, at: number): string[] {
  const rest = order.filter((item) => item !== id);
  const pos = Math.max(0, Math.min(at < 0 ? rest.length : at, rest.length));
  return [...rest.slice(0, pos), id, ...rest.slice(pos)];
}

// ---------------------------------------------------------------- exportar e importar

export const EXPORT_FORMAT = "celer-connections";
/** Without passwords: the format as it has always been. */
export const EXPORT_VERSION = 1;
/** With «Incluir contraseñas»: v1 plus a `secrets` block, sealed by the core (src-tauri/src/secrets.rs). */
export const EXPORT_VERSION_SECRETS = 2;

/** Campos de una conexión que viajan en el fichero: todo menos el id y la contraseña. */
const PORTABLE_KEYS = Object.keys(emptyConn("postgres")).filter((key) => key !== "id" && key !== "password") as (keyof ConnConfig)[];

const INLINE_PASSWORD = /(?<=^|[;\n])[ \t]*(?:pwd|password)[ \t]*=[ \t]*(\{(?:[^}]|\}\})*\}|[^;\n]*)[ \t]*(?:[;\n]|$)/gi;

/** A `key=value;…` list (ODBC string, "Parámetros extra") without its `PWD=` / `Password=` entries. */
export function withoutInlinePassword(text: string): string {
  return text.replace(INLINE_PASSWORD, "");
}

/** The last `PWD=` / `Password=` value of a `key=value;…` list ({…} unwrapped), or null. */
export function inlinePassword(text: string): string | null {
  let found: string | null = null;
  for (const m of text.matchAll(INLINE_PASSWORD)) {
    const raw = m[1].trim();
    found = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1).replace(/\}\}/g, "}") : raw;
  }
  return found;
}

/** The settings of an SSH tunnel that travel in a file (no password, passphrase or key); null without a tunnel. */
export function portableSsh(ssh: SshConfig | undefined | null): SshConfig | null {
  if (!ssh || (!ssh.enabled && !ssh.host)) return null;
  return { enabled: Boolean(ssh.enabled), host: ssh.host ?? "", port: ssh.port ?? 22, user: ssh.user ?? "", auth: ssh.auth || "password", keyPath: ssh.keyPath ?? "", jumps: [...(ssh.jumps ?? [])] };
}

/** An SSH block read from a file, checked field by field; null when it is not one. */
function readSsh(raw: unknown): SshConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const port = typeof r.port === "number" && Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : 22;
  const auth = ["password", "key", "agent"].includes(str(r.auth)) ? str(r.auth) : "password";
  const jumps = Array.isArray(r.jumps) ? r.jumps.filter((j): j is string => typeof j === "string") : [];
  return portableSsh({ enabled: r.enabled === true, host: str(r.host), port, user: str(r.user), auth, keyPath: str(r.keyPath), jumps });
}

/** Las conexiones (sin id ni contraseña) y las carpetas, como JSON legible. */
export function exportConnectionsJson(conns: ConnConfig[], folders: string[], exportedAt: Date): string {
  const connections = conns.map((conn) => {
    const out: Record<string, unknown> = {};
    for (const key of PORTABLE_KEYS) {
      const value = conn[key];
      if (value !== undefined) out[key] = key === "odbcConnStr" || key === "extra" ? withoutInlinePassword(String(value)) : value;
    }
    if (conn.startupSql) out.startupSql = conn.startupSql;
    // The SSH tunnel's settings, never its secrets (only for connections that have one).
    const ssh = portableSsh(conn.ssh);
    if (ssh) out.ssh = ssh;
    return out;
  });
  const used = allFolders(
    conns.map((conn) => conn.folder),
    folders,
  );
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: exportedAt.toISOString(), folders: used, connections }, null, 2);
}

/** Keys of a `key=value;…` entry that holds a secret (PWD= and Password= are the connection's password instead). */
const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api_?key|private_?key)$/i;
const PARAM_ENTRY = /(?<=^|[;\n])[ \t]*([^=;\n]*?)[ \t]*=[ \t]*(\{(?:[^}]|\}\})*\}|[^;\n]*)[ \t]*(?:[;\n]|$)/g;

/**
 * A `key=value;…` list (ODBC string, "Parámetros extra") split into the entries that hold a secret (sslpassword=,
 * token=…) and the rest as written. PWD= and Password= are left alone: they are the connection's password.
 */
export function splitSecretParams(text: string): { kept: string; secret: string } {
  const secret: string[] = [];
  const kept = text.replace(PARAM_ENTRY, (entry, key: string, value: string) => {
    const k = key.trim();
    if (!SECRET_KEY.test(k) || /^(pwd|password)$/i.test(k)) return entry;
    secret.push(`${k}=${value.trim()}`);
    return "";
  });
  return { kept, secret: secret.join(";") };
}

/** A secret entries list added back to the list it came from. */
export function joinParams(text: string, secret: string | undefined): string {
  if (!secret) return text;
  if (!text.trim()) return secret;
  const separator = text.includes("\n") && !text.includes(";") ? "\n" : ";";
  return `${text.replace(/[;\n\s]+$/, "")}${separator}${secret}`;
}

/** One connection of an export with passwords, for the core: its id and the secret entries taken out of it. */
export interface SecretRequest {
  id: string;
  inline: { extra?: string; odbcConnStr?: string } | null;
}

/** The connections without their secret entries, and what the core is asked to seal for each one (same order). */
export function secretRequests(conns: ConnConfig[]): { conns: ConnConfig[]; requests: SecretRequest[] } {
  const requests: SecretRequest[] = [];
  const out = conns.map((conn) => {
    const extra = splitSecretParams(conn.extra ?? "");
    const odbc = splitSecretParams(conn.odbcConnStr ?? "");
    const inline: SecretRequest["inline"] = {};
    if (extra.secret) inline.extra = extra.secret;
    if (odbc.secret) inline.odbcConnStr = odbc.secret;
    requests.push({ id: conn.id, inline: Object.keys(inline).length ? inline : null });
    return { ...conn, extra: extra.kept, odbcConnStr: odbc.kept };
  });
  return { conns: out, requests };
}

/**
 * The file «con contraseñas» (format v2): the same connections and folders as v1, without the secret entries of their
 * parameters, plus the `secrets` block the core sealed (`api().exportSecrets`), keyed by position. It says on top that
 * it carries passwords and whether they are encrypted.
 */
export function exportConnectionsJsonWithSecrets(conns: ConnConfig[], folders: string[], exportedAt: Date, secrets: { encrypted?: boolean }): string {
  const v1 = JSON.parse(exportConnectionsJson(secretRequests(conns).conns, folders, exportedAt)) as { exportedAt: string; folders: string[]; connections: unknown[] };
  const encrypted = secrets.encrypted === true;
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION_SECRETS,
      exportedAt: v1.exportedAt,
      containsSecrets: encrypted ? "Contiene contraseñas cifradas (Argon2id + AES-256-GCM): Celer pide la contraseña del fichero al importarlo." : "Contiene contraseñas SIN CIFRAR: cualquiera que lea este fichero puede usarlas.",
      folders: v1.folders,
      connections: v1.connections,
      secrets,
    },
    null,
    2,
  );
}

/** What the core gives back for one connection of a v2 file (src-tauri/src/secrets.rs SecretSet). */
export interface ImportedSecrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
  sshKey?: string;
  inline?: { extra?: string; odbcConnStr?: string } | null;
}

/** A connection of the file with its secrets, to save (they go to the credential store, never to connections.json). */
export function withImportedSecrets(conn: ConnConfig, secrets: ImportedSecrets | undefined): ConnConfig {
  if (!secrets) return conn;
  const out: ConnConfig = { ...conn, extra: joinParams(conn.extra, secrets.inline?.extra), odbcConnStr: joinParams(conn.odbcConnStr, secrets.inline?.odbcConnStr) };
  if (secrets.password) Object.assign(out, { password: secrets.password, savePassword: true });
  if (out.ssh && (secrets.sshPassword || secrets.sshPassphrase || secrets.sshKey)) {
    out.ssh = { ...out.ssh, password: secrets.sshPassword ?? null, passphrase: secrets.sshPassphrase ?? null, privateKey: secrets.sshKey ?? null };
  }
  return out;
}

const KINDS = new Set<string>(ENGINES.map((engine) => engine.kind));

/**
 * Lee un fichero exportado: las conexiones completadas con los valores por defecto de su motor (id vacío, sin
 * contraseña) y las carpetas. Un fichero que no es de Celer o una conexión sin motor válido dan un error claro.
 * Uno con contraseñas (v2) trae además su bloque `secrets`, tal cual, para que el núcleo lo abra.
 */
export function parseConnectionsJson(text: string): { connections: ConnConfig[]; folders: string[]; secrets: { encrypted: boolean; block: Record<string, unknown> } | null } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("El fichero no es un JSON válido");
  }
  if (!doc || typeof doc !== "object" || (doc as { format?: unknown }).format !== EXPORT_FORMAT) {
    throw new Error("El fichero no es una exportación de conexiones de Celer");
  }
  const file = doc as { version?: unknown; folders?: unknown; connections?: unknown; secrets?: unknown };
  if (typeof file.version !== "number" || file.version > EXPORT_VERSION_SECRETS) {
    throw new Error(`Versión del fichero no admitida (${String(file.version)}): actualiza Celer`);
  }
  if (!Array.isArray(file.connections)) throw new Error("El fichero no tiene conexiones");
  const connections = file.connections.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Conexión ${index + 1}: no es un objeto`);
    const item = raw as Record<string, unknown>;
    if (typeof item.kind !== "string" || !KINDS.has(item.kind)) throw new Error(`Conexión ${index + 1}: motor desconocido (${String(item.kind)})`);
    const base = emptyConn(item.kind as DbKind) as unknown as Record<string, unknown>;
    const cfg: Record<string, unknown> = { ...base };
    for (const key of [...PORTABLE_KEYS, "startupSql"]) {
      if (!(key in item)) continue;
      const value = item[key];
      const want = key === "startupSql" ? "string" : typeof base[key];
      if (key === "port") {
        if (value === null || (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536)) cfg.port = value;
      } else if (typeof value === want) cfg[key] = value;
    }
    cfg.id = "";
    cfg.password = "";
    const ssh = readSsh(item.ssh);
    if (ssh) cfg.ssh = ssh;
    cfg.folder = normalizeFolder(String(cfg.folder ?? ""));
    if (!String(cfg.name ?? "").trim()) cfg.name = `Conexión ${index + 1}`;
    return cfg as unknown as ConnConfig;
  });
  const folders = Array.isArray(file.folders) ? file.folders.filter((f): f is string => typeof f === "string").map(normalizeFolder).filter(Boolean) : [];
  let secrets: { encrypted: boolean; block: Record<string, unknown> } | null = null;
  if (file.version >= EXPORT_VERSION_SECRETS) {
    if (!file.secrets || typeof file.secrets !== "object") throw new Error("El fichero dice que trae contraseñas, pero no tiene el bloque «secrets»");
    const block = file.secrets as Record<string, unknown>;
    secrets = { encrypted: block.encrypted === true, block };
  }
  return { connections, folders, secrets };
}

/** Lo que identifica a qué servidor y con quién conecta una conexión (para no importarla dos veces). */
export function connIdentity(conn: Pick<ConnConfig, "kind" | "host" | "port" | "database" | "user" | "filePath" | "instance" | "odbcConnStr">): string {
  const low = (value: string | undefined) => (value ?? "").trim().toLowerCase();
  return [conn.kind, low(conn.host), conn.port ?? "", low(conn.database), low(conn.user), low(conn.filePath), low(conn.instance), (conn.odbcConnStr ?? "").trim()].join("|");
}

/** Qué conexiones del fichero son nuevas y cuáles ya existían (también las repetidas dentro del propio fichero). */
export function planImport<T extends Parameters<typeof connIdentity>[0]>(existing: Parameters<typeof connIdentity>[0][], incoming: T[]): { fresh: T[]; duplicates: T[] } {
  const seen = new Set(existing.map(connIdentity));
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const conn of incoming) {
    const key = connIdentity(conn);
    if (seen.has(key)) duplicates.push(conn);
    else {
      seen.add(key);
      fresh.push(conn);
    }
  }
  return { fresh, duplicates };
}
