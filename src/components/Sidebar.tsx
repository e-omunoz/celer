import { ChevronRight, ChevronsDownUp, Plus, RefreshCw, Search, X } from "lucide-solid";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { EngineIcon, ObjIcon } from "../icons";
import { Gib } from "../gib/Gib";
import {
  collapseAll,
  connColor,
  connect,
  copySchemaForAi,
  copyText,
  disconnect,
  duplicateConnection,
  generateSql,
  kindOf,
  moveConnection,
  openConnDialog,
  openMenu,
  openQuery,
  openTable,
  pathKey,
  refreshNode,
  removeConnection,
  serverOf,
  setState,
  startObjectExport,
  state,
  toggleConnection,
  toggleNode,
} from "../state";
import type { ConnSummary, MetaNode } from "../types";
import { startImport } from "../importer";
import { engineOf } from "../types";

const ROW = 24;

// Drag and drop of connections between folders (and to reorder them).
const CONN_MIME = "application/x-celer-connection";
const [dropOver, setDropOver] = createSignal<string | null>(null);
const [dragging, setDragging] = createSignal<string | null>(null);
function acceptConnDrop(event: DragEvent, key: string) {
  if (!event.dataTransfer?.types.includes(CONN_MIME)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  setDropOver(key);
}
function dropConn(event: DragEvent, folder: string, beforeId?: string) {
  const id = event.dataTransfer?.getData(CONN_MIME);
  setDropOver(null);
  setDragging(null);
  if (!id) return;
  event.preventDefault();
  void moveConnection(id, folder, beforeId);
}

type Row =
  | { type: "group"; key: string; name: string; depth: 0 }
  | { type: "conn"; key: string; conn: ConnSummary; depth: number }
  | { type: "node"; key: string; connId: string; node: MetaNode; depth: number }
  | { type: "status"; key: string; text: string; depth: number; error?: boolean };

export function Sidebar() {
  let scroller: HTMLDivElement | undefined;
  let filterInput: HTMLInputElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [filterOpen, setFilterOpen] = createSignal(false);

  const rows = createMemo<Row[]>((previous) => {
    const fresh = buildRows();
    // Reuse row objects that did not change so <For> keeps their DOM nodes (and double-clicks land).
    const old = new Map((previous ?? []).map((row) => [row.key, row]));
    return fresh.map((row) => {
      const before = old.get(row.key);
      if (!before || before.type !== row.type || before.depth !== row.depth) return row;
      if (row.type === "node" && before.type === "node" && before.node === row.node) return before;
      if (row.type === "conn" && before.type === "conn" && before.conn === row.conn) return before;
      if (row.type === "group" || (row.type === "status" && before.type === "status" && before.text === row.text)) return before;
      return row;
    });
  });

  function buildRows(): Row[] {
    const filter = state.treeFilter.trim().toLowerCase();
    const out: Row[] = [];
    const groups = new Map<string, ConnSummary[]>();
    for (const conn of state.connections) {
      const folder = conn.folder || "";
      groups.set(folder, [...(groups.get(folder) ?? []), conn]);
    }
    const grouped = groups.size > 1 || (groups.size === 1 && !groups.has(""));
    for (const [folder, conns] of groups) {
      const base = grouped ? 1 : 0;
      if (grouped) out.push({ type: "group", key: `g:${folder}`, name: folder || "Sin carpeta", depth: 0 });
      for (const conn of conns) {
        const rootKey = pathKey(conn.id, []);
        const root = state.tree[rootKey];
        const children: Row[] = [];
        if (state.sessions[conn.id] && root?.open) {
          walk(conn.id, root.nodes, base + 1, filter, children);
          if (root.status === "loading" && !root.nodes.length) children.push({ type: "status", key: `${rootKey}:s`, text: "Cargando…", depth: base + 1 });
          if (root.status === "error") children.push({ type: "status", key: `${rootKey}:e`, text: root.error ?? "Error", depth: base + 1, error: true });
        }
        const selfMatch = !filter || conn.name.toLowerCase().includes(filter);
        if (!selfMatch && !children.length) continue;
        out.push({ type: "conn", key: `c:${conn.id}`, conn, depth: base });
        out.push(...children);
      }
    }
    // While dragging, offer "Sin carpeta" as a target even when every connection is in a folder.
    if (dragging() && grouped && !groups.has("")) out.push({ type: "group", key: "g:", name: "Sin carpeta", depth: 0 });
    return out;
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

  function activate(row: Row) {
    if (row.type === "conn") {
      if (!state.sessions[row.conn.id]) void connect(row.conn.id);
      else toggleConnection(row.conn.id);
    }
    if (row.type === "node") {
      const obj = row.node.obj;
      if (obj && (obj.kind === "table" || obj.kind === "view")) void openTable(row.connId, obj);
      else if (obj && (obj.kind === "procedure" || obj.kind === "function" || obj.kind === "trigger")) void generateSql(row.connId, obj, "ddl");
      else void toggleNode(row.connId, row.node);
    }
  }

  function onKey(event: KeyboardEvent) {
    const list = rows();
    if (!list.length) return;
    let index = selectedIndex();
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
    if (event.key === "Enter" || event.key === "F4") {
      event.preventDefault();
      activate(row);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.type === "conn") {
        if (!state.sessions[row.conn.id]) void connect(row.conn.id);
        else if (!state.tree[pathKey(row.conn.id, [])]?.open) toggleConnection(row.conn.id, true);
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
      const open = row.type === "conn" ? state.tree[pathKey(row.conn.id, [])]?.open : row.type === "node" && !row.node.leaf ? state.tree[pathKey(row.connId, row.node.path)]?.open : false;
      if (open) {
        if (row.type === "conn") toggleConnection(row.conn.id, false);
        if (row.type === "node") void toggleNode(row.connId, row.node, false);
        return;
      }
      for (let i = index - 1; i >= 0; i--) {
        if (list[i].depth < row.depth) return go(i);
      }
      return;
    }
    if (event.key === "Delete" && row.type === "conn") {
      event.preventDefault();
      void removeConnection(row.conn.id);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && row.type === "node") {
      event.preventDefault();
      void copyText(row.node.name);
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
      { label: "Nueva consola", hint: "Ctrl+Mayús+L", icon: "console", run: () => openQuery(conn.id) },
      connected ? { label: "Desconectar", icon: "unplug", run: () => void disconnect(conn.id) } : { label: "Conectar", icon: "plug", run: () => void connect(conn.id) },
      { label: "Actualizar", hint: "Ctrl+F5", icon: "refresh", disabled: !connected, run: () => void refreshNode(conn.id, []) },
      { separator: true },
      { label: "Propiedades…", hint: "F4", icon: "settings", run: () => openConnDialog(conn) },
      { label: "Duplicar", run: () => void duplicateConnection(conn.id) },
      { label: "Copiar nombre", run: () => void copyText(conn.name) },
      { label: "Copiar esquema para IA", disabled: !connected, run: () => void copySchemaForAi(conn.id) },
      { separator: true },
      { label: "Eliminar conexión", hint: "Supr", icon: "trash", danger: true, run: () => void removeConnection(conn.id) },
    ]);
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
        { label: `Generar DROP ${obj.kind === "view" ? "VIEW" : "TABLE"}`, run: () => void generateSql(connId, obj, "drop") },
        { label: "DDL en consola", run: () => void generateSql(connId, obj, "ddl") },
        { separator: true },
        { label: "Exportar datos…", icon: "download", run: () => void startObjectExport(connId, obj) },
        ...(obj.kind === "table" ? [{ label: "Importar CSV…", icon: "upload", run: () => void startImport(connId, obj) }] : []),
        { label: "Copiar estructura para IA", icon: "ai", run: () => void copySchemaForAi(connId, obj) },
        { separator: true },
      );
    } else if (obj) {
      items.push({ label: "Abrir definición", icon: "code", run: () => void generateSql(connId, obj, "ddl") }, { separator: true });
    }
    items.push(
      { label: "Nueva consola aquí", icon: "console", run: () => openQuery(connId) },
      { label: "Copiar nombre", hint: "Ctrl+C", icon: "copy", run: () => void copyText(node.name) },
    );
    if (obj) items.push({ label: "Copiar nombre completo", run: () => void copyText([obj.schema, obj.name].filter(Boolean).join(".")) });
    if (!node.leaf) items.push({ separator: true }, { label: "Actualizar", icon: "refresh", run: () => void refreshNode(connId, node.path) });
    openMenu(event, items);
  }

  return (
    <aside class="explorer" style={{ width: `${state.settings.sidebarWidth}px` }}>
      <div class="toolwin-head">
        <span class="toolwin-title">Explorador</span>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Nueva conexión (Ctrl+Alt+N)" onClick={() => openConnDialog()}><Plus size={15} /></button>
        <button type="button" class="icon-btn" title="Buscar en el árbol" classList={{ on: filterOpen() }} onClick={() => { setFilterOpen(!filterOpen()); if (filterOpen()) queueMicrotask(() => filterInput?.focus()); else setState("treeFilter", ""); }}><Search size={14} /></button>
        <button type="button" class="icon-btn" title="Actualizar todo" onClick={() => { for (const id of Object.keys(state.sessions)) void refreshNode(id, []); }}><RefreshCw size={14} /></button>
        <button type="button" class="icon-btn" title="Contraer todo" onClick={collapseAll}><ChevronsDownUp size={14} /></button>
      </div>
      <Show when={filterOpen() || state.treeFilter}>
        <div class="tree-filter">
          <Search size={13} />
          <input
            ref={filterInput}
            placeholder="Filtrar objetos cargados"
            value={state.treeFilter}
            onInput={(event) => setState("treeFilter", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setState("treeFilter", "");
                setFilterOpen(false);
                scroller?.focus();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                scroller?.focus();
                if (rows().length) select(rows()[0].key);
              }
            }}
          />
          <Show when={state.treeFilter}>
            <button type="button" class="icon-btn tiny" title="Limpiar" onClick={() => setState("treeFilter", "")}><X size={12} /></button>
          </Show>
        </div>
      </Show>
      <div
        class="tree"
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        role="tree"
        aria-label="Conexiones y objetos"
      >
        <div style={{ height: `${visible().total * ROW}px`, position: "relative" }}>
          <For each={visible().items}>
            {(row, i) => (
              <div class="tree-row-wrap" style={{ transform: `translateY(${(visible().first + i()) * ROW}px)` }}>
                <TreeRow row={row} selected={state.treeSelected === row.key} filter={state.treeFilter} onSelect={() => select(row.key)} onActivate={() => activate(row)} onConnMenu={connMenu} onNodeMenu={nodeMenu} />
              </div>
            )}
          </For>
        </div>
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

