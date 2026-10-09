// The script library panel (Inspector › Biblioteca): a tree of folders and scripts with search, tags, drag and drop,
// a context menu and keyboard shortcuts. The actions live in library.ts.
import { BookmarkPlus, ChevronRight, CirclePlay, Ellipsis, FileCode2, Folder, FolderOpen, FolderPlus, Pencil, Play, Search, Star, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, Index, on, onMount, Show } from "solid-js";
import { shortcutLabel, withShortcut } from "../commands";
import {
  cancelNaming,
  consoleOf,
  createLibraryFolder,
  deleteLibraryFolder,
  deleteLibraryScript,
  duplicateLibraryScript,
  exportLibrary,
  finishNaming,
  importLibraryFiles,
  insertLibraryScript,
  library,
  libraryDirty,
  loadLibrary,
  moveLibraryFolder,
  moveScriptsToFolder,
  openLibraryScript,
  openRunOn,
  renameLibraryFolder,
  renameLibraryScript,
  revertConsole,
  saveConsoleToScript,
  saveToLibrary,
  setLibrary,
  setLibrarySort,
  setOnlyConn,
  toggleFavorite,
  toggleFolder,
  updateLibraryScript,
  type LibraryScript,
} from "../library";
import {
  allTags,
  buildTree,
  ENGINE_TAGS,
  engineLabel,
  folderName,
  inFolder,
  paramRows,
  paramsToKeep,
  parentFolder,
  statementCount,
  toggleTagInQuery,
  type EngineTag,
  type LibraryRow,
  type ScriptParam,
} from "../libraryModel";
import { activeSql, activeTab, confirmDialog, connColor, connectionById, copyText, kindOf, openMenu, state, type MenuItem } from "../state";

const SCRIPT_MIME = "application/x-celer-script";
const FOLDER_MIME = "application/x-celer-folder";

