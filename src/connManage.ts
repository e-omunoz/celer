// Gestión de las conexiones desde el explorador: renombrar, duplicar, borrar con deshacer, carpetas anidadas (crear,
// renombrar, mover, borrar), orden, favoritas y recientes, y exportar e importar sin contraseñas. La lógica pura está
// en connTree.ts; aquí, lo que guarda y avisa.
import { api, errorText, isTauri } from "./api";
import {
  allFolders,
  exportConnectionsJson,
  folderName,
  insertAt,
  isInside,
  joinFolder,
  liftDeleted,
  movedFolderPath,
  normalizeFolder,
  parentFolder,
  parseConnectionsJson,
  placeBefore,
  planImport,
  planMove,
  pushRecent,
  renameFolderPath,
  toggleIn,
  uniqueName,
  type ConnSort,
} from "./connTree";
import { confirmDialog, connectionById, disconnect, notify, refreshConnections, saveSettings, setState, state } from "./state";
import { selectionLabel } from "./treeSelect";
import type { ConnConfig, ConnSummary } from "./types";

/** La configuración guardable de una conexión del explorador (sin `hasPassword`; contraseña vacía = la guardada sigue). */
function configOf(conn: ConnSummary): ConnConfig {
  const { hasPassword: _hasPassword, ...cfg } = conn;
  return { ...cfg, password: "" };
}

/** Las carpetas que existen ahora (las de las conexiones y las creadas vacías). */
export function knownFolders(): string[] {
  return allFolders(
    state.connections.map((conn) => conn.folder),
    state.settings.connFolders,
  );
}

// ---------------------------------------------------------------- conexiones

export async function renameConnection(id: string, name: string) {
  const conn = connectionById(id);
  const next = name.trim();
  if (!conn || !next || next === conn.name) return;
  const before = conn.name;
  try {
    await api().saveConnection({ ...configOf(conn), name: next });
    await refreshConnections();
    notify(`«${before}» → «${next}»`, "success", undefined, { label: "Deshacer", run: () => void renameConnection(id, before) });
  } catch (err) {
    notify("No se pudo renombrar la conexión", "error", errorText(err));
  }
}

/** Una copia justo debajo de la original, con la contraseña guardada; devuelve su id. */
export async function duplicateConnectionNow(id: string): Promise<string | null> {
  const conn = connectionById(id);
  if (!conn) return null;
  try {
    const name = uniqueName(`${conn.name} (copia)`, state.connections.map((c) => c.name));
    const copy = await api().duplicateConnection(id, name);
    await refreshConnections();
    const order = state.connections.map((c) => c.id);
    await api().reorderConnections(insertAt(order, copy.id, order.indexOf(id) + 1));
    await refreshConnections();
    notify(`Conexión duplicada: «${name}»`, "success");
    return copy.id;
  } catch (err) {
    notify("No se pudo duplicar la conexión", "error", errorText(err));
    return null;
  }
}

/**
 * Borra una conexión sin preguntar (se puede deshacer desde el aviso): la desconecta antes (lo que se perdería, como
 * una transacción abierta, sí se confirma) y la contraseña queda en memoria para el deshacer.
 */
export async function deleteConnectionUndoable(id: string) {
  const conn = connectionById(id);
  if (!conn) return;
  await disconnect(id, true);
  // Cancelado en la confirmación de desconectar: sigue conectada.
  if (state.sessions[id]) return;
  const cfg = configOf(conn);
  const at = state.connections.findIndex((c) => c.id === id);
  try {
    await api().deleteConnection(id);
    await refreshConnections();
  } catch (err) {
    notify("No se pudo eliminar la conexión", "error", errorText(err));
    return;
  }
  if (state.treeSelected === `c:${id}`) setState("treeSelected", "");
  notify(`Conexión «${conn.name}» eliminada`, "info", undefined, { label: "Deshacer", run: () => void restoreDeleted(cfg, at) });
}

