import { createSignal, For, onMount, Show } from "solid-js";
import { DataGrid } from "./Grid";
import { Gib } from "../gib/Gib";
import { Mark } from "../brand/Mark";
import { SqlEditor } from "./Editor";
import {
  canEdit,
  cancelActive,
  changeAutocommit,
  clearHistory,
  closeTab,
  commitActive,
  connectionById,
  deleteTableRows,
  displayRows,
  editCell,
  fetchMore,
  formatActive,
  insertTableRow,
  openConnDialog,
  openScript,
  refreshHistory,
  reloadTable,
  runActive,
  saveScript,
  saveTable,
  schemaMap,
  selectTab,
  setState,
  startExport,
  state,
  tableDirty,
  updateSql,
  useHistory,
} from "../state";
import type { SqlTab, TableTab } from "../state";

function Welcome() {
  const [mood, setMood] = createSignal<"wave" | "idle" | "love">("wave");
  onMount(() => {
    const timer = window.setTimeout(() => setMood("idle"), 1600);
    return () => window.clearTimeout(timer);
  });
  return (
    <div class="empty">
      <Gib size={150} mood={mood()} onClick={() => { setMood("love"); window.setTimeout(() => setMood("idle"), 1200); }} />
      <div class="brand"><Mark size={28} /><h2>Celer</h2></div>
      <p>SQL rápido para cualquier base de datos.</p>
      <button type="button" class="btn primary" onClick={() => openConnDialog()}>Nueva conexión</button>
    </div>
  );
}