export function relative(at: number) {
  const diff = Date.now() - at;
  if (diff < 60_000) return "ahora";
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`;
  return new Date(at).toLocaleDateString();
}

/** First meaningful line of a script, for the row under its name. */
function preview(sql: string) {
  const line = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("--"));
  return (line ?? sql.trim()).slice(0, 160);
}

export function LibraryView() {
  let tree: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal("");
  onMount(() => void loadLibrary());

  createEffect(
    on(
      () => library.focusSearch,
      (n) => {
        if (n) queueMicrotask(() => search?.focus());
      },
    ),
  );

  /** The connection of the active tab (for "only this connection" and "associate"). */
  const currentConn = () => activeTab()?.connId ?? null;

  const rows = createMemo(() =>
    buildTree(
      { scripts: library.scripts, folders: library.folders },
      {
        query: library.query,
        sort: library.sort,
        collapsed: new Set(library.collapsed),
        connId: library.onlyConn && currentConn() ? currentConn() : undefined,
        pinned: true,
      },
    ),
  );
  /** The rows the keyboard moves through (section titles are not stops). */
  const stops = createMemo(() => rows().filter((row): row is Exclude<LibraryRow, { kind: "section" }> => row.kind !== "section"));
  const tags = createMemo(() => allTags(library.scripts));
  const activeTags = createMemo(() => new Set(library.query.toLowerCase().split(/\s+/).filter((t) => t.startsWith("#")).map((t) => t.slice(1))));

  const select = (key: string) => setLibrary("selected", key);
  const focusTree = () => queueMicrotask(() => tree?.focus());

  function rowEl(key: string) {
    return tree?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null;
  }

  function reveal(key: string) {
    queueMicrotask(() => rowEl(key)?.scrollIntoView({ block: "nearest" }));
  }

  // ------------------------------------------------------------ menus

  function scriptMenu(script: LibraryScript): MenuItem[] {
    const dirty = libraryDirty(script.id);
    const conn = currentConn();
    const connName = connectionById(conn)?.name;
    const count = statementCount(script.sql, kindOf(script.connId ?? conn));
    return [
      { label: "Abrir", hint: "Intro", run: () => void openLibraryScript(script.id) },
      { label: count > 1 ? `Abrir y ejecutar todo (${count} sentencias)` : "Abrir y ejecutar", hint: "Ctrl+Intro", run: () => void openLibraryScript(script.id, true) },
      { label: "Ejecutar en…", hint: "Mayús+Intro", disabled: !state.connections.length, run: () => openRunOn(script.id) },
      { label: "Insertar en la consola", disabled: !activeSql(), run: () => insertLibraryScript(script.id) },
      { label: script.favorite ? "Quitar de favoritos" : "Añadir a favoritos", run: () => void toggleFavorite(script.id) },
      { separator: true },
      ...(dirty
        ? [
            { label: "Guardar los cambios de la consola", hint: shortcutLabel("save-library"), run: () => void saveConsoleToScript(script.id) },
            { label: "Descartar los cambios de la consola", run: () => revertConsole(script.id) },
            { separator: true },
          ]
        : []),
      { label: "Renombrar", hint: "F2", run: () => setLibrary("renaming", `s:${script.id}`) },
      { label: "Detalles: descripción, parámetros, motor…", hint: "Alt+Intro", run: () => setLibrary("editing", script.id) },
      { label: "Duplicar", hint: "Ctrl+D", run: () => void duplicateLibraryScript(script.id) },
      ...(script.folder ? [{ label: "Sacar de la carpeta", run: () => void moveScriptsToFolder([script.id], "") }] : []),
      conn && conn !== script.connId
        ? { label: `Asociar a «${connName ?? "la conexión activa"}»`, run: () => void updateLibraryScript(script.id, { connId: conn }) }
        : { label: "Asociar a la conexión activa", disabled: true },
      ...(script.connId ? [{ label: "Quitar la conexión asociada", run: () => void updateLibraryScript(script.id, { connId: null }) }] : []),
      { separator: true },
      { label: "Copiar el SQL", hint: "Ctrl+C", run: () => void copyText(script.sql, "SQL copiado") },
      { label: "Exportar a .sql…", run: () => void exportLibrary({ scriptId: script.id }) },
      { separator: true },
      { label: "Borrar", hint: "Supr", danger: true, run: () => void deleteLibraryScript(script.id) },
    ];
  }

  function folderMenu(folder: string, open: boolean): MenuItem[] {
    return [
      { label: "Guardar aquí la consola", disabled: !activeSql(), run: () => saveHere(folder) },
      { label: "Nueva subcarpeta", run: () => void createLibraryFolder(folder) },
      { label: "Importar .sql aquí…", run: () => { select(`f:${folder}`); void importLibraryFiles(); } },
      { separator: true },
      { label: "Renombrar", hint: "F2", run: () => setLibrary("renaming", `f:${folder}`) },
      { label: open ? "Contraer" : "Expandir", hint: open ? "←" : "→", run: () => toggleFolder(folder) },
      ...(parentFolder(folder) ? [{ label: "Mover al nivel superior", run: () => void moveLibraryFolder(folder, "") }] : []),
      { label: "Exportar la carpeta a .sql…", run: () => void exportLibrary({ folder }) },
      { separator: true },
      { label: "Borrar la carpeta…", hint: "Supr", danger: true, run: () => void removeFolderAsked(folder) },
    ];
  }

  function generalMenu(): MenuItem[] {
    return [
      { label: "Nueva carpeta", run: () => void createLibraryFolder("") },
      { label: "Importar ficheros .sql…", run: () => { select(""); void importLibraryFiles(); } },
      { label: "Exportar toda la biblioteca a .sql…", disabled: !library.scripts.length, run: () => void exportLibrary({ folder: "" }) },
      { separator: true },
      { label: `${library.sort === "name" ? "✓ " : ""}Ordenar por nombre`, run: () => setLibrarySort("name") },
      { label: `${library.sort === "recent" ? "✓ " : ""}Ordenar por uso reciente`, run: () => setLibrarySort("recent") },
      { label: `${library.onlyConn ? "✓ " : ""}Solo los de la conexión activa`, run: () => setOnlyConn(!library.onlyConn) },
    ];
  }

  function saveHere(folder: string) {
    select(`f:${folder}`);
    void saveToLibrary(true, folder);
  }

  async function removeFolderAsked(folder: string) {
    const count = library.scripts.filter((s) => s.folder && inFolder(s.folder, folder)).length;
    if (count && !(await confirmDialog("Borrar la carpeta", `Se borran «${folderName(folder)}», sus subcarpetas y ${count === 1 ? "el script que contiene" : `los ${count} scripts que contienen`}. Podrás deshacerlo desde el aviso.`, "Borrar", true))) return;
    await deleteLibraryFolder(folder);
    focusTree();
  }

  /** The context menu of a row, from the mouse or from the keyboard (placed under the row). */
  function menuFor(row: LibraryRow, event?: MouseEvent) {
    if (row.kind === "section") return;
    select(row.key);
    const items = row.kind === "script" ? scriptMenu(row.script) : folderMenu(row.path, row.open);
    if (event) openMenu(event, items);
    else {
      const box = rowEl(row.key)?.getBoundingClientRect();
      openMenu(new MouseEvent("contextmenu", { clientX: (box?.left ?? 0) + 24, clientY: box?.bottom ?? 0 }), items);
    }
  }

  // ------------------------------------------------------------ keyboard

  function onKey(event: KeyboardEvent) {
    if (event.target instanceof Element && event.target.closest("input, select, textarea, button.library-inline")) return;
    const list = stops();
    if (!list.length) return;
    const index = list.findIndex((row) => row.key === library.selected);
    const row = index >= 0 ? list[index] : undefined;
    const ctrl = event.ctrlKey || event.metaKey;
    const go = (to: number) => {
      const next = list[Math.max(0, Math.min(list.length - 1, to))];
      select(next.key);
      reveal(next.key);
    };
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        go(index < 0 ? 0 : index + 1);
        break;
      case "ArrowUp":
        go(index < 0 ? 0 : index - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(list.length - 1);
        break;
      case "ArrowRight":
        if (row?.kind === "folder") {
          if (!row.open) toggleFolder(row.path, true);
          else go(index + 1);
        }
        break;
      case "ArrowLeft":
        if (row?.kind === "folder" && row.open) toggleFolder(row.path, false);
        else if (row) {
          const parent = row.kind === "folder" ? parentFolder(row.path) : row.script.folder;
          if (parent) {
            select(`f:${parent}`);
            reveal(`f:${parent}`);
          }
        }
        break;
      case "Enter":
        if (!row) handled = false;
        else if (row.kind === "folder") toggleFolder(row.path);
        else if (row.kind === "script" && event.altKey) setLibrary("editing", row.script.id);
        else if (row.kind === "script" && event.shiftKey) openRunOn(row.script.id);
        else if (row.kind === "script") void openLibraryScript(row.script.id, ctrl);
        break;
      case "F2":
        if (row) setLibrary("renaming", row.key);
        break;
      case "Delete":
        if (row?.kind === "script") {
          // The selection moves to the next row, so Supr can be pressed again.
          const next = list[index + 1] ?? list[index - 1];
          void deleteLibraryScript(row.script.id);
          if (next) select(next.key);
        } else if (row) void removeFolderAsked(row.path);
        break;
      case "ContextMenu":
        if (row) menuFor(row);
        break;
      default:
        handled = false;
    }
    if (!handled && row) {
      handled = true;
      if (event.key === "F10" && event.shiftKey) menuFor(row);
      else if (ctrl && event.key.toLowerCase() === "d" && row.kind === "script") void duplicateLibraryScript(row.script.id);
      else if (ctrl && event.key.toLowerCase() === "c" && row.kind === "script") void copyText(row.script.sql, "SQL copiado");
      else handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // ------------------------------------------------------------ drag and drop

  const dragKind = (event: DragEvent) => {
    const types = event.dataTransfer?.types ?? [];
    return types.includes(SCRIPT_MIME) ? "script" : types.includes(FOLDER_MIME) ? "folder" : null;
  };

  /** Over a folder: into it; over a script: into its folder; elsewhere in the list: the top level. */
  function over(event: DragEvent, folder: string) {
    if (!dragKind(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDropTarget(folder);
  }

  function drop(event: DragEvent, folder: string) {
    const kind = dragKind(event);
    setDropTarget(null);
    setDragging("");
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    if (kind === "script") {
      const id = event.dataTransfer?.getData(SCRIPT_MIME);
      if (id) void moveScriptsToFolder([id], folder);
    } else {
      const from = event.dataTransfer?.getData(FOLDER_MIME);
      if (from && from !== folder) void moveLibraryFolder(from, folder);
    }
  }

  const endDrag = () => {
    setDropTarget(null);
    setDragging("");
  };

  // ------------------------------------------------------------ rows

  function FolderRow(props: { row: Extract<LibraryRow, { kind: "folder" }> }) {
    const row = () => props.row;
    const renaming = () => library.renaming === row().key;
    return (
      <div
        class="lib-row folder"
        classList={{ selected: library.selected === row().key, "drop-into": dropTarget() === row().path, dragging: dragging() === row().key }}
        style={{ "padding-left": `${6 + row().depth * 14}px` }}
        data-key={row().key}
        role="treeitem"
        aria-level={row().depth + 1}
        aria-expanded={row().open}
        aria-selected={library.selected === row().key}
        draggable={!renaming()}
        onDragStart={(event) => {
          event.dataTransfer?.setData(FOLDER_MIME, row().path);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          setDragging(row().key);
        }}
        onDragEnd={endDrag}
        onDragOver={(event) => over(event, row().path)}
        onDrop={(event) => drop(event, row().path)}
        onClick={() => {
          select(row().key);
          if (!renaming()) toggleFolder(row().path);
        }}
        onContextMenu={(event) => menuFor(row(), event)}
      >
        <span class="lib-chevron" classList={{ open: row().open }}><ChevronRight size={12} /></span>
        <span class="lib-icon folder"><Show when={row().open} fallback={<Folder size={14} />}><FolderOpen size={14} /></Show></span>
        <Show when={renaming()} fallback={<span class="lib-name">{row().name}</span>}>
          <InlineName value={row().name} onDone={(name) => void (name !== null && renameLibraryFolder(row().path, name))} />
        </Show>
        <span class="lib-count">{row().count || ""}</span>
      </div>
    );
  }

  function ScriptRow(props: { row: Extract<LibraryRow, { kind: "script" }> }) {
    const script = () => props.row.script;
    const key = () => props.row.key;
    const renaming = () => library.renaming === key();
    const conn = () => connectionById(script().connId);
    const isOpen = () => activeSql()?.libraryId === script().id;
    const dirty = () => libraryDirty(script().id);
    const runAllTitle = () => {
      const n = statementCount(script().sql, kindOf(script().connId ?? currentConn()));
      return n > 1 ? `Abrir y ejecutar todo: las ${n} sentencias (Ctrl+Intro). Para una sola, ábrelo y usa Ctrl+Intro en ella` : "Abrir y ejecutar (Ctrl+Intro)";
    };
    return (
      <>
        <div
          class="lib-row script"
          classList={{ selected: library.selected === key(), open: isOpen(), dragging: dragging() === key() }}
          style={{ "padding-left": `${6 + props.row.depth * 14 + 12}px` }}
          data-key={key()}
          role="treeitem"
          aria-level={props.row.depth + 1}
          aria-selected={library.selected === key()}
          title={`${script().name}${script().description ? `\n${script().description}` : ""}\n\n${script().sql.slice(0, 600)}${script().sql.length > 600 ? "…" : ""}\n\nClic: abrir · Ctrl+Intro: abrir y ejecutar · Mayús+Intro: ejecutar en… · Arrástralo al editor para pegar su SQL`}
          draggable={!renaming()}
          onDragStart={(event) => {
            event.dataTransfer?.setData(SCRIPT_MIME, script().id);
            // Dropped on the editor, it pastes the SQL there.
            event.dataTransfer?.setData("text/plain", script().sql);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
            setDragging(key());
          }}
          onDragEnd={endDrag}
          onDragOver={(event) => over(event, script().folder)}
          onDrop={(event) => drop(event, script().folder)}
          onClick={(event) => {
            select(key());
            if (!renaming() && !(event.target instanceof Element && event.target.closest(".lib-actions"))) void openLibraryScript(script().id);
          }}
          onContextMenu={(event) => menuFor(props.row, event)}
        >
          <span class="lib-icon script"><FileCode2 size={14} /></span>
          <div class="lib-main">
            <div class="lib-title">
              <Show when={renaming()} fallback={<span class="lib-name">{script().name}</span>}>
                <InlineName value={script().name} onDone={(name) => void (name !== null && renameLibraryScript(script().id, name))} />
              </Show>
              <Show when={script().favorite}>
                <span class="lib-star" title="Favorito"><Star size={11} fill="currentColor" /></span>
              </Show>
              <Show when={dirty()}>
                <i class="lib-dirty" title="La consola tiene cambios sin guardar en la biblioteca" />
              </Show>
            </div>
            <Show when={script().description}>
              <span class="lib-desc">{script().description}</span>
            </Show>
            <code class="lib-preview">{preview(script().sql)}</code>
            <Show when={conn() || script().tags.length || script().engine}>
              <div class="lib-meta">
                <Show when={script().engine}>
                  <span class="lib-engine" title="Motor para el que está escrito">{engineLabel(script().engine!)}</span>
                </Show>
                <Show when={conn()}>
                  <span class="lib-conn" title="Conexión asociada: se abre en ella"><i style={{ background: connColor(conn()) }} />{conn()!.name}</span>
                </Show>
                <For each={script().tags}>
                  {(tag) => (
                    <button
                      type="button"
                      class="lib-tag small"
                      classList={{ on: activeTags().has(tag.toLowerCase()) }}
                      title={`Filtrar por #${tag}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setLibrary("query", toggleTagInQuery(library.query, tag));
                      }}
                    >
                      #{tag}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="lib-actions">
            <Show when={dirty()}>
              <button type="button" class="icon-btn" title={withShortcut("Guardar los cambios de la consola", "save-library")} onClick={() => void saveConsoleToScript(script().id)}><BookmarkPlus size={13} /></button>
            </Show>
            <button type="button" class="icon-btn" title={runAllTitle()} onClick={() => void openLibraryScript(script().id, true)}><Play size={13} /></button>
            <button type="button" class="icon-btn" title="Ejecutar en… otra conexión o base de datos, o en varias (Mayús+Intro)" disabled={!state.connections.length} onClick={() => openRunOn(script().id)}><CirclePlay size={13} /></button>
            <button type="button" class="icon-btn" classList={{ on: script().favorite }} title={script().favorite ? "Quitar de favoritos" : "Añadir a favoritos"} onClick={() => void toggleFavorite(script().id)}><Star size={13} /></button>
            <button type="button" class="icon-btn" title="Detalles: descripción, parámetros, motor, carpeta, etiquetas y conexión (Alt+Intro)" onClick={() => setLibrary("editing", library.editing === script().id ? "" : script().id)}><Pencil size={13} /></button>
            <button type="button" class="icon-btn" title="Más acciones" onClick={(event) => menuFor(props.row, event)}><Ellipsis size={13} /></button>
          </div>
        </div>
        <Show when={library.editing === script().id && library.selected === key()}>
          <ScriptDetails script={script()} depth={props.row.depth} />
        </Show>
      </>
    );
  }

  const count = () => library.scripts.length;
  const shown = () => rows().filter((row) => row.kind === "script" && !row.section).length;

  return (
    <div class="library">
      <Show when={library.naming}>
        {(naming) => (
          <form
            class="library-name"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void finishNaming(data.get("name") as string, data.get("folder") as string);
            }}
          >
            <label for="library-name">Nombre del script</label>
            <input
              id="library-name"
              name="name"
              value={naming().name}
              ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  cancelNaming();
                }
              }}
            />
            <label for="library-folder">Carpeta</label>
            <FolderInput id="library-folder" name="folder" value={naming().folder} />
            <div class="library-name-row">
              <span class="spacer" />
              <button type="submit" class="btn primary tiny">Guardar</button>
              <button type="button" class="btn tiny" onClick={cancelNaming}>Cancelar</button>
            </div>
          </form>
        )}
      </Show>
      <div class="record-head">
        <div class="mini-search grow">
          <Search size={12} />
          <input
            ref={search}
            placeholder="Buscar: nombre, SQL, descripción o #etiqueta"
            value={library.query}
            onInput={(event) => setLibrary("query", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && library.query) {
                event.stopPropagation();
                setLibrary("query", "");
              } else if (event.key === "ArrowDown") {
                // From the search into the results.
                event.preventDefault();
                const first = stops().find((row) => row.kind === "script") ?? stops()[0];
                if (first) select(first.key);
                tree?.focus();
              } else if (event.key === "Enter") {
                const first = rows().find((row) => row.kind === "script");
                if (first?.kind === "script") void openLibraryScript(first.script.id, event.ctrlKey || event.metaKey);
              }
            }}
          />
          <Show when={library.query}>
            <button type="button" class="icon-btn tiny" title="Limpiar la búsqueda" onClick={() => setLibrary("query", "")}><X size={11} /></button>
          </Show>
        </div>
        <button type="button" class="icon-btn" title="Nueva carpeta" onClick={() => void createLibraryFolder()}><FolderPlus size={14} /></button>
        <button type="button" class="icon-btn" title={withShortcut("Guardar la consola actual en la biblioteca", "save-library")} disabled={!activeSql()} onClick={() => void saveToLibrary()}><BookmarkPlus size={14} /></button>
        <button type="button" class="icon-btn" title="Importar, exportar y ordenar" onClick={(event) => openMenu(event, generalMenu())}><Ellipsis size={14} /></button>
      </div>
      <Show when={tags().length || library.onlyConn}>
        <div class="lib-filters">
          <Show when={library.onlyConn}>
            <button type="button" class="lib-tag on" title="Mostrar los de todas las conexiones" onClick={() => setOnlyConn(false)}>
              {connectionById(currentConn())?.name ?? "Sin conexión activa"} <X size={10} />
            </button>
          </Show>
          <For each={tags().slice(0, 16)}>
            {(item) => (
              <button type="button" class="lib-tag" classList={{ on: activeTags().has(item.tag.toLowerCase()) }} onClick={() => setLibrary("query", toggleTagInQuery(library.query, item.tag))}>
                #{item.tag}
                <small>{item.count}</small>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div
        class="lib-tree"
        classList={{ "drop-root": dropTarget() === "" }}
        ref={tree}
        role="tree"
        aria-label="Biblioteca de scripts"
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => {
          if (!library.selected && stops().length) select(stops()[0].key);
        }}
        onDragOver={(event) => over(event, "")}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node && tree?.contains(event.relatedTarget))) setDropTarget(null);
        }}
        onDrop={(event) => drop(event, "")}
        onContextMenu={(event) => {
          if (event.target === tree) openMenu(event, generalMenu());
        }}
      >
        <Show when={library.loaded && !count() && !library.folders.length}>
          <div class="inspector-empty lib-empty">
            <p>
              La biblioteca está vacía. Guarda aquí las consultas que repites
              {shortcutLabel("save-library") ? ` con ${shortcutLabel("save-library")}` : " con el botón de arriba"} desde la consola.
            </p>
            <div class="lib-empty-actions">
              <button type="button" class="btn tiny primary" disabled={!activeSql()?.sql.trim()} onClick={() => void saveToLibrary()}>Guardar la consola</button>
              <button type="button" class="btn tiny" onClick={() => void importLibraryFiles()}>Importar .sql…</button>
            </div>
          </div>
        </Show>
        <Show when={(count() || library.folders.length) && !rows().length}>
          <p class="inspector-empty">Ningún script coincide con la búsqueda.</p>
        </Show>
        <For each={rows()}>
          {(row) =>
            row.kind === "folder" ? (
              <FolderRow row={row} />
            ) : row.kind === "section" ? (
              <div class="lib-section" role="presentation">
                {row.label}
                <small>{row.count}</small>
              </div>
            ) : (
              <ScriptRow row={row} />
            )
          }
        </For>
      </div>
      <Show when={count()}>
        <div class="lib-foot">
          {shown() === count() ? `${count()} ${count() === 1 ? "script" : "scripts"}` : `${shown()} de ${count()} scripts`}
          <span class="spacer" />
          <span title="Intro abre · Ctrl+Intro ejecuta todo · Mayús+Intro: ejecutar en… · F2 renombra · Supr borra · Ctrl+D duplica · clic derecho: todo lo demás">Intro · Ctrl+Intro · Mayús+Intro · F2</span>
        </div>
      </Show>
    </div>
  );
}

