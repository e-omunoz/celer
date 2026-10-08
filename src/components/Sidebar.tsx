import { ChevronRight, ChevronsDownUp, FolderPlus, History, Plus, RefreshCw, Search, Settings2, Star, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { EngineIcon, ObjIcon } from "../icons";
import { Gib } from "../gib/Gib";
import {
  collapseAll,
  connColor,
  connect,
  copySchemaForAi,
  copyText,
  disconnect,
  generateSql,
  kindOf,
  openActivity,
  openErDiagram,
  moveConnection,
  openConnDialog,
  openMenu,
  openQuery,
  openTable,
  pathKey,
  refreshNode,
  serverOf,
  setState,
  startObjectExport,
  state,
  toggleConnection,
  toggleNode,
} from "../state";
import type { MenuItem } from "../state";
import { isTauri } from "../api";
import { emptyConn, ENGINES, type ConnSummary, type DbKind, type MetaNode } from "../types";
import { startImport } from "../importer";
import { openMigration } from "../migrate";
import { withShortcut } from "../commands";
import { compareWithMarked, isMarked, markForCompare, schemaCompare, schemaTitle } from "../schemaCompareRun";
import { compareDataWithMarked, dataCompare, isTableMarked, markTableForCompare, tableTitle } from "../dataCompareRun";
import { engineOf } from "../types";
import { connLink, linkTitle } from "../connStatus";
import { LinkDot } from "./LinkDot";
import { buildConnTree, connMatches, countConns, filterActive, folderName, NO_FILTER, parentFolder, passesFilter, sortConns, type FolderNode, type QuickFilter } from "../connTree";
import {
  createFolder,
  deleteConnectionUndoable,
  deleteFolder,
  duplicateConnectionNow,
  exportConnections,
  folderCollapsed,
  importConnections,
  isFavorite,
  moveConnectionsTo,
  moveFolder,
  noteRecent,
  renameConnection,
  renameFolder,
  setConnSort,
  toggleFavorite,
  toggleFolder,
} from "../connManage";

const ROW = 24;

/** The "Favoritas" section is folded with the folders, under a name no folder can take by accident. */
const FAV_KEY = ":favoritas";

// Drag and drop of connections and folders (into a folder, before a connection, or to the root).
const CONN_MIME = "application/x-celer-connection";
const FOLDER_MIME = "application/x-celer-folder";
const [dropOver, setDropOver] = createSignal<string | null>(null);
/** What is being dragged: a connection id, or "g:<folder path>". */
const [dragging, setDragging] = createSignal<string | null>(null);
/** The row being renamed in place (F2): "c:<id>" or "g:<folder path>". */
const [editing, setEditing] = createSignal<string | null>(null);
/** Puts the keyboard back on the tree (after renaming in place). */
let focusTree: () => void = () => {};

function acceptDrop(event: DragEvent, key: string) {
  const types = event.dataTransfer?.types ?? [];
  if (!types.includes(CONN_MIME) && !types.includes(FOLDER_MIME)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  setDropOver(key);
}

/** Drops on a folder (or before a connection of it): a connection moves there, a folder goes inside it. */
function dropInto(event: DragEvent, folder: string, beforeId?: string) {
  const id = event.dataTransfer?.getData(CONN_MIME);
  const path = event.dataTransfer?.getData(FOLDER_MIME);
  setDropOver(null);
  setDragging(null);
  if (id) {
    event.preventDefault();
    void moveConnection(id, folder, beforeId);
  } else if (path) {
    event.preventDefault();
    void moveFolder(path, folder);
  }
}

type Row =
  | { type: "folder"; key: string; path: string; name: string; depth: number; count: number; open: boolean }
  | { type: "section"; key: string; name: string; depth: number; count: number; open: boolean }
  | { type: "fav"; key: string; conn: ConnSummary; depth: number }
  | { type: "root"; key: string; depth: number }
  | { type: "conn"; key: string; conn: ConnSummary; depth: number }
  | { type: "node"; key: string; connId: string; node: MetaNode; depth: number }
  | { type: "status"; key: string; text: string; depth: number; error?: boolean };

/** "hace 5 min" for the recent connections. */
function ago(at: number) {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

export function Sidebar() {
  let scroller: HTMLDivElement | undefined;
  let filterInput: HTMLInputElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [quick, setQuick] = createSignal<QuickFilter>(NO_FILTER);
  focusTree = () => scroller?.focus();

  // Recent connections: every connection that becomes connected (however it was connected) goes on top.
  let seen = new Set<string>();
  createEffect(() => {
    const ids = Object.keys(state.sessions);
    const fresh = ids.filter((id) => !seen.has(id));
    seen = new Set(ids);
    if (fresh.length) untrack(() => fresh.forEach(noteRecent));
  });

  const rows = createMemo<Row[]>((previous) => {
    const fresh = buildRows();
    // Reuse row objects that did not change so <For> keeps their DOM nodes (and double-clicks land).
    const old = new Map((previous ?? []).map((row) => [row.key, row]));
    return fresh.map((row) => {
      const before = old.get(row.key);
      if (!before || before.type !== row.type || before.depth !== row.depth) return row;
      if (row.type === "node" && before.type === "node" && before.node === row.node) return before;
      if ((row.type === "conn" || row.type === "fav") && (before.type === "conn" || before.type === "fav") && before.conn === row.conn) return before;
      if ((row.type === "folder" || row.type === "section") && (before.type === "folder" || before.type === "section") && before.name === row.name && before.count === row.count && before.open === row.open) return before;
      if (row.type === "root" || (row.type === "status" && before.type === "status" && before.text === row.text)) return before;
      return row;
    });
  });

  function buildRows(): Row[] {
    const filter = state.treeFilter.trim().toLowerCase();
    const q = quick();
    const filtering = Boolean(filter) || filterActive(q);
    const mode = state.settings.connSort;
    const favorites = state.settings.favoriteConns;
    const shown = state.connections.filter((conn) => passesFilter(conn, q, favorites, (id) => Boolean(state.sessions[id])));
    const out: Row[] = [];
    // Favourites on top (a shortcut to each one; the connection itself stays in its folder).
    const favs = shown.filter((conn) => favorites.includes(conn.id) && (!filter || connMatches(conn, filter)));
    if (favs.length && !q.favorites) {
      const open = filtering || !folderCollapsed(FAV_KEY);
      out.push({ type: "section", key: "s:fav", name: "Favoritas", depth: 0, count: favs.length, open });
      if (open) for (const conn of sortConns(favs, mode)) out.push({ type: "fav", key: `f:${conn.id}`, conn, depth: 1 });
    }
    const tree = buildConnTree(shown, filtering ? [] : state.settings.connFolders, mode);
    emitFolder(tree, 0, filter, filtering, out);
    // While dragging, the root is a target too (out of every folder).
    if (dragging() && tree.folders.length) out.push({ type: "root", key: "g:", depth: 0 });
    return out;
  }

  function emitFolder(node: FolderNode<ConnSummary>, depth: number, filter: string, filtering: boolean, out: Row[]) {
    for (const folder of node.folders) {
      const sub: Row[] = [];
      emitFolder(folder, depth + 1, filter, filtering, sub);
      // While searching, a folder shows only when something inside it matches (and it is shown open).
      if (filtering && !sub.length) continue;
      const open = filtering || !folderCollapsed(folder.path);
      out.push({ type: "folder", key: `g:${folder.path}`, path: folder.path, name: folder.name, depth, count: countConns(folder), open });
      if (open) out.push(...sub);
    }
    for (const conn of node.conns) emitConn(conn, depth, filter, out);
  }

  function emitConn(conn: ConnSummary, depth: number, filter: string, out: Row[]) {
    const rootKey = pathKey(conn.id, []);
    const root = state.tree[rootKey];
    const children: Row[] = [];
    if (state.sessions[conn.id] && root?.open) {
      walk(conn.id, root.nodes, depth + 1, filter, children);
      if (root.status === "loading" && !root.nodes.length) children.push({ type: "status", key: `${rootKey}:s`, text: "Cargando…", depth: depth + 1 });
      if (root.status === "error") children.push({ type: "status", key: `${rootKey}:e`, text: root.error ?? "Error", depth: depth + 1, error: true });
    }
    const selfMatch = !filter || connMatches(conn, filter);
    if (!selfMatch && !children.length) return;
    out.push({ type: "conn", key: `c:${conn.id}`, conn, depth });
    out.push(...children);
  }

  function walk(connId: string, nodes: MetaNode[], depth: number, filter: string, out: Row[]) {
    for (const node of nodes) {
      const key = pathKey(connId, node.path.length ? node.path : [...node.path, node.name]);
      const entry = node.leaf ? undefined : state.tree[pathKey(connId, node.path)];
      const sub: Row[] = [];
      if (entry?.open) {
        walk(connId, entry.nodes, depth + 1, filter, sub);
        if (entry.status === "loading" && !entry.nodes.length) sub.push({ type: "status", key: `${key}:s`, text: "Cargando…", depth: depth + 1 });
        if (entry.status === "error") sub.push({ type: "status", key: `${key}:e`, text: entry.error ?? "Error", depth: depth + 1, error: true });
        if (entry.status === "ready" && !entry.nodes.length && !filter) sub.push({ type: "status", key: `${key}:v`, text: "Vacío", depth: depth + 1 });
      }
      const matches = !filter || node.name.toLowerCase().includes(filter);
      const keepFolder = filter && !node.leaf && (node.kind === "folder" || node.kind === "schema" || node.kind === "database") && sub.length > 0;
      if (!matches && !sub.length && !keepFolder) continue;
      out.push({ type: "node", key: `n:${key}`, connId, node, depth });
      out.push(...sub);
    }
  }

  const visible = createMemo(() => {
    const all = rows();
    const first = Math.max(0, Math.floor(scrollTop() / ROW) - 8);
    const last = Math.min(all.length, Math.ceil((scrollTop() + height()) / ROW) + 8);
    return { first, items: all.slice(first, last), total: all.length };
  });

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(scroller?.clientHeight ?? 600));
    if (scroller) ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  function selectedIndex() {
    return rows().findIndex((row) => row.key === state.treeSelected);
  }

  function select(key: string) {
    setState("treeSelected", key);
  }

  function ensureVisible(index: number) {
    if (!scroller) return;
    const top = index * ROW;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW - scroller.clientHeight;
  }

  /** Selects a row once it is in the list (after a change that adds it) and scrolls to it. */
  function reveal(key: string) {
    select(key);
    queueMicrotask(() => {
      const index = rows().findIndex((row) => row.key === key);
      if (index >= 0) ensureVisible(index);
    });
  }

  /** Shows a connection in its place (opening its folders and clearing a search that hides it) and selects it. */
  function revealConn(id: string) {
    const conn = state.connections.find((c) => c.id === id);
    if (!conn) return;
    if (!rows().some((row) => row.key === `c:${id}`)) {
      setState("treeFilter", "");
      setQuick(NO_FILTER);
      for (let folder = conn.folder || ""; folder; folder = parentFolder(folder)) toggleFolder(folder, true);
    }
    reveal(`c:${id}`);
    scroller?.focus();
  }

  /** Where a new folder goes: inside the selected folder, or next to the selected connection. */
  function folderHere(): string {
    const row = rows()[selectedIndex()];
    if (row?.type === "folder") return row.path;
    if (row?.type === "conn" || row?.type === "fav") return row.conn.folder || "";
    return "";
  }

  async function newFolder(parent = folderHere()) {
    const path = await createFolder(parent);
    setState("treeFilter", "");
    setQuick(NO_FILTER);
    reveal(`g:${path}`);
    setEditing(`g:${path}`);
  }

  /** A new folder holding this connection, named in place right away. */
  async function folderWith(conn: ConnSummary) {
    const path = await createFolder(conn.folder || "");
    await moveConnectionsTo([conn.id], path);
    reveal(`g:${path}`);
    setEditing(`g:${path}`);
  }

  function activate(row: Row) {
    if (row.type === "conn") {
      if (!state.sessions[row.conn.id]) void connect(row.conn.id);
      else toggleConnection(row.conn.id);
    }
    if (row.type === "fav") {
      if (!state.sessions[row.conn.id]) void connect(row.conn.id);
      revealConn(row.conn.id);
    }
    if (row.type === "folder") toggleFolder(row.path);
    if (row.type === "section") toggleFolder(FAV_KEY);
    if (row.type === "node") {
      const obj = row.node.obj;
      if (obj && (obj.kind === "table" || obj.kind === "view")) void openTable(row.connId, obj);
      else if (obj && (obj.kind === "procedure" || obj.kind === "function" || obj.kind === "trigger")) void generateSql(row.connId, obj, "ddl");
      else void toggleNode(row.connId, row.node);
    }
  }

  /** The context menu of a row from the keyboard (menu key or Shift+F10), at the row. */
  function menuFromKeyboard(row: Row, index: number) {
    const rect = scroller?.getBoundingClientRect();
    const x = (rect?.left ?? 0) + 24 + row.depth * 14;
    const y = (rect?.top ?? 0) + index * ROW - (scroller?.scrollTop ?? 0) + ROW;
    const event = new MouseEvent("contextmenu", { clientX: x, clientY: y });
    if (row.type === "conn" || row.type === "fav") connMenu(event, row.conn);
    else if (row.type === "folder") folderMenu(event, row.path);
    else if (row.type === "node") nodeMenu(event, row.connId, row.node);
    else backgroundMenu(event);
  }

  function onKey(event: KeyboardEvent) {
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    // Explorer shortcuts that do not need a selected row.
    if (ctrl && !event.shiftKey && !event.altKey && key === "f") {
      event.preventDefault();
      setFilterOpen(true);
      queueMicrotask(() => filterInput?.focus());
      return;
    }
    if (ctrl && event.shiftKey && key === "n") {
      event.preventDefault();
      void newFolder();
      return;
    }
    if (event.key === "Escape" && (state.treeFilter || filterActive(quick()))) {
      event.preventDefault();
      setState("treeFilter", "");
      setQuick(NO_FILTER);
      return;
    }
    const list = rows();
    if (!list.length) return;
    const index = selectedIndex();
    const row = list[index];
    const go = (next: number) => {
      event.preventDefault();
      const clamped = Math.max(0, Math.min(list.length - 1, next));
      select(list[clamped].key);
      ensureVisible(clamped);
    };
    if (event.key === "ArrowDown") return go(index + 1);
    if (event.key === "ArrowUp") return go(index < 0 ? 0 : index - 1);
    if (event.key === "Home") return go(0);
    if (event.key === "End") return go(list.length - 1);
    if (!row) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      menuFromKeyboard(row, index);
      return;
    }
    const conn = row.type === "conn" || row.type === "fav" ? row.conn : null;
    if (conn && (event.key === "F4" || (event.altKey && event.key === "Enter"))) {
      event.preventDefault();
      openConnDialog(conn);
      return;
    }
    if (event.key === "Enter" || event.key === "F4") {
      event.preventDefault();
      activate(row);
      return;
    }
    if (event.key === "F2" && (row.type === "conn" || row.type === "folder")) {
      event.preventDefault();
      setEditing(row.key);
      return;
    }
    if (conn && ctrl && !event.shiftKey && key === "d") {
      event.preventDefault();
      void duplicateConnectionNow(conn.id).then((id) => id && reveal(`c:${id}`));
      return;
    }
    if (conn && ctrl && event.shiftKey && key === "f") {
      event.preventDefault();
      toggleFavorite(conn.id);
      return;
    }
    // Ctrl+F5 "Actualizar": a connected connection's tree, or the selected object folder.
    if (ctrl && event.key === "F5") {
      event.preventDefault();
      if (conn && state.sessions[conn.id]) void refreshNode(conn.id, []);
      else if (row.type === "node" && !row.node.leaf) void refreshNode(row.connId, row.node.path);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.type === "conn") {
        if (!state.sessions[row.conn.id]) void connect(row.conn.id);
        else if (!state.tree[pathKey(row.conn.id, [])]?.open) toggleConnection(row.conn.id, true);
        else go(index + 1);
      }
      if (row.type === "folder" || row.type === "section") {
        if (!row.open) toggleFolder(row.type === "folder" ? row.path : FAV_KEY, true);
        else go(index + 1);
      }
      if (row.type === "node" && !row.node.leaf) {
        if (!state.tree[pathKey(row.connId, row.node.path)]?.open) void toggleNode(row.connId, row.node, true);
        else go(index + 1);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const open =
        row.type === "conn"
          ? state.tree[pathKey(row.conn.id, [])]?.open
          : row.type === "node" && !row.node.leaf
            ? state.tree[pathKey(row.connId, row.node.path)]?.open
            : row.type === "folder" || row.type === "section"
              ? row.open
              : false;
      if (open) {
        if (row.type === "conn") toggleConnection(row.conn.id, false);
        if (row.type === "node") void toggleNode(row.connId, row.node, false);
        if (row.type === "folder") toggleFolder(row.path, false);
        if (row.type === "section") toggleFolder(FAV_KEY, false);
        return;
      }
      for (let i = index - 1; i >= 0; i--) {
        if (list[i].depth < row.depth) return go(i);
      }
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      if (row.type === "conn") void deleteConnectionUndoable(row.conn.id);
      // On a favourite's shortcut, Supr only takes it out of the favourites.
      if (row.type === "fav") toggleFavorite(row.conn.id);
      if (row.type === "folder") void deleteFolder(row.path);
      return;
    }
    if (ctrl && key === "c" && !event.shiftKey) {
      if (row.type === "node") {
        event.preventDefault();
        void copyText(row.node.name);
      } else if (conn) {
        event.preventDefault();
        void copyText(conn.name);
      } else if (row.type === "folder") {
        event.preventDefault();
        void copyText(row.name);
      }
      return;
    }
    if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      setFilterOpen(true);
      setState("treeFilter", state.treeFilter + event.key);
      queueMicrotask(() => filterInput?.focus());
    }
  }

  function connMenu(event: MouseEvent, conn: ConnSummary) {
    const connected = Boolean(state.sessions[conn.id]);
    openMenu(event, [
      connected ? { label: "Desconectar", icon: "unplug", run: () => void disconnect(conn.id) } : { label: "Conectar", hint: "Intro", icon: "plug", run: () => void connect(conn.id) },
      { label: "Nueva consola", hint: "Ctrl+Mayús+L", icon: "console", run: () => openQuery(conn.id) },
      { label: "Actualizar", hint: "Ctrl+F5", icon: "refresh", disabled: !connected, run: () => void refreshNode(conn.id, []) },
      { separator: true },
      { label: "Propiedades…", hint: "F4", icon: "settings", run: () => openConnDialog(conn) },
      { label: "Renombrar", hint: "F2", run: () => { revealConn(conn.id); setEditing(`c:${conn.id}`); } },
      { label: "Duplicar", hint: "Ctrl+D", run: () => void duplicateConnectionNow(conn.id).then((id) => id && reveal(`c:${id}`)) },
      { label: isFavorite(conn.id) ? "Quitar de favoritas" : "Añadir a favoritas", hint: "Ctrl+Mayús+F", run: () => toggleFavorite(conn.id) },
      { label: "Nueva carpeta con esta conexión", run: () => void folderWith(conn) },
      ...(conn.folder ? [{ label: "Sacar de la carpeta", run: () => void moveConnectionsTo([conn.id], parentFolder(conn.folder)) }] : []),
      { separator: true },
      { label: "Copiar nombre", hint: "Ctrl+C", run: () => void copyText(conn.name) },
      { label: "Copiar esquema para IA", disabled: !connected, run: () => void copySchemaForAi(conn.id) },
      ...(conn.kind === "sqlite" || conn.kind === "odbc" ? [] : [{ label: "Actividad del servidor…", icon: "activity", run: () => void openActivity(conn.id) }]),
      { label: "Exportar conexión (sin contraseña)…", run: () => void exportConnections([conn.id], conn.name) },
      { separator: true },
      { label: "Eliminar conexión", hint: "Supr", icon: "trash", danger: true, run: () => void deleteConnectionUndoable(conn.id) },
    ]);
  }

  function folderMenu(event: MouseEvent, path: string) {
    const ids = state.connections.filter((conn) => (conn.folder || "") === path || (conn.folder || "").startsWith(`${path}/`)).map((conn) => conn.id);
    const open = !folderCollapsed(path);
    openMenu(event, [
      { label: open ? "Plegar" : "Desplegar", hint: "Intro", run: () => toggleFolder(path) },
      { label: "Nueva conexión aquí…", run: () => openConnDialog({ ...emptyConn(isTauri() ? "postgres" : "sqlite"), folder: path }) },
      { label: "Nueva subcarpeta", hint: "Ctrl+Mayús+N", run: () => void newFolder(path) },
      { separator: true },
      { label: "Renombrar", hint: "F2", run: () => { reveal(`g:${path}`); setEditing(`g:${path}`); } },
      ...(parentFolder(path) ? [{ label: "Mover a la carpeta de arriba", run: () => void moveFolder(path, parentFolder(parentFolder(path))) }] : []),
      { label: "Conectar todas", disabled: !ids.length, run: () => ids.forEach((id) => void connect(id)) },
      { label: "Copiar nombre", hint: "Ctrl+C", run: () => void copyText(folderName(path)) },
      { label: "Exportar la carpeta (sin contraseñas)…", disabled: !ids.length, run: () => void exportConnections(ids, folderName(path)) },
      { separator: true },
      { label: "Eliminar carpeta", hint: "Supr", icon: "trash", danger: true, run: () => void deleteFolder(path) },
    ]);
  }

  function optionsItems(): MenuItem[] {
    const alpha = state.settings.connSort === "alpha";
    return [
      { label: alpha ? "Orden: alfabético" : "Ordenar alfabéticamente", hint: alpha ? "actual" : undefined, run: () => setConnSort("alpha") },
      { label: alpha ? "Ordenar a mano (arrastrando)" : "Orden: manual", hint: alpha ? undefined : "actual", run: () => setConnSort("manual") },
      { separator: true },
      { label: "Exportar todas las conexiones (sin contraseñas)…", disabled: !state.connections.length, run: () => void exportConnections() },
      { label: "Importar conexiones de un fichero de Celer…", run: () => void importConnections() },
      { label: "Importar de DBeaver o DbVisualizer…", run: () => void openMigration() },
    ];
  }

  function backgroundMenu(event: MouseEvent) {
    openMenu(event, [
      { label: "Nueva conexión…", hint: "Ctrl+Alt+N", run: () => openConnDialog() },
      { label: "Nueva carpeta", hint: "Ctrl+Mayús+N", run: () => void newFolder("") },
      { label: "Buscar conexiones", hint: "Ctrl+F", run: () => { setFilterOpen(true); queueMicrotask(() => filterInput?.focus()); } },
      { separator: true },
      ...optionsItems(),
      { separator: true },
      { label: "Contraer todo", run: collapseAll },
      { label: "Actualizar todo", disabled: !Object.keys(state.sessions).length, run: () => { for (const id of Object.keys(state.sessions)) void refreshNode(id, []); } },
    ]);
  }

  function recentMenu(event: MouseEvent) {
    const recent = state.settings.recentConns.filter((item) => state.connections.some((conn) => conn.id === item.id));
    openMenu(
      event,
      recent.length
        ? recent.map((item) => {
            const conn = state.connections.find((c) => c.id === item.id)!;
            return { label: conn.name, hint: ago(item.at), run: () => { if (!state.sessions[conn.id]) void connect(conn.id); revealConn(conn.id); } };
          })
        : [{ label: "Aún no hay conexiones recientes", disabled: true }],
    );
  }

  function nodeMenu(event: MouseEvent, connId: string, node: MetaNode) {
    const obj = node.obj;
    const items = [] as Parameters<typeof openMenu>[1];
    if (obj && (obj.kind === "table" || obj.kind === "view")) {
      items.push(
        { label: "Abrir datos", hint: "F4", icon: "table", run: () => void openTable(connId, obj) },
        { label: "Abrir estructura", run: () => void openTable(connId, obj, "columns") },
        { label: "Ver DDL", icon: "code", run: () => void openTable(connId, obj, "ddl") },
        { separator: true },
        { label: "Generar SELECT", run: () => void generateSql(connId, obj, "select") },
        { label: "Generar SELECT con JOIN de sus claves foráneas", run: () => void generateSql(connId, obj, "select-join") },
        { label: "Generar SELECT COUNT(*)", run: () => void generateSql(connId, obj, "count") },
      );
      if (obj.kind === "table") {
        items.push(
          { label: "Generar INSERT", run: () => void generateSql(connId, obj, "insert") },
          { label: "Generar UPDATE", run: () => void generateSql(connId, obj, "update") },
          { label: "Generar DELETE", run: () => void generateSql(connId, obj, "delete") },
          { label: kindOf(connId) === "mysql" || kindOf(connId) === "postgres" || kindOf(connId) === "sqlite" ? "Generar UPSERT (insertar o actualizar)" : "Generar MERGE (insertar o actualizar)", run: () => void generateSql(connId, obj, "upsert") },
        );
      }
      items.push(
        { label: `Generar DROP ${node.path.includes("matviews") ? "MATERIALIZED VIEW" : obj.kind === "view" ? "VIEW" : "TABLE"}`, run: () => void generateSql(connId, obj, "drop", node.path) },
        { label: "DDL en consola", run: () => void generateSql(connId, obj, "ddl") },
        { separator: true },
        { label: "Exportar datos…", icon: "download", run: () => void startObjectExport(connId, obj) },
        ...(obj.kind === "table" ? [{ label: "Importar datos (CSV, JSON, Excel)…", icon: "upload", run: () => void startImport(connId, obj) }] : []),
        { label: "Copiar estructura para IA", icon: "ai", run: () => void copySchemaForAi(connId, obj) },
        { separator: true },
      );
      // Comparing the rows of two tables: mark one, then "Comparar datos con…" on the other.
      const tableRef = { connId, obj };
      const marked = dataCompare.mark;
      if (marked && !isTableMarked(tableRef)) items.push({ label: `Comparar datos con «${tableTitle(marked)}»`, icon: "compare", run: () => void compareDataWithMarked(tableRef) });
      items.push({ label: isTableMarked(tableRef) ? "Marcada para comparar datos" : "Marcar para comparar datos", icon: "compare", run: () => markTableForCompare(tableRef) }, { separator: true });
    } else if (obj) {
      items.push({ label: "Abrir definición", icon: "code", run: () => void generateSql(connId, obj, "ddl") }, { separator: true });
    }
    // Diagram of a schema (or of a database on engines without schemas: Informix, ODBC).
    const schemaLevel = node.kind === "schema" || (node.kind === "database" && (kindOf(connId) === "informix" || kindOf(connId) === "odbc"));
    if (schemaLevel) {
      const ref = { connId, path: node.path };
      const mark = schemaCompare.mark;
      items.push({ label: "Diagrama entidad-relación", icon: "diagram", run: () => void openErDiagram(connId, node.path) });
      if (mark && !isMarked(ref)) items.push({ label: `Comparar con «${schemaTitle(mark)}»`, icon: "compare", run: () => void compareWithMarked(ref) });
      items.push({ label: isMarked(ref) ? "Marcado para comparar" : "Marcar para comparar", icon: "compare", run: () => markForCompare(ref) }, { separator: true });
    }
    items.push(
      { label: "Nueva consola aquí", icon: "console", run: () => openQuery(connId) },
      { label: "Copiar nombre", hint: "Ctrl+C", icon: "copy", run: () => void copyText(node.name) },
    );
    if (obj) items.push({ label: "Copiar nombre completo", run: () => void copyText([obj.schema, obj.name].filter(Boolean).join(".")) });
    if (!node.leaf) items.push({ separator: true }, { label: "Actualizar", hint: "Ctrl+F5", icon: "refresh", run: () => void refreshNode(connId, node.path) });
    openMenu(event, items);
  }

  /** Engines among the saved connections, for the quick filters. */
  const kinds = createMemo(() => ENGINES.map((engine) => engine.kind).filter((kind) => state.connections.some((conn) => conn.kind === kind)));

  function toggleKind(kind: DbKind) {
    const current = quick();
    setQuick({ ...current, kinds: current.kinds.includes(kind) ? current.kinds.filter((k) => k !== kind) : [...current.kinds, kind] });
  }

  function closeFilter() {
    setState("treeFilter", "");
    setQuick(NO_FILTER);
    setFilterOpen(false);
  }

  return (
    <aside class="explorer" style={{ width: `${state.settings.sidebarWidth}px` }}>
      <div class="toolwin-head">
        <span class="toolwin-title">Explorador</span>
        <span class="spacer" />
        <button type="button" class="icon-btn" title={withShortcut("Nueva conexión", "new-conn")} onClick={() => openConnDialog()}><Plus size={15} /></button>
        <button type="button" class="icon-btn" title="Nueva carpeta (Ctrl+Mayús+N)" onClick={() => void newFolder()}><FolderPlus size={14} /></button>
        <button type="button" class="icon-btn" title="Buscar y filtrar conexiones (Ctrl+F)" classList={{ on: filterOpen() || filterActive(quick()) }} onClick={() => { if (filterOpen()) closeFilter(); else { setFilterOpen(true); queueMicrotask(() => filterInput?.focus()); } }}><Search size={14} /></button>
        <button type="button" class="icon-btn" title="Conexiones recientes" onClick={(event) => recentMenu(event)}><History size={14} /></button>
        <button type="button" class="icon-btn" title="Orden, exportar e importar conexiones" onClick={(event) => openMenu(event, optionsItems())}><Settings2 size={14} /></button>
        <button type="button" class="icon-btn" title="Actualizar todo" onClick={() => { for (const id of Object.keys(state.sessions)) void refreshNode(id, []); }}><RefreshCw size={14} /></button>
        <button type="button" class="icon-btn" title="Contraer todo" onClick={collapseAll}><ChevronsDownUp size={14} /></button>
      </div>
      <Show when={filterOpen() || state.treeFilter || filterActive(quick())}>
        <div class="tree-filter">
          <Search size={13} />
          <input
            ref={filterInput}
            placeholder="Conexión, servidor, base, motor u objeto"
            value={state.treeFilter}
            onInput={(event) => setState("treeFilter", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closeFilter();
                scroller?.focus();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                scroller?.focus();
                if (rows().length) select(rows()[0].key);
              }
            }}
          />
          <Show when={state.treeFilter || filterActive(quick())}>
            <button type="button" class="icon-btn tiny" title="Limpiar (Esc)" onClick={() => { setState("treeFilter", ""); setQuick(NO_FILTER); }}><X size={12} /></button>
          </Show>
        </div>
        <div class="quick-filters" role="group" aria-label="Filtros rápidos">
          <button type="button" class="qf" classList={{ on: quick().favorites }} aria-pressed={quick().favorites} onClick={() => setQuick({ ...quick(), favorites: !quick().favorites })}><Star size={11} /> Favoritas</button>
          <button type="button" class="qf" classList={{ on: quick().connected }} aria-pressed={quick().connected} onClick={() => setQuick({ ...quick(), connected: !quick().connected })}>Conectadas</button>
          <button type="button" class="qf" classList={{ on: quick().production }} aria-pressed={quick().production} onClick={() => setQuick({ ...quick(), production: !quick().production })}>Producción</button>
          <Show when={kinds().length > 1}>
            <For each={kinds()}>
              {(kind) => (
                <button type="button" class="qf" classList={{ on: quick().kinds.includes(kind) }} aria-pressed={quick().kinds.includes(kind)} title={engineOf(kind).label} onClick={() => toggleKind(kind)}>
                  <EngineIcon kind={kind} size={12} /> {engineOf(kind).label.split(" ")[0]}
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <div
        class="tree"
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("tree-space")) backgroundMenu(event);
        }}
        role="tree"
        aria-label="Conexiones y objetos"
      >
        <div class="tree-space" style={{ height: `${visible().total * ROW}px`, position: "relative" }}>
          <For each={visible().items}>
            {(row, i) => (
              <div class="tree-row-wrap" style={{ transform: `translateY(${(visible().first + i()) * ROW}px)` }}>
                <TreeRow
                  row={row}
                  selected={state.treeSelected === row.key}
                  filter={state.treeFilter}
                  onSelect={() => select(row.key)}
                  onActivate={() => activate(row)}
                  onConnMenu={connMenu}
                  onFolderMenu={folderMenu}
                  onNodeMenu={nodeMenu}
                  onBackgroundMenu={backgroundMenu}
                />
              </div>
            )}
          </For>
        </div>
        <Show when={state.connections.length && !rows().length}>
          <div class="tree-empty small">
            <p>Ninguna conexión coincide.</p>
            <button type="button" class="btn" onClick={closeFilter}>Quitar la búsqueda</button>
          </div>
        </Show>
        <Show when={!state.connections.length && state.ready}>
          <div class="tree-empty">
            <Gib size={84} mood="wave" />
            <p>Aún no hay conexiones.</p>
            <button type="button" class="btn primary" onClick={() => openConnDialog()}>Añadir conexión</button>
            <small>Ctrl+Alt+N</small>
          </div>
        </Show>
      </div>
    </aside>
  );
}