function TreeRow(props: {
  row: Row;
  selected: boolean;
  filter: string;
  onSelect: () => void;
  onActivate: () => void;
  onConnMenu: (event: MouseEvent, conn: ConnSummary) => void;
  onNodeMenu: (event: MouseEvent, connId: string, node: MetaNode) => void;
}) {
  const indent = () => 6 + props.row.depth * 14;
  const row = props.row;
  if (row.type === "group") {
    // Drop a connection on a folder header to move it there.
    const folder = row.key.slice(2);
    return (
      <div
        class="tree-row group"
        classList={{ "drop-into": dropOver() === row.key }}
        style={{ "padding-left": `${indent()}px` }}
        onDragOver={(event) => acceptConnDrop(event, row.key)}
        onDragLeave={() => setDropOver(null)}
        onDrop={(event) => dropConn(event, folder)}
      >
        {row.name}
      </div>
    );
  }
  if (row.type === "status") {
    return <div class="tree-row status" classList={{ error: row.error }} style={{ "padding-left": `${indent() + 20}px` }} title={row.text}>{row.error ? `⚠ ${row.text}` : row.text}</div>;
  }
  if (row.type === "conn") {
    const conn = row.conn;
    const connected = () => Boolean(state.sessions[conn.id]);
    const open = () => connected() && state.tree[pathKey(conn.id, [])]?.open;
    const busy = () => state.connecting[conn.id];
    return (
      <div
        class="tree-row conn"
        classList={{ selected: props.selected, connected: connected(), "drop-before": dropOver() === row.key, dragging: dragging() === conn.id }}
        style={{ "padding-left": `${indent()}px` }}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={props.selected}
        aria-expanded={Boolean(open())}
        draggable={true}
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
        onDragOver={(event) => acceptConnDrop(event, row.key)}
        onDragLeave={() => setDropOver(null)}
        onDrop={(event) => dropConn(event, conn.folder || "", conn.id)}
        onMouseDown={props.onSelect}
        onDblClick={() => (connected() ? toggleConnection(conn.id) : void connect(conn.id))}
        onContextMenu={(event) => {
          props.onSelect();
          props.onConnMenu(event, conn);
        }}
        title={`${engineOf(conn.kind).label}${conn.host ? ` · ${conn.host}${conn.port ? `:${conn.port}` : ""}` : conn.filePath ? ` · ${conn.filePath}` : ""}`}
      >
        <span
          class="twist"
          classList={{ open: Boolean(open()) }}
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
          <i class="conn-dot" classList={{ on: connected(), busy: busy() }} style={{ background: connected() ? connColor(conn) : undefined }} />
        </span>
        <span class="tree-name">{highlight(conn.name, props.filter)}</span>
        <Show when={conn.production}><span class="tag prod">PROD</span></Show>
        <Show when={conn.readOnly}><span class="tag">RO</span></Show>
        <small class="tree-detail">{busy() ? "conectando…" : conn.host || (conn.filePath ? conn.filePath.split(/[\\/]/).pop() : "")}</small>
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
  const f = filter.trim();
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
