// The script library: named SQL scripts kept in the app's data folder (library.json), apart from files on disk
// and from the history. A console opened from the library remembers its entry, so saving again updates it.
import { createStore } from "solid-js/store";
import { api, errorText } from "./api";
import { activeSql, connectionById, notify, openInspector, openQuery, patchTab, persistSoon, selectTab, state, uid } from "./state";

export interface LibraryScript {
  id: string;
  name: string;
  sql: string;
  /** The connection it was saved from (opened there again when it still exists). */
  connId: string | null;
  createdAt: number;
  updatedAt: number;
}

export const [library, setLibrary] = createStore({
  loaded: false,
  scripts: [] as LibraryScript[],
  query: "",
  /** Naming the active console before saving it (the panel shows a name field). */
  naming: null as { tabId: string; name: string } | null,
});

let loading: Promise<void> | null = null;
/** The last load failed: saving would replace scripts that may still be in the file. */
let loadFailed = false;

const valid = (s: unknown): s is LibraryScript => {
  const x = s as LibraryScript;
  return Boolean(x && typeof x.id === "string" && typeof x.name === "string" && typeof x.sql === "string");
};

export function loadLibrary(): Promise<void> {
  loading ??= api()
    .loadJson("library")
    .then((file) => {
      const list = (file as { scripts?: unknown[] } | null)?.scripts;
      const scripts = Array.isArray(list) ? list.filter(valid).map((s) => ({ ...s, connId: s.connId ?? null, createdAt: s.createdAt ?? 0, updatedAt: s.updatedAt ?? 0 })) : [];
      loadFailed = false;
      setLibrary({ loaded: true, scripts });
    })
    .catch((err) => {
      const message = errorText(err);
      // Not read but still there (locked…): never write over it; the next load tries again. A damaged file was
      // set aside by the core, so starting a new one is safe.
      loadFailed = !message.includes(".unreadable-");
      if (loadFailed) loading = null;
      setLibrary({ loaded: true, scripts: [] });
      notify("No se pudo leer la biblioteca de scripts", "error", message);
    });
  return loading;
}

async function persist() {
  if (loadFailed) {
    notify("La biblioteca no se guardó: no se pudo leer la que ya había", "error");
    return;
  }
  try {
    await api().saveJson("library", { version: 1, scripts: library.scripts });
  } catch (err) {
    notify("No se pudo guardar la biblioteca de scripts", "error", errorText(err));
  }
}

/** Library scripts matching the search, most recently changed first. */
export function filteredScripts(): LibraryScript[] {
  const q = library.query.trim().toLowerCase();
  const list = q ? library.scripts.filter((s) => s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q)) : library.scripts;
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/** A name for a console that has none yet: its title, unless it is the default one, or its first words. */
function suggestedName(title: string, sql: string, connName?: string): string {
  if (title && title !== "console" && title !== connName) return title.replace(/\.sql$/i, "");
  const words = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 48 ? `${words.slice(0, 47)}…` : words || "Script";
}

/**
 * Ctrl+Alt+B: the active console into the library. A console that came from the library updates its entry; a new
 * one asks for a name first (in the library panel).
 */
export async function saveToLibrary() {
  const tab = activeSql();
  if (!tab) return;
  if (!tab.sql.trim()) {
    notify("La consola está vacía: no hay nada que guardar", "warning");
    return;
  }
  await loadLibrary();
  const existing = tab.libraryId ? library.scripts.find((s) => s.id === tab.libraryId) : undefined;
  if (existing) {
    setLibrary("scripts", (s) => s.id === existing.id, { sql: tab.sql, connId: tab.connId, updatedAt: Date.now() });
    await persist();
    notify(`«${existing.name}» actualizado en la biblioteca`, "success");
    return;
  }
  openInspector("library");
  setLibrary("naming", { tabId: tab.id, name: suggestedName(tab.title, tab.sql, connectionById(tab.connId)?.name) });
}

/** Confirms the name asked by saveToLibrary. */
export async function finishNaming(name: string) {
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
  const script: LibraryScript = { id: uid(), name: clean, sql: tab.sql, connId: tab.connId, createdAt: now, updatedAt: now };
  setLibrary("scripts", (list) => [...list, script]);
  patchTab(tab.id, { libraryId: script.id, title: clean });
  persistSoon();
  await persist();
  notify(`«${clean}» guardado en la biblioteca`, "success");
}

export function cancelNaming() {
  setLibrary("naming", null);
}

/** Opens a library script in a new console (on its connection when it still exists). */
export function openLibraryScript(id: string) {
  const script = library.scripts.find((s) => s.id === id);
  if (!script) return;
  // Already open: go there instead of opening it twice.
  const open = state.tabs.find((t) => t.kind === "sql" && t.libraryId === id);
  if (open) {
    selectTab(open.id);
    return;
  }
  const tabId = openQuery(connectionById(script.connId) ? script.connId : (activeSql()?.connId ?? null), script.sql, script.name);
  patchTab(tabId, { libraryId: script.id });
  persistSoon();
}

export async function renameLibraryScript(id: string, name: string) {
  const clean = name.trim();
  if (!clean) return;
  setLibrary("scripts", (s) => s.id === id, { name: clean, updatedAt: Date.now() });
  for (const tab of state.tabs) if (tab.kind === "sql" && tab.libraryId === id) patchTab(tab.id, { title: clean });
  persistSoon();
  await persist();
}

export async function deleteLibraryScript(id: string) {
  setLibrary("scripts", (list) => list.filter((s) => s.id !== id));
  // Open consoles keep their text; they are just no longer linked.
  for (const tab of state.tabs) if (tab.kind === "sql" && tab.libraryId === id) patchTab(tab.id, { libraryId: undefined });
  persistSoon();
  await persist();
}
