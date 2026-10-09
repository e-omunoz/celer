// The script library: named SQL scripts kept in the app's data folder (library.json), apart from files on disk
// and from the history, in folders and with tags. A console opened from the library remembers its entry, so saving
// again updates it. The data rules (file format, folders, search, .sql import/export) are in libraryModel.ts.
import { createStore, produce } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import {
  copyName,
  exportBundle,
  exportScript,
  fileNameFor,
  freeName,
  inFolder,
  joinFolder,
  migrateLibrary,
  moveFolder,
  normalizeFolder,
  normalizeTags,
  parseSqlFile,
  parentFolder,
  normalizeEngine,
  normalizeTargets,
  removeFolder,
  renameFolder,
  schemaSetupSql,
  scriptIdOf,
  serializeLibrary,
  targetHasDatabase,
  withParents,
  type EngineTag,
  type LibraryData,
  type LibraryScript,
  type LibrarySort,
  type RunTarget,
  type ScriptParam,
} from "./libraryModel";
import { findParams } from "./snippets";
import {
  activeSql,
  connectionById,
  isDefaultConsoleTitle,
  notify,
  openInspector,
  openQuery,
  patchTab,
  persistSoon,
  prepareConsoleSession,
  runActive,
  selectTab,
  state,
  uid,
} from "./state";
import type { ParamAnswer, SqlTab } from "./state";
import { forwardFromPanel } from "./windows";

export type { LibraryScript } from "./libraryModel";

const VIEW_KEY = "celer.library.view";

interface LibraryView {
  sort: LibrarySort;
  /** Only the scripts of the active console's connection (and those of none). */
  onlyConn: boolean;
  collapsed: string[];
}

function loadView(): LibraryView {
  const fallback: LibraryView = { sort: "name", onlyConn: false, collapsed: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<LibraryView> | null;
    if (!raw) return fallback;
    return {
      sort: raw.sort === "recent" ? "recent" : "name",
      onlyConn: raw.onlyConn === true,
      collapsed: Array.isArray(raw.collapsed) ? raw.collapsed.filter((f): f is string => typeof f === "string") : [],
    };
  } catch {
    return fallback;
  }
}

const view = loadView();

export const [library, setLibrary] = createStore({
  loaded: false,
  scripts: [] as LibraryScript[],
  folders: [] as string[],
  query: "",
  sort: view.sort,
  onlyConn: view.onlyConn,
  collapsed: view.collapsed,
  /** The row with the keyboard focus: "s:<id>" or "f:<folder>". */
  selected: "",
  /** The row being renamed in place ("s:<id>" or "f:<folder>"). */
  renaming: "",
  /** The script whose details (folder, tags, connection) are being edited. */
  editing: "",
  /** Naming the active console before saving it (the panel shows a name field). */
  naming: null as { tabId: string; name: string; folder: string } | null,
  /** Bumped to move the focus to the search box (palette: "Buscar en la biblioteca"). */
  focusSearch: 0,
  /** «Ejecutar en…» open for this script: pick the targets, then open or run. */
  runOn: null as { scriptId: string } | null,
});

/** Top-level fields of library.json this version does not know: written back as they were. */
let extra: Record<string, unknown> = {};
let loading: Promise<void> | null = null;
/** The last load failed: saving would replace scripts that may still be in the file. */
let loadFailed = false;

export function loadLibrary(): Promise<void> {
  loading ??= api()
    .loadJson("library")
    .then((file) => {
      const data = migrateLibrary(file);
      extra = data.extra;
      loadFailed = false;
      setLibrary({ loaded: true, scripts: data.scripts, folders: data.folders });
    })
    .catch((err) => {
      const message = errorText(err);
      // Not read but still there (locked…): never write over it; the next load tries again. A damaged file was
      // set aside by the core, so starting a new one is safe.
      loadFailed = !message.includes(".unreadable-");
      if (loadFailed) loading = null;
      setLibrary({ loaded: true, scripts: [], folders: [] });
      notify("No se pudo leer la biblioteca de scripts", "error", message);
    });
  return loading;
}

/**
 * library.json changed in another window: the core sends the new file to every window (only the core writes it, see
 * windows.ts), so this one shows the same scripts and folders.
 */
export function applySharedLibrary(file: unknown) {
  const data = migrateLibrary(file);
  extra = data.extra;
  loadFailed = false;
  loading ??= Promise.resolve();
  setLibrary({ loaded: true, scripts: data.scripts, folders: data.folders });
}

