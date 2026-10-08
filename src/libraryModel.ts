// The script library's data, without the app around it: the file format and its migration, folders and tags,
// search, the tree the panel shows, and the .sql files it imports and exports. Pure functions, tested by
// dev/library-check.ts; library.ts keeps the state and talks to the disk.

export interface LibraryScript {
  id: string;
  name: string;
  sql: string;
  /** The connection it belongs to, if any (opened there; null runs it on the console's connection). */
  connId: string | null;
  /** Its folder, "" for the top level; subfolders joined with "/" ("Informes/Mensuales"). */
  folder: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** Last time it was opened or run from the library. */
  usedAt?: number;
}

export interface LibraryData {
  scripts: LibraryScript[];
  /** Every folder, also the empty ones (a folder with scripts is listed too). */
  folders: string[];
}

/**
 * library.json. Version 1 had { id, name, sql, connId, createdAt, updatedAt } per script and no folders; version 2
 * adds folder and tags per script and the list of folders. A version 1 reader still reads a version 2 file.
 */
export const LIBRARY_VERSION = 2;

export type LibrarySort = "name" | "recent";

// ---------------------------------------------------------------- folders and tags

/** "  Informes / /Mensuales\\ " → "Informes/Mensuales": trimmed parts, no empty or dot ones, "/" between. */
export function normalizeFolder(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split(/[\\/]+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

export function parentFolder(folder: string): string {
  const at = folder.lastIndexOf("/");
  return at < 0 ? "" : folder.slice(0, at);
}

export function folderName(folder: string): string {
  return folder.slice(folder.lastIndexOf("/") + 1);
}

export function joinFolder(parent: string, name: string): string {
  return normalizeFolder(parent ? `${parent}/${name}` : name);
}

/** The folder and the ones it hangs from: "A/B/C" → ["A", "A/B", "A/B/C"]. */
export function folderChain(folder: string): string[] {
  const parts = folder ? folder.split("/") : [];
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Whether `folder` is `root` or inside it ("" holds everything). */
export function inFolder(folder: string, root: string): boolean {
  return !root || folder === root || folder.startsWith(`${root}/`);
}

/** "ventas, #Mensual  ventas" → ["ventas", "Mensual"]: commas or spaces between, no "#", no repeats (any case). */
export function normalizeTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    for (const raw of item.split(/[,\s]+/)) {
      const tag = raw.replace(/^#+/, "").trim().slice(0, 40);
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out;
}

/** Every tag in use with how many scripts carry it, most used first. */
export function allTags(scripts: LibraryScript[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const script of scripts) {
    for (const tag of script.tags) {
      const key = tag.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.count++;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Every folder that has to exist: the listed ones, the ones holding scripts, and their parents; sorted. */
export function withParents(folders: string[], scripts: LibraryScript[]): string[] {
  const set = new Set<string>();
  for (const folder of [...folders, ...scripts.map((s) => s.folder)]) for (const f of folderChain(normalizeFolder(folder))) set.add(f);
  return [...set].sort(compareFolders);
}

function compareFolders(a: string, b: string): number {
  // Part by part, so "A/B" stays right under "A" (and before "A B").
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = pa[i].localeCompare(pb[i], undefined, { sensitivity: "base", numeric: true });
    if (c) return c;
  }
  return pa.length - pb.length;
}

// ---------------------------------------------------------------- the file

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Reads library.json in any version (null when there is none) without losing anything: unknown fields of a
 * script are kept as they are, and so are unknown top-level fields (`extra`, written back on save).
 */
export function migrateLibrary(raw: unknown): LibraryData & { extra: Record<string, unknown> } {
  const file = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawScripts = file.scripts;
  const rawFolders = file.folders;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) if (key !== "version" && key !== "scripts" && key !== "folders") extra[key] = value;
  const scripts: LibraryScript[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(rawScripts) ? rawScripts : []) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.name !== "string" || typeof s.sql !== "string") continue;
    // A repeated id (a hand-edited or merged file) would open and save the wrong script.
    let id = s.id;
    for (let n = 2; ids.has(id); n++) id = `${s.id}-${n}`;
    ids.add(id);
    const createdAt = num(s.createdAt);
    scripts.push({
      ...s,
      id,
      name: s.name,
      sql: s.sql,
      connId: typeof s.connId === "string" && s.connId ? s.connId : null,
      folder: normalizeFolder(s.folder),
      tags: normalizeTags(s.tags),
      createdAt,
      updatedAt: num(s.updatedAt) || createdAt,
      ...(typeof s.usedAt === "number" ? { usedAt: s.usedAt } : {}),
    } as LibraryScript);
  }
  const folders = withParents(Array.isArray(rawFolders) ? rawFolders.map(normalizeFolder).filter(Boolean) : [], scripts);
  return { scripts, folders, extra };
}

export function serializeLibrary(data: LibraryData, extra: Record<string, unknown> = {}) {
  return { ...extra, version: LIBRARY_VERSION, scripts: data.scripts, folders: withParents(data.folders, data.scripts) };
}

// ---------------------------------------------------------------- names

/** `base`, or "base (copia)", "base (copia 2)"… when taken (any case). */
export function copyName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  const root = base.replace(/\s+\(copia(?: \d+)?\)$/i, "");
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${root} (copia)` : `${root} (copia ${n})`;
    if (!names.has(name.toLowerCase())) return name;
  }
}

/** `base` when free, else "base 2", "base 3"… (for new folders). */
export function freeName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** A file name for a script: no characters Windows refuses, not empty, not too long. */
export function fileNameFor(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  return `${clean || "script"}.sql`;
}

// ---------------------------------------------------------------- search

export interface LibraryQuery {
  /** Words that must all appear in the name, the SQL, the folder or a tag. */
  words: string[];
  /** #tag: the script must carry each one. */
  tags: string[];
}

/** "ventas #mensual 2024" → words ["ventas", "2024"], tags ["mensual"] (lower case). */
export function parseQuery(text: string): LibraryQuery {
  const words: string[] = [];
  const tags: string[] = [];
  for (const token of text.toLowerCase().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith("#") && token.length > 1) tags.push(token.slice(1));
    else if (token !== "#") words.push(token);
  }
  return { words, tags };
}

export function matchesQuery(script: LibraryScript, query: LibraryQuery): boolean {
  const tags = script.tags.map((t) => t.toLowerCase());
  if (!query.tags.every((tag) => tags.includes(tag))) return false;
  if (!query.words.length) return true;
  const haystack = `${script.name}\n${script.folder}\n${tags.join(" ")}\n${script.sql}`.toLowerCase();
  return query.words.every((word) => haystack.includes(word));
}

/** Adds the tag to the search, or takes it out when it is already there. */
export function toggleTagInQuery(text: string, tag: string): string {
  const token = `#${tag.toLowerCase()}`;
  const tokens = text.split(/\s+/).filter(Boolean);
  const without = tokens.filter((t) => t.toLowerCase() !== token);
  return (without.length === tokens.length ? [...tokens, `#${tag}`] : without).join(" ");
}

export function sortScripts(list: LibraryScript[], by: LibrarySort): LibraryScript[] {
  const byName = (a: LibraryScript, b: LibraryScript) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const recent = (s: LibraryScript) => Math.max(s.updatedAt, s.usedAt ?? 0);
  return [...list].sort(by === "name" ? byName : (a, b) => recent(b) - recent(a) || byName(a, b));
}

// ---------------------------------------------------------------- the tree

export type LibraryRow =
  | { kind: "folder"; key: string; path: string; name: string; depth: number; count: number; open: boolean }
  | { kind: "script"; key: string; script: LibraryScript; depth: number };

export interface TreeOptions {
  query?: string;
  sort?: LibrarySort;
  /** Folders shown closed. */
  collapsed?: ReadonlySet<string>;
  /** Only scripts of this connection and those of none (undefined: all). */
  connId?: string | null;
}

/**
 * The rows of the panel: folders first (each followed by its content), then the scripts at that level. While
 * searching or filtering, only the matches and the folders that lead to them, all open.
 */
export function buildTree(data: LibraryData, options: TreeOptions = {}): LibraryRow[] {
  const query = parseQuery(options.query ?? "");
  const filtering = Boolean(query.words.length || query.tags.length || options.connId !== undefined);
  const visible = data.scripts.filter(
    (s) => matchesQuery(s, query) && (options.connId === undefined || s.connId === null || s.connId === options.connId),
  );
  const folders = withParents(filtering ? [] : data.folders, visible);
  const counts = new Map<string, number>();
  for (const s of visible) for (const f of folderChain(s.folder)) counts.set(f, (counts.get(f) ?? 0) + 1);
  const scriptsIn = new Map<string, LibraryScript[]>();
  for (const s of sortScripts(visible, options.sort ?? "name")) {
    const list = scriptsIn.get(s.folder);
    if (list) list.push(s);
    else scriptsIn.set(s.folder, [s]);
  }
  const children = new Map<string, string[]>();
  for (const f of folders) {
    const parent = parentFolder(f);
    const list = children.get(parent);
    if (list) list.push(f);
    else children.set(parent, [f]);
  }
  const rows: LibraryRow[] = [];
  const walk = (folder: string, depth: number) => {
    for (const sub of children.get(folder) ?? []) {
      const open = filtering || !options.collapsed?.has(sub);
      rows.push({ kind: "folder", key: `f:${sub}`, path: sub, name: folderName(sub), depth, count: counts.get(sub) ?? 0, open });
      if (open) walk(sub, depth + 1);
    }
    for (const script of scriptsIn.get(folder) ?? []) rows.push({ kind: "script", key: `s:${script.id}`, script, depth });
  };
  walk("", 0);
  return rows;
}

// ---------------------------------------------------------------- folder operations

/**
 * Renames a folder (or moves it, which is the same: "A/B" → "C/B"), with its subfolders and scripts. Moving a
 * folder into itself, or onto a name that is not valid, leaves everything as it was (null).
 */
export function renameFolder(data: LibraryData, from: string, to: string): LibraryData | null {
  const target = normalizeFolder(to);
  if (!from || !target || inFolder(target, from)) return target === from ? data : null;
  const move = (folder: string) => (inFolder(folder, from) ? target + folder.slice(from.length) : folder);
  const scripts = data.scripts.map((s) => (inFolder(s.folder, from) && s.folder ? { ...s, folder: move(s.folder) } : s));
  return { scripts, folders: withParents(data.folders.map(move), scripts) };
}

/** Moves a folder into another one ("" is the top level). */
export function moveFolder(data: LibraryData, folder: string, into: string): LibraryData | null {
  return renameFolder(data, folder, joinFolder(into, folderName(folder)));
}

/** Takes out a folder, its subfolders and every script in them (returned as `removed`, to undo). */
export function removeFolder(data: LibraryData, folder: string): { data: LibraryData; removed: LibraryScript[] } {
  const removed = data.scripts.filter((s) => s.folder && inFolder(s.folder, folder));
  const scripts = data.scripts.filter((s) => !(s.folder && inFolder(s.folder, folder)));
  return { data: { scripts, folders: withParents(data.folders.filter((f) => !inFolder(f, folder)), scripts) }, removed };
}

// ---------------------------------------------------------------- .sql files

/** The line that starts each script of a library export: "-- @celer-script {json}". */
const MARK = "-- @celer-script ";

/** A plain .sql with the script's text (one script). */
export function exportScript(script: LibraryScript): string {
  return script.sql.endsWith("\n") ? script.sql : `${script.sql}\n`;
}

/**
 * Several scripts in one .sql file. Each starts with a comment line carrying its name, folder and tags, so the
 * file still runs as a script and importing it gives back the same scripts.
 */
export function exportBundle(scripts: LibraryScript[]): string {
  const head = `-- Celer: ${scripts.length === 1 ? "1 script" : `${scripts.length} scripts`} de la biblioteca. Cada uno empieza en una línea «${MARK.trim()}».\n\n`;
  return (
    head +
    scripts
      .map((s) => {
        const meta: Record<string, unknown> = { name: s.name };
        if (s.folder) meta.folder = s.folder;
        if (s.tags.length) meta.tags = s.tags;
        return `${MARK}${JSON.stringify(meta)}\n${s.sql.replace(/\s+$/, "")}\n`;
      })
      .join("\n")
  );
}

export interface ImportedScript {
  name: string;
  sql: string;
  folder: string;
  tags: string[];
}

/**
 * The scripts in a .sql file: a library export gives back each script with its folder and tags; any other file
 * is one script named after the file. Line ends become "\n" and a byte order mark goes.
 */
export function parseSqlFile(fileName: string, text: string): ImportedScript[] {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const base = fileName.split(/[\\/]/).pop()!.replace(/\.(sql|txt)$/i, "").trim() || "Script";
  const lines = body.split("\n");
  const starts = lines.flatMap((line, i) => (line.startsWith(MARK) ? [i] : []));
  if (!starts.length) return body.trim() ? [{ name: base, sql: body.replace(/\s+$/, ""), folder: "", tags: [] }] : [];
  const out: ImportedScript[] = [];
  // Anything before the first mark that is not a comment is a script of its own.
  const before = lines.slice(0, starts[0]).join("\n");
  if (before.replace(/--[^\n]*/g, "").trim()) out.push({ name: base, sql: before.trim(), folder: "", tags: [] });
  starts.forEach((start, i) => {
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(lines[start].slice(MARK.length));
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      // A damaged mark: the script still comes in, named after the file.
    }
    const sql = lines.slice(start + 1, starts[i + 1] ?? lines.length).join("\n").replace(/\s+$/, "");
    const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : `${base} ${i + 1}`;
    out.push({ name, sql, folder: normalizeFolder(meta.folder), tags: normalizeTags(meta.tags) });
  });
  return out;
}
