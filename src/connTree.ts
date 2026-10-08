// Lógica pura del explorador de conexiones: carpetas anidadas ("Clientes/Egarsat"), orden, búsqueda y filtros, y el
// formato portable para exportar e importar conexiones sin contraseñas. Sin solid-js ni efectos, para poder probarla
// con node (dev/explorer-check.ts).
import { emptyConn, ENGINES, type ConnConfig, type DbKind } from "./types.ts";

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
export const EXPORT_VERSION = 1;

/** Campos de una conexión que viajan en el fichero: todo menos el id y la contraseña. */
const PORTABLE_KEYS = Object.keys(emptyConn("postgres")).filter((key) => key !== "id" && key !== "password") as (keyof ConnConfig)[];

/** Las conexiones (sin id ni contraseña) y las carpetas, como JSON legible. */
export function exportConnectionsJson(conns: ConnConfig[], folders: string[], exportedAt: Date): string {
  const connections = conns.map((conn) => {
    const out: Record<string, unknown> = {};
    for (const key of PORTABLE_KEYS) {
      const value = conn[key];
      if (value !== undefined) out[key] = value;
    }
    if (conn.startupSql) out.startupSql = conn.startupSql;
    return out;
  });
  const used = allFolders(
    conns.map((conn) => conn.folder),
    folders,
  );
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: exportedAt.toISOString(), folders: used, connections }, null, 2);
}

const KINDS = new Set<string>(ENGINES.map((engine) => engine.kind));

/**
 * Lee un fichero exportado: las conexiones completadas con los valores por defecto de su motor (id vacío, sin
 * contraseña) y las carpetas. Un fichero que no es de Celer o una conexión sin motor válido dan un error claro.
 */
export function parseConnectionsJson(text: string): { connections: ConnConfig[]; folders: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("El fichero no es un JSON válido");
  }
  if (!doc || typeof doc !== "object" || (doc as { format?: unknown }).format !== EXPORT_FORMAT) {
    throw new Error("El fichero no es una exportación de conexiones de Celer");
  }
  const file = doc as { version?: unknown; folders?: unknown; connections?: unknown };
  if (typeof file.version !== "number" || file.version > EXPORT_VERSION) {
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
    cfg.folder = normalizeFolder(String(cfg.folder ?? ""));
    if (!String(cfg.name ?? "").trim()) cfg.name = `Conexión ${index + 1}`;
    return cfg as unknown as ConnConfig;
  });
  const folders = Array.isArray(file.folders) ? file.folders.filter((f): f is string => typeof f === "string").map(normalizeFolder).filter(Boolean) : [];
  return { connections, folders };
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