async function restoreDeleted(cfg: ConnConfig, at: number) {
  try {
    const saved = await api().restoreConnection(cfg);
    await refreshConnections();
    const order = state.connections.map((c) => c.id);
    await api().reorderConnections(insertAt(order, saved.id, at));
    await refreshConnections();
    setState("treeSelected", `c:${saved.id}`);
    notify(`Conexión «${saved.name}» recuperada`, "success");
  } catch (err) {
    notify("No se pudo recuperar la conexión", "error", errorText(err));
  }
}

// ---------------------------------------------------------------- carpetas

/** Guarda las conexiones con su nueva carpeta (solo las que cambian) y recarga la lista. */
async function applyFolders(changes: { conn: ConnSummary; folder: string }[]) {
  for (const { conn, folder } of changes) {
    if ((conn.folder || "") === folder) continue;
    await api().saveConnection({ ...configOf(conn), folder });
  }
  await refreshConnections();
}

/** Lo que hace falta para deshacer un cambio de carpetas: la carpeta de cada conexión y los ajustes de antes. */
function folderSnapshot() {
  return {
    conns: state.connections.map((conn) => ({ id: conn.id, folder: conn.folder || "" })),
    connFolders: state.settings.connFolders.slice(),
    collapsedFolders: state.settings.collapsedFolders.slice(),
  };
}

async function putFolders(snapshot: ReturnType<typeof folderSnapshot>) {
  const changes = snapshot.conns.flatMap(({ id, folder }) => {
    const conn = connectionById(id);
    return conn ? [{ conn, folder }] : [];
  });
  await applyFolders(changes);
  await saveSettings({ connFolders: snapshot.connFolders, collapsedFolders: snapshot.collapsedFolders });
}

async function restoreFolders(snapshot: ReturnType<typeof folderSnapshot>) {
  try {
    await putFolders(snapshot);
    notify("Carpetas como estaban", "success");
  } catch (err) {
    notify("No se pudo deshacer", "error", errorText(err));
  }
}

/** Crea una carpeta vacía dentro de `parent` y devuelve su ruta (el explorador la deja lista para renombrar). */
export async function createFolder(parent = ""): Promise<string> {
  const siblings = knownFolders()
    .filter((path) => parentFolder(path) === normalizeFolder(parent))
    .map(folderName);
  const path = joinFolder(parent, uniqueName("Nueva carpeta", siblings));
  const collapsed = state.settings.collapsedFolders.filter((folder) => !(normalizeFolder(parent) && isInside(parent, folder)));
  await saveSettings({ connFolders: [...state.settings.connFolders, path], collapsedFolders: collapsed });
  return path;
}

/**
 * Cambia la ruta de una carpeta (renombrar o mover): sus conexiones y subcarpetas van con ella. Si la nueva ya
 * existe, se juntan.
 */
async function relocateFolder(from: string, to: string, message: string) {
  const source = normalizeFolder(from);
  const target = normalizeFolder(to);
  if (!source || source === target) return;
  if (target && isInside(target, source)) {
    notify("Una carpeta no puede ir dentro de sí misma", "warning");
    return;
  }
  const snapshot = folderSnapshot();
  try {
    await applyFolders(state.connections.map((conn) => ({ conn, folder: renameFolderPath(conn.folder || "", source, target) })));
    const move = (list: string[]) => [...new Set(list.map((folder) => renameFolderPath(folder, source, target)).filter(Boolean))];
    await saveSettings({ connFolders: move(state.settings.connFolders.concat(target ? [target] : [])), collapsedFolders: move(state.settings.collapsedFolders) });
    notify(message, "success", undefined, { label: "Deshacer", run: () => void restoreFolders(snapshot) });
  } catch (err) {
    notify("No se pudo cambiar la carpeta", "error", errorText(err));
  }
}

