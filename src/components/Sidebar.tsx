import { For, Show } from "solid-js";
import { connect, loadChildren, openConnDialog, openQuery, openTable, pathKey, removeConnection, setState, state, toggleNode } from "../state";
import type { MetaNode } from "../types";

export function Sidebar() {
  const groups = () => {
    const map = new Map<string, typeof state.connections>();
    for (const conn of state.connections) {
      const folder = conn.folder || "Sin carpeta";
      map.set(folder, [...(map.get(folder) ?? []), conn]);
    }
    return [...map.entries()];
  };

  return (
    <aside class="sidebar" style={{ width: `${state.settings.sidebarWidth}px` }}>
      <div class="side-head">
        <strong>Conexiones</strong>
        <button type="button" class="btn tiny" onClick={() => openConnDialog()}>Nueva</button>
      </div>
      <input class="search" placeholder="Filtrar objetos" value={state.treeFilter} onInput={(event) => setState("treeFilter", event.currentTarget.value)} />
      <div class="side-scroll">
        <For each={groups()}>
          {([folder, conns]) => (
            <section>
              <div class="folder">{folder}</div>
              <For each={conns}>
                {(conn) => (
                  <article class="conn" classList={{ on: Boolean(state.sessions[conn.id]) }}>
                    <button type="button" class="conn-main" onClick={() => void (state.sessions[conn.id] ? loadChildren(conn.id, [], !state.tree[pathKey(conn.id, [])]?.open) : connect(conn.id))}>
                      <i style={{ background: conn.production ? "var(--danger)" : (conn.color || "var(--accent)") }} />
                      <span>
                        <b>{conn.name}</b>
                        <small>{label(conn.kind)}{conn.production ? " · PROD" : ""}{conn.readOnly ? " · solo lectura" : ""}</small>
                      </span>
                    </button>
                    <div class="conn-actions">
                      <button type="button" title="Nueva consulta" onClick={() => openQuery(conn.id, "")}>SQL</button>
                      <button type="button" title="Editar" onClick={() => openConnDialog(conn)}>✎</button>
                      <button type="button" title="Eliminar" onClick={() => void removeConnection(conn.id)}>✕</button>
                    </div>
                    <Show when={state.sessions[conn.id] && state.tree[pathKey(conn.id, [])]?.open !== false}>
                      <div class="tree">
                        <For each={visible(state.tree[pathKey(conn.id, [])]?.nodes ?? [], conn.id)}>
                          {(node) => <TreeNode connId={conn.id} node={node} depth={0} />}
                        </For>
                        <Show when={state.tree[pathKey(conn.id, [])]?.status === "loading"}><p class="hint">Cargando…</p></Show>
                        <Show when={state.tree[pathKey(conn.id, [])]?.error}><p class="hint error">{state.tree[pathKey(conn.id, [])]?.error}</p></Show>
                      </div>
                    </Show>
                  </article>
                )}
              </For>
            </section>
          )}
        </For>
        <Show when={!state.connections.length}>
          <p class="hint">Aún no hay conexiones. Nueva conexión abre SQLite sin instalar nada.</p>
        </Show>
      </div>
    </aside>
  );
}

function TreeNode(props: { connId: string; node: MetaNode; depth: number }) {
  const entry = () => state.tree[pathKey(props.connId, props.node.path)];
  const open = () => Boolean(entry()?.open);
  return (
    <div class="node">
      <button
        type="button"
        class="node-row"
        style={{ "padding-left": `${8 + props.depth * 14}px` }}
        onClick={() => void toggleNode(props.connId, props.node)}
        onDblClick={() => {
          const obj = props.node.obj;
          if (obj && (obj.kind === "table" || obj.kind === "view")) void openTable(props.connId, obj);
        }}
      >
        <span class="twist">{props.node.leaf ? "" : open() ? "▾" : "▸"}</span>
        <span class={`kind ${props.node.kind}`} />
        <span class="node-name">{props.node.name}</span>
        <Show when={props.node.detail}><small>{props.node.detail}</small></Show>
      </button>
      <Show when={open() && !props.node.leaf}>
        <For each={visible(entry()?.nodes ?? [], props.connId)}>
          {(child) => <TreeNode connId={props.connId} node={child} depth={props.depth + 1} />}
        </For>
        <Show when={entry()?.status === "loading"}><p class="hint" style={{ "padding-left": `${24 + props.depth * 14}px` }}>Cargando…</p></Show>
      </Show>
    </div>
  );
}

function visible(nodes: MetaNode[], connId: string): MetaNode[] {
  const filter = state.treeFilter.trim().toLowerCase();
  if (!filter) return nodes;
  return nodes.filter((node) => nodeMatches(node, filter, connId));
}

function nodeMatches(node: MetaNode, filter: string, connId: string): boolean {
  if (node.name.toLowerCase().includes(filter)) return true;
  const children = state.tree[pathKey(connId, node.path)]?.nodes ?? [];
  if (children.some((child) => nodeMatches(child, filter, connId))) return true;
  return !node.leaf && !state.tree[pathKey(connId, node.path)];
}

function label(kind: string) {
  if (kind === "mssql") return "SQL Server";
  if (kind === "informix") return "Informix";
  if (kind === "sqlite") return "SQLite";
  return "ODBC";
}