/** Rename in place: Enter or leaving the field keeps it, Escape gives null. */
function InlineName(props: { value: string; onDone: (name: string | null) => void }) {
  let done = false;
  const finish = (name: string | null) => {
    if (done) return;
    done = true;
    setLibrary("renaming", "");
    props.onDone(name);
    queueMicrotask(() => document.querySelector<HTMLElement>(".lib-tree")?.focus());
  };
  return (
    <input
      class="lib-rename"
      value={props.value}
      ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

/** A folder field with the existing folders to pick from. */
function FolderInput(props: { id: string; name: string; value: string }) {
  return (
    <>
      <input id={props.id} name={props.name} value={props.value} list={`${props.id}-list`} placeholder="Sin carpeta (por ejemplo: Informes/Mensuales)" />
      <datalist id={`${props.id}-list`}>
        <For each={library.folders}>{(folder) => <option value={folder} />}</For>
      </datalist>
    </>
  );
}

/** Name, description, folder, tags, connection, engine and parameters of a script, under its row. */
function ScriptDetails(props: { script: LibraryScript; depth: number }) {
  const id = `lib-edit-${props.script.id}`;
  // The parameters of the SQL (and the declared ones it no longer has), edited here and kept on "Guardar".
  const dialect = () => kindOf(props.script.connId ?? activeTab()?.connId);
  const [params, setParams] = createSignal(paramRows(props.script.sql, props.script.params, dialect()));
  const setParam = (index: number, change: Partial<ScriptParam>) => setParams((list) => list.map((p, i) => (i === index ? { ...p, ...change } : p)));
  const close = () => {
    setLibrary("editing", "");
    queueMicrotask(() => document.querySelector<HTMLElement>(".lib-tree")?.focus());
  };
  return (
    <form
      class="lib-details"
      style={{ "margin-left": `${10 + props.depth * 14}px` }}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void updateLibraryScript(props.script.id, {
          name: data.get("name") as string,
          folder: data.get("folder") as string,
          tags: data.get("tags") as string,
          connId: (data.get("connId") as string) || null,
          description: data.get("description") as string,
          engine: (data.get("engine") as EngineTag | "") ?? "",
          params: paramsToKeep(params()),
        });
        close();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") close();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <label for={`${id}-name`}>Nombre</label>
      <input id={`${id}-name`} name="name" value={props.script.name} ref={(el) => queueMicrotask(() => el.focus())} />
      <label for={`${id}-desc`}>Descripción</label>
      <textarea id={`${id}-desc`} name="description" rows={2} value={props.script.description ?? ""} placeholder="Qué hace y cuándo usarlo (opcional)" />
      <label for={`${id}-folder`}>Carpeta</label>
      <FolderInput id={`${id}-folder`} name="folder" value={props.script.folder} />
      <label for={`${id}-tags`}>Etiquetas</label>
      <input id={`${id}-tags`} name="tags" value={props.script.tags.join(", ")} placeholder="Separadas por comas: ventas, mensual" />
      <label for={`${id}-conn`}>Conexión</label>
      <select id={`${id}-conn`} name="connId" value={props.script.connId ?? ""}>
        <option value="">Ninguna: la de la consola activa</option>
        <For each={state.connections}>{(conn) => <option value={conn.id} selected={conn.id === props.script.connId}>{conn.name}{conn.production ? " (producción)" : ""}</option>}</For>
        <Show when={props.script.connId && !connectionById(props.script.connId)}>
          <option value={props.script.connId!} selected>Conexión borrada</option>
        </Show>
      </select>
      <label for={`${id}-engine`}>Motor</label>
      <select id={`${id}-engine`} name="engine" value={props.script.engine ?? ""}>
        <option value="">Sin indicar</option>
        <For each={ENGINE_TAGS}>{(tag) => <option value={tag} selected={tag === props.script.engine}>{engineLabel(tag)}</option>}</For>
      </select>
      <Show when={params().length}>
        <div class="lib-params">
          <label>Parámetros: valor por defecto y descripción</label>
          <Index each={params()}>
            {(param, index) => (
              <div class="lib-param">
                <code classList={{ unused: !param().used }} title={param().used ? param().name : `${param().name}: ya no aparece en el SQL (se borra si lo dejas vacío)`}>
                  {param().name}
                </code>
                <input value={param().default} placeholder="Por defecto" spellcheck={false} aria-label={`Valor por defecto de ${param().name}`} onInput={(event) => setParam(index, { default: event.currentTarget.value })} />
                <input value={param().description} placeholder="Qué es" aria-label={`Descripción de ${param().name}`} onInput={(event) => setParam(index, { description: event.currentTarget.value })} />
              </div>
            )}
          </Index>
        </div>
      </Show>
      <div class="library-name-row">
        <Show when={consoleOf(props.script.id)}>
          <small class="muted">Edita el SQL en su consola y guárdalo con {shortcutLabel("save-library") || "el botón de guardar"}.</small>
        </Show>
        <span class="spacer" />
        <button type="submit" class="btn primary tiny">Guardar</button>
        <button type="button" class="btn tiny" onClick={close}>Cancelar</button>
      </div>
    </form>
  );
}