async function persist() {
  if (loadFailed) {
    notify("La biblioteca no se guardó: no se pudo leer la que ya había", "error");
    return;
  }
  try {
    await api().saveJson("library", serializeLibrary({ scripts: library.scripts, folders: library.folders }, extra));
  } catch (err) {
    notify("No se pudo guardar la biblioteca de scripts", "error", errorText(err));
  }
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: library.sort, onlyConn: library.onlyConn, collapsed: library.collapsed }));
  } catch {
    // Not kept: the panel opens with the defaults next time.
  }
}

export function setLibrarySort(sort: LibrarySort) {
  setLibrary("sort", sort);
  saveView();
}

export function setOnlyConn(on: boolean) {
  setLibrary("onlyConn", on);
  saveView();
}

export function toggleFolder(folder: string, open?: boolean) {
  const closed = library.collapsed.includes(folder);
  const shouldOpen = open ?? closed;
  if (shouldOpen === closed) setLibrary("collapsed", shouldOpen ? library.collapsed.filter((f) => f !== folder) : [...library.collapsed, folder]);
  saveView();
}

/** Replaces scripts and folders at once (folder operations, undo), keeping the open consoles linked. */
function setData(data: LibraryData) {
  setLibrary({ scripts: data.scripts, folders: withParents(data.folders, data.scripts) });
}

export function scriptById(id: string) {
  return library.scripts.find((s) => s.id === id);
}

/** The open console of a script, if any. */
export function consoleOf(id: string): SqlTab | undefined {
  return state.tabs.find((t): t is SqlTab => t.kind === "sql" && t.libraryId === id);
}

/** Its console has changes not saved to the library. */
export function libraryDirty(id: string): boolean {
  const tab = consoleOf(id);
  const script = scriptById(id);
  return Boolean(tab && script && tab.sql !== script.sql);
}

/** The folder new things go into: the selected folder, or the folder of the selected script. */
export function currentFolder(): string {
  const key = library.selected;
  if (key.startsWith("f:")) return key.slice(2);
  const id = scriptIdOf(key);
  return id ? (scriptById(id)?.folder ?? "") : "";
}

/** The selected script, if a script row is selected. */
export function selectedScript(): LibraryScript | undefined {
  const id = scriptIdOf(library.selected);
  return id ? scriptById(id) : undefined;
}

// ---------------------------------------------------------------- saving consoles

/** A name for a console that has none yet: its title, unless it is the default one, or its first words. */
function suggestedName(title: string, sql: string, connName?: string): string {
  if (title && !isDefaultConsoleTitle(title) && title !== connName) return title.replace(/\.sql$/i, "");
  const words = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 48 ? `${words.slice(0, 47)}…` : words || "Script";
}

/**
 * Ctrl+Alt+B: the active console into the library. A console that came from the library updates its entry; a new
 * one (or `asNew`) asks for a name first, in the library panel, to go into `folder` (by default the current one).
 */
export async function saveToLibrary(asNew = false, folder?: string) {
  // From the library's own window: the console is in the window it works with, which asks for the name.
  if (forwardFromPanel("library-save", { asNew, folder: folder ?? null })) return;
  const tab = activeSql();
  if (!tab) return;
  if (!tab.sql.trim()) {
    notify("La consola está vacía: no hay nada que guardar", "warning");
    return;
  }
  await loadLibrary();
  const existing = tab.libraryId ? scriptById(tab.libraryId) : undefined;
  if (existing && !asNew) {
    await saveConsoleToScript(existing.id);
    return;
  }
  openInspector("library", true);
  const name = existing ? copyName(existing.name, library.scripts.map((s) => s.name)) : suggestedName(tab.title, tab.sql, connectionById(tab.connId)?.name);
  setLibrary("naming", { tabId: tab.id, name, folder: folder ?? existing?.folder ?? currentFolder() });
}

/** Writes the text of the script's open console into the library. */
export async function saveConsoleToScript(id: string) {
  const tab = consoleOf(id);
  const script = scriptById(id);
  if (!tab || !script) return;
  setLibrary("scripts", (s) => s.id === id, { sql: tab.sql, updatedAt: Date.now() });
  await persist();
  notify(`«${script.name}» actualizado en la biblioteca`, "success");
}