export async function renameFolder(path: string, name: string) {
  const clean = name.replace(/\//g, "-").trim();
  if (!clean || clean === folderName(path)) return;
  const target = joinFolder(parentFolder(path), clean);
  const merging = knownFolders().includes(target);
  await relocateFolder(path, target, merging ? `«${folderName(path)}» se ha juntado con «${clean}»` : `Carpeta «${folderName(path)}» → «${clean}»`);
}

/** Mueve una carpeta (con todo lo que tiene) dentro de `parent` ("" = la raíz). */
export async function moveFolder(path: string, parent: string) {
  if (normalizeFolder(parentFolder(path)) === normalizeFolder(parent)) return;
  await relocateFolder(path, joinFolder(parent, folderName(path)), `Carpeta «${folderName(path)}» movida a ${parent ? `«${parent}»` : "la raíz"}`);
}

/** Borra una carpeta: sus conexiones y subcarpetas suben a la carpeta de arriba. */
export async function deleteFolder(path: string) {
  const parent = parentFolder(path);
  const snapshot = folderSnapshot();
  const source = normalizeFolder(path);
  try {
    await applyFolders(state.connections.map((conn) => ({ conn, folder: renameFolderPath(conn.folder || "", source, parent) })));
    const lift = (list: string[]) => [...new Set(list.filter((folder) => normalizeFolder(folder) !== source).map((folder) => renameFolderPath(folder, source, parent)).filter(Boolean))];
    await saveSettings({ connFolders: lift(state.settings.connFolders), collapsedFolders: lift(state.settings.collapsedFolders) });
    notify(`Carpeta «${folderName(path)}» eliminada`, "info", parent ? `Su contenido está ahora en «${parent}»` : "Su contenido está ahora en la raíz", { label: "Deshacer", run: () => void restoreFolders(snapshot) });
  } catch (err) {
    notify("No se pudo eliminar la carpeta", "error", errorText(err));
  }
}

export function folderCollapsed(path: string) {
  return state.settings.collapsedFolders.includes(normalizeFolder(path));
}

export function toggleFolder(path: string, open?: boolean) {
  const key = normalizeFolder(path);
  const collapsed = state.settings.collapsedFolders.includes(key);
  const close = open === undefined ? !collapsed : !open;
  if (close === collapsed) return;
  void saveSettings({ collapsedFolders: close ? [...state.settings.collapsedFolders, key] : state.settings.collapsedFolders.filter((folder) => folder !== key) });
}

/** Mueve varias conexiones a una carpeta (soltar en la cabecera de una carpeta, o «Mover a…»). */
export async function moveConnectionsTo(ids: string[], folder: string) {
  const target = normalizeFolder(folder);
  const snapshot = folderSnapshot();
  const conns = ids.map(connectionById).filter((conn): conn is ConnSummary => Boolean(conn));
  if (!conns.length || conns.every((conn) => normalizeFolder(conn.folder || "") === target)) return;
  try {
    await applyFolders(conns.map((conn) => ({ conn, folder: target })));
    const label = conns.length === 1 ? conns[0].name : `${conns.length} conexiones`;
    notify(`${label} → ${target || "Sin carpeta"}`, "success", undefined, { label: "Deshacer", run: () => void restoreFolders(snapshot) });
  } catch (err) {
    notify("No se pudo mover la conexión", "error", errorText(err));
  }
}

// ---------------------------------------------------------------- several at once (multi-selection)

/**
 * Moves a selection of connections and folders into `folder` (dragging it, or its menu), with one undo. Each folder
 * goes with its contents; dropped on a connection (`beforeId`), the moved connections go right above it.
 */
export async function moveItemsTo(ids: string[], folders: string[], folder: string, beforeId?: string) {
  const target = normalizeFolder(folder);
  const plan = planMove(
    state.connections.map((conn) => ({ id: conn.id, folder: conn.folder || "" })),
    ids,
    folders,
    target,
  );
  if (plan.blocked.length) notify("Una carpeta no puede ir dentro de sí misma", "warning", plan.blocked.map((path) => `«${folderName(path)}»`).join(", "));
  const changes = state.connections.flatMap((conn) => (plan.folderOf.has(conn.id) ? [{ conn, folder: plan.folderOf.get(conn.id)! }] : []));
  const before = beforeId ? state.connections.map((conn) => conn.id) : [];
  const order = beforeId ? placeBefore(before, ids, beforeId) : before;
  const reorder = order.some((id, i) => id !== before[i]);
  if (!changes.length && !plan.moves.length && !reorder) return;
  const snapshot = folderSnapshot();
  try {
    await applyFolders(changes);
    if (plan.moves.length) {
      const moved = (list: string[]) => [...new Set(list.map((path) => movedFolderPath(path, plan.moves)).filter(Boolean))];
      await saveSettings({ connFolders: moved([...state.settings.connFolders, ...plan.moves.map(([, to]) => to)]), collapsedFolders: moved(state.settings.collapsedFolders) });
    }
    if (reorder) {
      await api().reorderConnections(placeBefore(state.connections.map((conn) => conn.id), ids, beforeId!));
      await refreshConnections();
    }
    if (changes.length || plan.moves.length) {
      const label = selectionLabel(ids.filter((id) => connectionById(id)).length, plan.moves.length);
      notify(`${label} → ${target || "Sin carpeta"}`, "success", undefined, { label: "Deshacer", run: () => void restoreFolders(snapshot) });
    }
  } catch (err) {
    notify("No se pudo mover la selección", "error", errorText(err));
  }
}

/**
 * Deletes several connections and folders after one confirmation (a single one is deleted without asking, see
 * deleteConnectionUndoable); one undo brings everything back. The contents of a deleted folder go up a level, as with
 * deleteFolder; a connection kept connected in the disconnect confirmation is not deleted.
 */
export async function deleteItems(ids: string[], folders: string[]) {
  const conns = ids.map(connectionById).filter((conn): conn is ConnSummary => Boolean(conn));
  const paths = [...new Set(folders.map(normalizeFolder).filter(Boolean))];
  if (!conns.length && !paths.length) return;
  const names = [...conns.map((conn) => `«${conn.name}»`), ...paths.map((path) => `la carpeta «${folderName(path)}»`)];
  const listed = names.length > 8 ? `${names.slice(0, 8).join(", ")} y ${names.length - 8} más` : names.join(", ");
  const body = `Se eliminarán ${listed}.${paths.length ? " Lo que hay dentro de las carpetas sube un nivel." : ""} Se puede deshacer desde el aviso.`;
  if (!(await confirmDialog(`Eliminar ${selectionLabel(conns.length, paths.length)}`, body, "Eliminar", true))) return;
  const snapshot = folderSnapshot();
  const removed: { cfg: ConnConfig; at: number }[] = [];
  for (const conn of conns) {
    await disconnect(conn.id, true);
    if (state.sessions[conn.id]) continue;
    removed.push({ cfg: configOf(conn), at: snapshot.conns.findIndex((c) => c.id === conn.id) });
  }
  try {
    for (const { cfg } of removed) await api().deleteConnection(cfg.id);
    await refreshConnections();
    if (paths.length) {
      await applyFolders(state.connections.map((conn) => ({ conn, folder: liftDeleted(conn.folder || "", paths) })));
      const lift = (list: string[]) => [...new Set(list.filter((path) => !paths.includes(normalizeFolder(path))).map((path) => liftDeleted(path, paths)).filter(Boolean))];
      await saveSettings({ connFolders: lift(state.settings.connFolders), collapsedFolders: lift(state.settings.collapsedFolders) });
    }
  } catch (err) {
    notify("No se pudo eliminar la selección", "error", errorText(err));
    return;
  }
  if (removed.some(({ cfg }) => state.treeSelected === `c:${cfg.id}`) || paths.some((path) => state.treeSelected === `g:${path}`)) setState("treeSelected", "");
  const label = selectionLabel(removed.length, paths.length);
  notify(`Eliminado: ${label}`, "info", undefined, { label: "Deshacer", run: () => void restoreItems(removed, paths.length ? snapshot : null, label) });
}

async function restoreItems(removed: { cfg: ConnConfig; at: number }[], snapshot: ReturnType<typeof folderSnapshot> | null, label: string) {
  try {
    // In their old order, each one back at its old place.
    for (const { cfg, at } of removed.slice().sort((a, b) => a.at - b.at)) {
      const saved = await api().restoreConnection(cfg);
      await refreshConnections();
      await api().reorderConnections(insertAt(state.connections.map((c) => c.id), saved.id, at));
    }
    await refreshConnections();
    if (snapshot) await putFolders(snapshot);
    notify(`Recuperado: ${label}`, "success");
  } catch (err) {
    notify("No se pudo recuperar la selección", "error", errorText(err));
  }
}

/** Marks or unmarks several connections as favourites at once. */
export function setFavorites(ids: string[], on: boolean) {
  const current = state.settings.favoriteConns;
  const next = on ? [...current, ...ids.filter((id) => !current.includes(id))] : current.filter((id) => !ids.includes(id));
  if (next.length !== current.length) void saveSettings({ favoriteConns: next });
}

// ---------------------------------------------------------------- orden, favoritas, recientes

export function setConnSort(mode: ConnSort) {
  if (state.settings.connSort !== mode) void saveSettings({ connSort: mode });
}

export function isFavorite(id: string) {
  return state.settings.favoriteConns.includes(id);
}

export function toggleFavorite(id: string) {
  void saveSettings({ favoriteConns: toggleIn(state.settings.favoriteConns, id) });
}

export function noteRecent(id: string) {
  void saveSettings({ recentConns: pushRecent(state.settings.recentConns, id, Date.now()) });
}

// ---------------------------------------------------------------- exportar e importar

/** Exporta las conexiones elegidas (todas si `ids` va vacío) a un JSON sin contraseñas. */
export async function exportConnections(ids: string[] = [], title = "conexiones") {
  const chosen = (ids.length ? ids.map(connectionById).filter((conn): conn is ConnSummary => Boolean(conn)) : state.connections).map(configOf);
  if (!chosen.length) {
    notify("No hay conexiones que exportar", "info");
    return;
  }
  const folders = state.settings.connFolders.filter((folder) => !ids.length || chosen.some((conn) => isInside(conn.folder || "", folder) || isInside(folder, conn.folder || "")));
  const text = exportConnectionsJson(chosen, folders, new Date());
  try {
    const picked = await api().pickSavePath([{ name: "Conexiones de Celer (JSON)", extensions: ["json"] }]);
    // En el navegador no hay diálogo de guardar: se descarga con este nombre.
    const path = picked ?? (isTauri() ? null : `celer-${title.replace(/[^\w-]+/g, "-")}.json`);
    if (!path) return;
    await api().writeTextFile(path.toLowerCase().endsWith(".json") ? path : `${path}.json`, text);
    notify(`${chosen.length === 1 ? "1 conexión exportada" : `${chosen.length} conexiones exportadas`} (sin contraseñas)`, "success", path);
  } catch (err) {
    notify("No se pudieron exportar las conexiones", "error", errorText(err));
  }
}

/** Importa un JSON exportado por Celer: ids nuevos, sin contraseñas, sin repetir las que ya existen. */
export async function importConnections() {
  try {
    const path = await api().pickOpenPath([{ name: "Conexiones de Celer (JSON)", extensions: ["json"] }]);
    if (!path) return;
    const { text } = await api().readTextFile(path);
    const file = parseConnectionsJson(text);
    const plan = planImport(state.connections, file.connections);
    for (const cfg of plan.fresh) await api().saveConnection({ ...cfg, id: "", password: "" });
    const folders = file.folders.filter((folder) => !state.settings.connFolders.includes(folder));
    if (folders.length) await saveSettings({ connFolders: [...state.settings.connFolders, ...folders] });
    await refreshConnections();
    const fresh = plan.fresh.length;
    const dup = plan.duplicates.length;
    const text1 = fresh === 1 ? "1 conexión importada" : `${fresh} conexiones importadas`;
    const text2 = dup ? (dup === 1 ? "1 ya existía" : `${dup} ya existían`) : "";
    notify([text1, text2].filter(Boolean).join(", "), fresh ? "success" : "info", fresh ? "Sin contraseñas: Celer las pedirá al conectar." : undefined);
  } catch (err) {
    notify("No se pudieron importar las conexiones", "error", errorText(err));
  }
}