/** The name field of a row being renamed in place: Intro keeps it, Esc leaves it as it was. */
function RenameInput(props: { value: string; onDone: (value: string | null) => void }) {
  return (
    <input
      class="tree-rename"
      value={props.value}
      spellcheck={false}
      ref={(el) =>
        queueMicrotask(() => {
          el.focus();
          el.select();
        })
      }
      onMouseDown={(event) => event.stopPropagation()}
      onDblClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          props.onDone(event.currentTarget.value);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          props.onDone(null);
        }
      }}
      onBlur={(event) => props.onDone(event.currentTarget.value)}
    />
  );
}

/** Ends a rename in place (once: Intro and the blur that follows both end it). */
function finishRename(key: string, apply: () => void) {
  if (editing() !== key) return;
  setEditing(null);
  apply();
  focusTree();
}

function TreeRow(props: {
  row: Row;
  selected: boolean;
  filter: string;
  onSelect: () => void;
  onActivate: () => void;
  onConnMenu: (event: MouseEvent, conn: ConnSummary) => void;
  onFolderMenu: (event: MouseEvent, path: string) => void;
  onNodeMenu: (event: MouseEvent, connId: string, node: MetaNode) => void;
  onBackgroundMenu: (event: MouseEvent) => void;
}) {
  const indent = () => 6 + props.row.depth * 14;
  const row = props.row;
  if (row.type === "root") {
    return (
      <div
        class="tree-row folder-row root-drop"
        classList={{ "drop-into": dropOver() === row.key }}
        style={{ "padding-left": `${indent()}px` }}
        onDragOver={(event) => acceptDrop(event, row.key)}
        onDragLeave={() => setDropOver(null)}
        onDrop={(event) => dropInto(event, "")}
      >
        Sin carpeta (raíz)
      </div>
    );
  }
  if (row.type === "section") {
    return (
      <div
        class="tree-row section-row"
        classList={{ selected: props.selected }}
        style={{ "padding-left": `${indent()}px` }}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={props.selected}
        aria-expanded={row.open}
        onMouseDown={props.onSelect}
        onClick={props.onActivate}
        onContextMenu={(event) => {
          props.onSelect();
          props.onBackgroundMenu(event);
        }}
      >
        <span class="twist" classList={{ open: row.open }}>
          <ChevronRight size={12} />
        </span>
        <Star size={12} class="section-star" />
        <span class="tree-name">{row.name}</span>
        <small class="tree-count">{row.count}</small>
      </div>
    );
  }
  if (row.type === "folder") {
    const key = row.key;
    return (
      <div
        class="tree-row folder-row"
        classList={{ selected: props.selected, "drop-into": dropOver() === key, dragging: dragging() === key }}
        style={{ "padding-left": `${indent()}px` }}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={props.selected}
        aria-expanded={row.open}
        draggable={editing() !== key}
        onDragStart={(event) => {
          event.dataTransfer?.setData(FOLDER_MIME, row.path);
          event.dataTransfer?.setData("text/plain", row.name);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          setDragging(key);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropOver(null);
        }}
        onDragOver={(event) => acceptDrop(event, key)}
        onDragLeave={() => setDropOver(null)}
        onDrop={(event) => dropInto(event, row.path)}
        onMouseDown={props.onSelect}
        onDblClick={props.onActivate}
        onContextMenu={(event) => {
          props.onSelect();
          props.onFolderMenu(event, row.path);
        }}
        title={`${row.path} · ${row.count} ${row.count === 1 ? "conexión" : "conexiones"}`}
      >
        <span
          class="twist"
          classList={{ open: row.open }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelect();
            toggleFolder(row.path);
          }}
          onDblClick={(event) => event.stopPropagation()}
        >
          <ChevronRight size={12} />
        </span>
        <ObjIcon kind="folder" size={15} />
        <Show when={editing() === key} fallback={<span class="tree-name">{highlight(row.name, props.filter)}</span>}>
          <RenameInput value={row.name} onDone={(value) => finishRename(key, () => value !== null && void renameFolder(row.path, value))} />
        </Show>
        <small class="tree-count">{row.count}</small>
      </div>
    );
  }
  if (row.type === "status") {
    return <div class="tree-row status" classList={{ error: row.error }} style={{ "padding-left": `${indent() + 20}px` }} title={row.text}>{row.error ? `⚠ ${row.text}` : row.text}</div>;
  }
  if (row.type === "conn" || row.type === "fav") {
    const conn = row.conn;
    const alias = row.type === "fav";
    const key = row.key;
    const connected = () => Boolean(state.sessions[conn.id]);
    const open = () => connected() && state.tree[pathKey(conn.id, [])]?.open;
    const busy = () => state.connecting[conn.id];
    const link = () => connLink(conn.id);
    const where = `${engineOf(conn.kind).label}${conn.host ? ` · ${conn.host}${conn.port ? `:${conn.port}` : ""}` : conn.filePath ? ` · ${conn.filePath}` : ""}${conn.database ? ` · ${conn.database}` : ""}`;
    return (
      <div
        class="tree-row conn"
        classList={{ selected: props.selected, connected: connected(), alias, "drop-before": !alias && dropOver() === key, dragging: dragging() === conn.id }}
        style={{ "padding-left": `${indent()}px` }}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={props.selected}
        aria-expanded={alias ? undefined : Boolean(open())}
        draggable={!alias && editing() !== key}
        onDragStart={(event) => {
          event.dataTransfer?.setData(CONN_MIME, conn.id);
          event.dataTransfer?.setData("text/plain", conn.name);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          setDragging(conn.id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropOver(null);
        }}
        // Dropping on a connection moves the dragged one to its folder, right above it.
        onDragOver={(event) => !alias && acceptDrop(event, key)}
        onDragLeave={() => setDropOver(null)}
        onDrop={(event) => !alias && dropInto(event, conn.folder || "", conn.id)}
        onMouseDown={props.onSelect}
        onDblClick={() => (alias ? props.onActivate() : connected() ? toggleConnection(conn.id) : void connect(conn.id))}
        onContextMenu={(event) => {
          props.onSelect();
          props.onConnMenu(event, conn);
        }}
        title={`${conn.name}\n${where}${conn.folder ? `\nCarpeta: ${conn.folder}` : ""}\n${linkTitle(link())}`}
      >
        <span
          class="twist"
          classList={{ open: Boolean(open()), hidden: alias }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelect();
            if (connected()) toggleConnection(conn.id);
            else void connect(conn.id);
          }}
          onDblClick={(event) => event.stopPropagation()}
        >
          <ChevronRight size={12} />
        </span>
        <span class="conn-icon">
          <EngineIcon kind={conn.kind} size={15} server={serverOf(conn.id)} />
          <LinkDot info={link()} color={connColor(conn)} />
        </span>
        <Show when={editing() === key} fallback={<span class="tree-name">{highlight(conn.name, props.filter)}</span>}>
          <RenameInput value={conn.name} onDone={(value) => finishRename(key, () => value !== null && void renameConnection(conn.id, value))} />
        </Show>
        <Show when={conn.production}><span class="tag prod">PROD</span></Show>
        <Show when={conn.readOnly}><span class="tag">RO</span></Show>
        <small class="tree-detail">{busy() ? "conectando…" : conn.host || (conn.filePath ? conn.filePath.split(/[\\/]/).pop() : "")}</small>
        <button
          type="button"
          class="fav-star"
          classList={{ on: isFavorite(conn.id) }}
          title={`${isFavorite(conn.id) ? "Quitar de favoritas" : "Añadir a favoritas"} (Ctrl+Mayús+F)`}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(conn.id);
          }}
          onDblClick={(event) => event.stopPropagation()}
        >
          <Star size={12} />
        </button>
      </div>
    );
  }
  const node = row.node;
  const entry = () => (node.leaf ? undefined : state.tree[pathKey(row.connId, node.path)]);
  const open = () => Boolean(entry()?.open);
  const loading = () => entry()?.status === "loading";
  const icon = node.kind === "folder" ? folderIcon(node.name, node.path) : node.kind;
  const draggable = Boolean(node.obj);
  return (
    <div
      class="tree-row"
      classList={{ selected: props.selected, leaf: node.leaf }}
      style={{ "padding-left": `${indent()}px` }}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={props.selected}
      aria-expanded={node.leaf ? undefined : open()}
      draggable={draggable}
      onDragStart={(event) => {
        const obj = node.obj;
        if (!obj) return;
        event.dataTransfer?.setData("text/plain", obj.schema && obj.schema !== "main" ? `${obj.schema}.${obj.name}` : obj.name);
      }}
      onMouseDown={props.onSelect}
      onClick={(event) => event.detail === 1 && !node.leaf && !node.obj && void toggleNode(row.connId, node)}
      onDblClick={() => node.obj && props.onActivate()}
      onContextMenu={(event) => {
        props.onSelect();
        props.onNodeMenu(event, row.connId, node);
      }}
      title={node.detail ? `${node.name} · ${node.detail}` : node.name}
    >
      <span
        class="twist"
        classList={{ open: open(), hidden: node.leaf, spin: loading() }}
        onClick={(event) => {
          event.stopPropagation();
          if (!node.leaf) void toggleNode(row.connId, node);
        }}
        onDblClick={(event) => event.stopPropagation()}
      >
        <ChevronRight size={12} />
      </span>
      <ObjIcon kind={icon} size={15} />
      <span class="tree-name" classList={{ folder: node.kind === "folder" }}>{highlight(node.name, props.filter)}</span>
      <Show when={node.kind === "folder" && entry()?.status === "ready"}><small class="tree-count">{entry()!.nodes.length}</small></Show>
      <Show when={node.detail}><small class="tree-detail">{node.detail}</small></Show>
    </div>
  );
}

function folderIcon(name: string, path: string[]) {
  const key = (path[path.length - 1] ?? name).toLowerCase();
  if (/^(tables|tablas)$/.test(key)) return "folder";
  if (/views|vistas/.test(key)) return "folder";
  if (/index|índices|indices/.test(key)) return "folder";
  return "folder";
}

function highlight(text: string, filter: string) {
  // The first word of the search is marked (a search of several words matches them in any field).
  const f = filter.trim().split(/\s+/)[0] ?? "";
  if (!f) return text;
  const at = text.toLowerCase().indexOf(f.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + f.length)}</mark>
      {text.slice(at + f.length)}
    </>
  );
}