/** Puts the saved text back in the script's open console (drops the changes made there). */
export function revertConsole(id: string) {
  if (forwardFromPanel("library-revert", { id })) return;
  const tab = consoleOf(id);
  const script = scriptById(id);
  if (!tab || !script) return;
  patchTab(tab.id, { sql: script.sql, revision: tab.revision + 1, cursor: Math.min(tab.cursor, script.sql.length) });
  persistSoon();
}

/** Confirms the name asked by saveToLibrary. */
export async function finishNaming(name: string, folder?: string) {
  const naming = library.naming;
  setLibrary("naming", null);
  const tab = naming && state.tabs.find((t) => t.id === naming.tabId);
  const clean = name.trim();
  if (!clean) return;
  if (!tab || tab.kind !== "sql") {
    notify("La consola se cerró antes de guardarla: no se ha guardado nada", "warning");
    return;
  }
  const now = Date.now();
  const script: LibraryScript = {
    id: uid(),
    name: clean,
    sql: tab.sql,
    connId: tab.connId,
    folder: normalizeFolder(folder ?? naming?.folder ?? ""),
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  setLibrary("scripts", (list) => [...list, script]);
  setLibrary("folders", (list) => withParents(list, [script]));
  setLibrary("selected", `s:${script.id}`);
  if (script.folder) toggleFolder(script.folder, true);
  patchTab(tab.id, { libraryId: script.id, title: clean });
  persistSoon();
  await persist();
  notify(`«${clean}» guardado en la biblioteca`, "success");
}

export function cancelNaming() {
  setLibrary("naming", null);
}

// ---------------------------------------------------------------- opening and running

/** Opens a library script in a console (on its connection when it still exists); `run` also runs all of it. */
export async function openLibraryScript(id: string, run = false) {
  if (forwardFromPanel("library-open", { id, run })) return;
  const script = scriptById(id);
  if (!script) return;
  setLibrary("scripts", (s) => s.id === id, "usedAt", Date.now());
  void persist();
  // Already open: go there instead of opening it twice.
  const open = consoleOf(id);
  if (open) selectTab(open.id);
  else {
    const tabId = openQuery(connectionById(script.connId) ? script.connId : (activeSql()?.connId ?? null), script.sql, script.name);
    patchTab(tabId, { libraryId: script.id });
    persistSoon();
  }
  if (run) {
    // The editor of a new console mounts first; then the whole script runs (production asks as usual).
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const tab = activeSql();
    if (!tab?.connId) {
      notify("Elige una conexión para la consola y vuelve a ejecutar", "warning", script.connId ? "La conexión del script ya no existe." : "El script no tiene conexión asociada.");
      return;
    }
    void runActive("script");
  }
}

// ---------------------------------------------------------------- «Ejecutar en…»

/** Opens «Ejecutar en…» for a script (in the window with the consoles when asked from the library's own window). */
export function openRunOn(id: string) {
  if (forwardFromPanel("library-run-on", { id })) return;
  if (!scriptById(id)) return;
  setLibrary("runOn", { scriptId: id });
}

export function closeRunOn() {
  setLibrary("runOn", null);
}

/** The targets offered when «Ejecutar en…» opens: the last ones, else the script's connection, else the console's. */
export function defaultTargets(script: LibraryScript): RunTarget[] {
  const last = (script.targets ?? []).filter((t) => connectionById(t.connId));
  if (last.length) return last.map((t) => ({ ...t }));
  const connId = connectionById(script.connId) ? script.connId! : activeSql()?.connId ?? state.connections[0]?.id;
  if (!connId) return [];
  const sameConsole = activeSql()?.connId === connId ? activeSql()?.database ?? "" : "";
  return [{ connId, database: targetHasDatabase(connectionById(connId)?.kind) ? sameConsole : "" }];
}

/** "Producción · ventas / public": how a target is named in titles and messages. */
export function targetLabel(target: RunTarget): string {
  const conn = connectionById(target.connId);
  return [conn?.name ?? "Conexión borrada", [target.database, target.schema].filter(Boolean).join(" / ")].filter(Boolean).join(" · ");
}

/**
 * «Ejecutar en…»: the script on each target, one console per target (its results in that console's tab). `open`
 * only opens the consoles (to choose a statement and run it there); `run` runs the whole script in each, one after
 * the other: production and "no WHERE" confirmations are asked per target, parameters once (on the first target).
 * The targets are remembered for next time.
 */
export async function runLibraryOn(id: string, targets: RunTarget[], action: "run" | "open") {
  const script = scriptById(id);
  if (!script) return;
  const valid = normalizeTargets(targets).filter((t) => connectionById(t.connId));
  if (!valid.length) {
    notify("Elige al menos una conexión", "warning");
    return;
  }
  setLibrary("scripts", (s) => s.id === id, { targets: valid, usedAt: Date.now() });
  void persist();
  const many = valid.length > 1;
  const needsParams = state.settings.askParams && findParams(script.sql).length > 0;
  let params: ParamAnswer | undefined;
  let done = 0;
  for (const target of valid) {
    const conn = connectionById(target.connId)!;
    const where = targetLabel(target);
    // One target: the script's own console when it is open right there; otherwise a console of its own.
    const open = consoleOf(id);
    const reuse = !many && open && open.connId === target.connId && !target.schema && (!target.database || open.database.toLowerCase() === target.database.toLowerCase());
    let tabId: string;
    if (reuse) {
      tabId = open.id;
      selectTab(tabId);
    } else {
      tabId = openQuery(target.connId, script.sql, many ? `${script.name} · ${where}` : script.name, {
        database: target.database || undefined,
        libraryId: !many && !open ? script.id : undefined,
      });
      persistSoon();
    }
    const setup = schemaSetupSql(conn.kind, target.schema);
    if (setup) {
      try {
        await prepareConsoleSession(tabId, setup);
      } catch (err) {
        notify(`No se pudo preparar «${where}»: no se ha ejecutado ahí`, "error", errorText(err));
        continue;
      }
    }
    if (action === "open") continue;
    // The editor of the new console mounts first; the run happens in that console.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    selectTab(tabId);
    const ran = await runActive("script", undefined, { params, onParams: (answer) => (params = answer), database: target.database || undefined, declared: script.params });
    if (ran) done++;
    // The parameters were not given (the dialog was cancelled): the other targets are not run either.
    if (!ran && needsParams && !params) break;
  }
  if (many && action === "run") notify(`«${script.name}» ejecutado en ${done} de ${valid.length} destinos`, done === valid.length ? "success" : "warning", "Cada destino tiene su consola con sus resultados.");
}

export async function toggleFavorite(id: string) {
  const script = scriptById(id);
  if (!script) return;
  setLibrary("scripts", (s) => s.id === id, "favorite", script.favorite ? undefined : true);
  await persist();
}

/** Pastes the script at the cursor of the active console (or opens a console with it). */
export function insertLibraryScript(id: string) {
  if (forwardFromPanel("library-insert", { id })) return;
  const script = scriptById(id);
  if (!script) return;
  const tab = activeSql();
  if (!tab) {
    void openLibraryScript(id);
    return;
  }
  const at = Math.min(tab.cursor, tab.sql.length);
  const sql = tab.sql.slice(0, at) + script.sql + tab.sql.slice(at);
  patchTab(tab.id, { sql, cursor: at + script.sql.length, revision: tab.revision + 1 });
  persistSoon();
}

// ---------------------------------------------------------------- editing

export async function renameLibraryScript(id: string, name: string) {
  const clean = name.trim();
  const script = scriptById(id);
  if (!clean || !script || clean === script.name) return;
  setLibrary("scripts", (s) => s.id === id, { name: clean, updatedAt: Date.now() });
  const tab = consoleOf(id);
  if (tab) patchTab(tab.id, { title: clean });
  persistSoon();
  await persist();
}

/** Name, folder, tags, connection, description, engine and parameters at once (the details form). */
export async function updateLibraryScript(
  id: string,
  patch: { name?: string; folder?: string; tags?: string | string[]; connId?: string | null; description?: string; engine?: EngineTag | ""; params?: ScriptParam[] },
) {
  const script = scriptById(id);
  if (!script) return;
  const next: Partial<LibraryScript> = {};
  if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim();
  if (patch.folder !== undefined) next.folder = normalizeFolder(patch.folder);
  if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
  if (patch.connId !== undefined) next.connId = patch.connId || null;
  // Cleared fields go away (undefined), as if they had never been set.
  if (patch.description !== undefined) next.description = patch.description.trim().slice(0, 2000) || undefined;
  if (patch.engine !== undefined) next.engine = normalizeEngine(patch.engine);
  if (patch.params !== undefined) next.params = patch.params.length ? patch.params : undefined;
  setLibrary("scripts", (s) => s.id === id, { ...next, updatedAt: Date.now() });
  if (next.folder) setLibrary("folders", (list) => withParents(list, [{ ...script, ...next } as LibraryScript]));
  if (next.name) {
    const tab = consoleOf(id);
    if (tab) patchTab(tab.id, { title: next.name });
  }
  persistSoon();
  await persist();
}

export async function duplicateLibraryScript(id: string) {
  const script = scriptById(id);
  if (!script) return;
  const now = Date.now();
  const copy: LibraryScript = { ...script, id: uid(), name: copyName(script.name, library.scripts.map((s) => s.name)), createdAt: now, updatedAt: now, usedAt: undefined, favorite: undefined };
  const at = library.scripts.findIndex((s) => s.id === id);
  setLibrary("scripts", (list) => [...list.slice(0, at + 1), copy, ...list.slice(at + 1)]);
  setLibrary({ selected: `s:${copy.id}`, renaming: `s:${copy.id}` });
  await persist();
}

/** The library as it is now plus the consoles linked to it: what "Deshacer" puts back. */
function snapshot() {
  const data: LibraryData = { scripts: library.scripts.map((s) => ({ ...s, tags: [...s.tags] })), folders: [...library.folders] };
  const links = state.tabs.flatMap((t) => (t.kind === "sql" && t.libraryId ? [{ tabId: t.id, libraryId: t.libraryId }] : []));
  return () => {
    setData(data);
    for (const link of links) if (state.tabs.some((t) => t.id === link.tabId)) patchTab(link.tabId, { libraryId: link.libraryId });
    persistSoon();
    void persist();
  };
}

/** Unlinks the consoles of scripts that are gone (they keep their text). */
function unlinkGone() {
  const ids = new Set(library.scripts.map((s) => s.id));
  for (const tab of state.tabs) if (tab.kind === "sql" && tab.libraryId && !ids.has(tab.libraryId)) patchTab(tab.id, { libraryId: undefined });
  persistSoon();
}

/** Deletes scripts at once, with "Deshacer" in the notice (no confirmation to click through). */
export async function deleteLibraryScripts(ids: string[]) {
  const gone = library.scripts.filter((s) => ids.includes(s.id));
  if (!gone.length) return;
  const undo = snapshot();
  setLibrary("scripts", (list) => list.filter((s) => !ids.includes(s.id)));
  if (library.editing && ids.includes(library.editing)) setLibrary("editing", "");
  unlinkGone();
  await persist();
  notify(gone.length === 1 ? `«${gone[0].name}» borrado de la biblioteca` : `${gone.length} scripts borrados de la biblioteca`, "info", "Las consolas abiertas conservan su texto.", { label: "Deshacer", run: undo });
}

export async function deleteLibraryScript(id: string) {
  await deleteLibraryScripts([id]);
}

/** Moves scripts to a folder ("" is the top level). */
export async function moveScriptsToFolder(ids: string[], folder: string) {
  const target = normalizeFolder(folder);
  if (!library.scripts.some((s) => ids.includes(s.id) && s.folder !== target)) return;
  setLibrary(
    "scripts",
    produce((list: LibraryScript[]) => {
      for (const s of list) if (ids.includes(s.id)) s.folder = target;
    }),
  );
  setLibrary("folders", (list) => withParents([...list, target].filter(Boolean), library.scripts));
  if (target) toggleFolder(target, true);
  await persist();
}

// ---------------------------------------------------------------- folders

/** A new folder inside `parent` (the current one by default), left in rename mode. */
export async function createLibraryFolder(parent = currentFolder()) {
  await loadLibrary();
  openInspector("library");
  const siblings = library.folders.filter((f) => parentFolder(f) === parent).map((f) => f.slice(f.lastIndexOf("/") + 1));
  const folder = joinFolder(parent, freeName("Nueva carpeta", siblings));
  setLibrary("folders", (list) => withParents([...list, folder], []));
  if (parent) toggleFolder(parent, true);
  setLibrary({ selected: `f:${folder}`, renaming: `f:${folder}` });
  await persist();
}

export async function renameLibraryFolder(folder: string, name: string) {
  const clean = name.replace(/[\\/]/g, " ").trim();
  if (!clean || clean === folder.slice(folder.lastIndexOf("/") + 1)) return;
  const next = renameFolder({ scripts: library.scripts, folders: library.folders }, folder, joinFolder(parentFolder(folder), clean));
  if (!next) return;
  setData(next);
  const to = joinFolder(parentFolder(folder), clean);
  setLibrary("collapsed", (list) => list.map((f) => (inFolder(f, folder) ? to + f.slice(folder.length) : f)));
  setLibrary("selected", `f:${to}`);
  saveView();
  await persist();
}

/** Drag and drop of a folder into another one ("" is the top level). */
export async function moveLibraryFolder(folder: string, into: string) {
  if (parentFolder(folder) === into) return;
  const next = moveFolder({ scripts: library.scripts, folders: library.folders }, folder, into);
  if (!next) {
    notify("Una carpeta no puede ir dentro de sí misma", "warning");
    return;
  }
  setData(next);
  if (into) toggleFolder(into, true);
  await persist();
}

/** Deletes a folder with its subfolders and scripts; "Deshacer" brings everything back. */
export async function deleteLibraryFolder(folder: string) {
  const undo = snapshot();
  const { data, removed } = removeFolder({ scripts: library.scripts, folders: library.folders }, folder);
  setData(data);
  if (library.selected === `f:${folder}`) setLibrary("selected", "");
  unlinkGone();
  await persist();
  const what = removed.length ? ` y ${removed.length === 1 ? "su script" : `sus ${removed.length} scripts`}` : "";
  notify(`Carpeta «${folder}»${what} borrada`, "info", undefined, { label: "Deshacer", run: undo });
}

// ---------------------------------------------------------------- .sql files

/** Imports .sql files into the current folder: one script per file, or the scripts of a library export. */
export async function importLibraryFiles() {
  await loadLibrary();
  const paths = await api().pickOpenPaths([{ name: "SQL", extensions: ["sql", "txt"] }]);
  if (!paths.length) return;
  const into = currentFolder();
  const added: LibraryScript[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    try {
      const { text } = await api().readTextFile(path);
      const now = Date.now();
      for (const item of parseSqlFile(path, text)) {
        added.push({
          id: uid(),
          name: item.name,
          sql: item.sql,
          connId: null,
          folder: joinFolder(into, item.folder),
          tags: item.tags,
          createdAt: now,
          updatedAt: now,
          ...(item.description ? { description: item.description } : {}),
          ...(item.engine ? { engine: item.engine } : {}),
          ...(item.params ? { params: item.params } : {}),
        });
      }
    } catch (err) {
      failed.push(`${path.split(/[\\/]/).pop()}: ${errorText(err)}`);
    }
  }
  if (added.length) {
    setLibrary("scripts", (list) => [...list, ...added]);
    setLibrary("folders", (list) => withParents(list, added));
    openInspector("library");
    setLibrary("selected", `s:${added[0].id}`);
    if (into) toggleFolder(into, true);
    await persist();
    notify(added.length === 1 ? `«${added[0].name}» importado a la biblioteca` : `${added.length} scripts importados a la biblioteca`, "success");
  } else if (!failed.length) notify("Los ficheros no tenían SQL", "warning");
  if (failed.length) notify("Algún fichero no se pudo leer", "error", failed.join("\n"));
}

/**
 * Exports to a .sql file: one script as plain SQL; a folder or the whole library as one file that imports back
 * with its folders and tags.
 */
export async function exportLibrary(scope: { scriptId: string } | { folder: string }) {
  await loadLibrary();
  let scripts: LibraryScript[];
  let name: string;
  if ("scriptId" in scope) {
    const script = scriptById(scope.scriptId);
    if (!script) return;
    scripts = [script];
    name = fileNameFor(script.name);
  } else {
    scripts = library.scripts.filter((s) => inFolder(s.folder, scope.folder));
    name = fileNameFor(scope.folder ? scope.folder.slice(scope.folder.lastIndexOf("/") + 1) : "biblioteca");
  }
  if (!scripts.length) {
    notify("No hay scripts que exportar", "warning");
    return;
  }
  let path = name;
  if (isTauri()) {
    const picked = await api().pickSavePath([{ name: "SQL", extensions: ["sql"] }], name);
    if (!picked) return;
    path = picked;
  }
  try {
    await api().writeTextFile(path, scripts.length === 1 && "scriptId" in scope ? exportScript(scripts[0]) : exportBundle(scripts));
    notify(scripts.length === 1 ? "Script exportado" : `${scripts.length} scripts exportados`, "success", path);
  } catch (err) {
    notify("No se pudo exportar", "error", errorText(err));
  }
}