export function Workspace() {
  return (
    <section class="workspace">
      <div class="tabbar">
        <For each={state.tabs}>
          {(item) => (
            <button type="button" class="tab" classList={{ on: item.id === state.activeTabId }} onClick={() => selectTab(item.id)}>
              <span class="tab-strip" style={{ background: connectionById(item.connId)?.production ? "var(--danger)" : (connectionById(item.connId)?.color || "var(--accent)") }} />
              <span>{item.title}</span>
              <i onClick={(event) => { event.stopPropagation(); void closeTab(item.id); }}>✕</i>
            </button>
          )}
        </For>
      </div>
      <Show when={state.tabs.find((tab) => tab.id === state.activeTabId)} keyed fallback={<Welcome />}>
        {(tab) => <ActivePane id={tab.id} />}
      </Show>
      <Show when={state.historyOpen}>
        <div class="history">
          <header>
            <strong>Historial</strong>
            <input placeholder="Buscar" value={state.historyQuery} onInput={(event) => { setState("historyQuery", event.currentTarget.value); void refreshHistory(); }} />
            <button type="button" class="btn tiny" onClick={() => void clearHistory()}>Vaciar</button>
            <button type="button" onClick={() => setState("historyOpen", false)}>✕</button>
          </header>
          <For each={state.history}>
            {(entry) => (
              <button type="button" class="history-item" onClick={() => void useHistory(entry.sql)}>
                <code>{entry.sql.replace(/\s+/g, " ").slice(0, 180)}</code>
                <small>{entry.connName} · {entry.ok ? "ok" : "error"} · {entry.elapsedMs} ms · {new Date(entry.at).toLocaleString()}</small>
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function ActivePane(props: { id: string }) {
  const item = () => state.tabs.find((tab) => tab.id === props.id);
  return (
    <>
      <Show when={item()?.kind === "sql"}>
        <SqlPane tab={item() as SqlTab} />
      </Show>
      <Show when={item()?.kind === "table"}>
        <TablePane tab={item() as TableTab} />
      </Show>
    </>
  );
}

function SqlPane(props: { tab: SqlTab }) {
  const result = () => props.tab.results[props.tab.activeResult];
  const conn = () => connectionById(props.tab.connId);
  return (
    <div class="pane">
      <div class="pane-bar">
        <span class="badge" style={{ background: conn()?.production ? "var(--danger)" : (conn()?.color || "var(--accent)") }} />
        <b>{conn()?.name ?? "Sin conexión"}</b>
        <Show when={props.tab.database}><span class="muted">{props.tab.database}</span></Show>
        <Show when={conn()?.readOnly}><span class="pill">solo lectura</span></Show>
        <Show when={conn()?.production}><span class="pill prod">PROD</span></Show>
        <span class="spacer" />
        <button type="button" class="btn tiny" onClick={() => void openScript()}>Abrir</button>
        <button type="button" class="btn tiny" onClick={() => void saveScript()}>Guardar</button>
        <button type="button" class="btn tiny" onClick={formatActive}>Formatear</button>
        <button type="button" class="btn tiny run" onClick={() => void runActive("statement")}>Ejecutar</button>
        <button type="button" class="btn tiny" onClick={() => void runActive("script")}>Script</button>
        <button type="button" class="btn tiny" disabled={!props.tab.running} onClick={() => void cancelActive()}>Cancelar</button>
      </div>
      <SqlEditor
        doc={props.tab.sql}
        revision={props.tab.revision}
        kind={conn()?.kind ?? "sqlite"}
        schema={schemaMap(props.tab)}
        fontSize={state.settings.editorFontSize}
        onDoc={(sql, cursor) => updateSql(props.tab.id, sql, cursor)}
        onRun={() => void runActive("statement")}
        onRunAll={() => void runActive("script")}
        onCancel={() => void cancelActive()}
      />
      <Show when={props.tab.error}><div class="banner">{props.tab.error}</div></Show>
      <div class="results">
        <div class="result-tabs">
          <For each={props.tab.results}>
            {(item, index) => (
              <button type="button" classList={{ on: index() === props.tab.activeResult }} onClick={() => {
                const current = state.tabs.find((tab) => tab.id === props.tab.id);
                if (current?.kind === "sql") setState("tabs", state.tabs.indexOf(current), { ...current, activeResult: index() });
              }}>
                {item.columns.length ? `Resultado ${index() + 1}` : `${item.rowsAffected ?? 0} filas`}
              </button>
            )}
          </For>
          <Show when={props.tab.messages.length}><span class="muted">{props.tab.messages.join(" · ")}</span></Show>
          <span class="spacer" />
          <Show when={props.tab.elapsedMs !== null}><span class="muted">{props.tab.elapsedMs} ms</span></Show>
          <label class="check tiny"><input type="checkbox" checked={props.tab.autocommit} onChange={(event) => void changeAutocommit(event.currentTarget.checked)} /> autocommit</label>
          <button type="button" class="btn tiny" disabled={!props.tab.inTransaction} onClick={() => void commitActive(false)}>Commit</button>
          <button type="button" class="btn tiny" disabled={!props.tab.inTransaction} onClick={() => void commitActive(true)}>Rollback</button>
          <button type="button" class="btn tiny" onClick={() => void startExport()}>Exportar</button>
        </div>
        <Show when={result()?.columns.length} fallback={<div class="empty small">{props.tab.running ? "Ejecutando…" : props.tab.results.length ? "La sentencia no devolvió columnas." : <><Gib size={72} mood="idle" /><span>Ctrl+Enter ejecuta la sentencia del cursor. Alt+X ejecuta el script.</span></>}</div>}>
          <DataGrid
            columns={result()!.columns}
            rows={result()!.rows}
            hasMore={result()!.hasMore}
            onNeedMore={() => void fetchMore(props.tab.id)}
            onView={(text) => setState("valueText", text)}
          />
        </Show>
      </div>
    </div>
  );
}

function TablePane(props: { tab: TableTab }) {
  const editable = () => canEdit(props.tab);
  return (
    <div class="pane">
      <div class="pane-bar">
        <b>{props.tab.qualified}</b>
        <span class="pill">{props.tab.obj.kind}</span>
        <span class="spacer" />
        <Show when={editable()}>
          <button type="button" class="btn tiny" onClick={() => insertTableRow(props.tab.id)}>Insertar</button>
          <button type="button" class="btn tiny" disabled={!tableDirty(props.tab)} onClick={() => void saveTable(props.tab.id)}>Guardar cambios</button>
        </Show>
        <button type="button" class="btn tiny" onClick={() => void reloadTable(props.tab.id)}>Recargar</button>
      </div>
      <div class="result-tabs">
        <For each={[["data", "Datos"], ["columns", "Columnas"], ["indexes", "Índices"], ["keys", "Claves"], ["ddl", "DDL"]] as const}>
          {([id, label]) => <button type="button" classList={{ on: props.tab.section === id }} onClick={() => {
            const current = state.tabs.find((tab) => tab.id === props.tab.id);
            if (current?.kind === "table") setState("tabs", state.tabs.indexOf(current), { ...current, section: id });
          }}>{label}</button>}
        </For>
      </div>
      <Show when={props.tab.error}><div class="banner">{props.tab.error}</div></Show>
      <Show when={props.tab.loading}><div class="empty small">Cargando…</div></Show>
      <Show when={!props.tab.loading && props.tab.section === "data"}>
        <DataGrid
          columns={props.tab.gridCols}
          rows={displayRows(props.tab)}
          deleted={props.tab.deleted}
          edits={props.tab.edits}
          insertStart={props.tab.rows.length}
          hasMore={props.tab.hasMore}
          editable={editable()}
          onEdit={(row, col, value) => editCell(props.tab.id, row, col, value)}
          onNeedMore={() => void fetchMore(props.tab.id)}
          onView={(text) => setState("valueText", text)}
          onDelete={(rows) => deleteTableRows(props.tab.id, rows)}
        />
        <Show when={editable()}>
          <div class="pane-bar">
            <span class="muted">{tableDirty(props.tab) ? "Hay cambios sin guardar" : "Doble clic edita · Supr marca filas para borrar"}</span>
          </div>
        </Show>
      </Show>
      <Show when={props.tab.section === "columns"}>
        <div class="meta-table">
          <For each={props.tab.columnsMeta}>
            {(col) => <div><b>{col.name}</b><span>{col.typeName}</span><span>{col.nullable ? "null" : "not null"}</span><span>{col.primaryKey ? "PK" : ""}</span><span>{col.default ?? ""}</span></div>}
          </For>
        </div>
      </Show>
      <Show when={props.tab.section === "indexes"}>
        <ul class="meta-list"><For each={props.tab.indexes}>{(node) => <li><b>{node.name}</b> {node.detail}</li>}</For></ul>
      </Show>
      <Show when={props.tab.section === "keys"}>
        <ul class="meta-list"><For each={props.tab.keys}>{(node) => <li><b>{node.name}</b> {node.detail}</li>}</For></ul>
      </Show>
      <Show when={props.tab.section === "ddl"}><pre class="code grow">{props.tab.ddl}</pre></Show>
    </div>
  );
}
