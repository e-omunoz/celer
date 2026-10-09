import { allSnippets } from "../snippets";
import { PlanView } from "./PlanView";
import { CompareView } from "./CompareView";
import {
  AlignLeft,
  ArrowDownToLine,
  ArrowRight,
  BookmarkPlus,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Download,
  FileCode2,
  Filter,
  FolderOpen,
  Gauge,
  GitCompare,
  ListFilter,
  Lightbulb,
  Minus,
  PanelRight,
  Pin,
  Play,
  PlayCircle,
  Plus,
  RefreshCw,
  Rows3,
  Save,
  Square,
  Undo2,
  Upload,
  X,
} from "lucide-solid";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { EngineIcon, ObjIcon } from "../icons";
import { Gib } from "../gib/Gib";
import { cellText, isNullCell, rowsLabel, whereHints } from "../sql";
import {
  activeSql,
  canEdit,
  cancelActive,
  changeAutocommit,
  closeOtherTabs,
  closeTab,
  commitActive,
  connColor,
  connect,
  connectionById,
  copyText,
  deleteTableRows,
  displayRows,
  editCell,
  fetchAll,
  fetchMore,
  formatActive,
  formatMs,
  gib,
  insertTableRow,
  kindOf,
  moveTab,
  notify,
  now,
  openConnDialog,
  openInspector,
  openMenu,
  openQuery,
  openScript,
  pinResult,
  closeCompare,
  compareWithCurrent,
  revertTableChange,
  showPlan,
  showPinned,
  unpinResult,
  reloadTable,
  renameTab,
  revertTable,
  runActive,
  saveScript,
  saveSettings,
  saveTable,
  completionTables,
  openTableFromSql,
  followForeignKey,
  foreignKeyOf,
  foreignKeys,
  selectTab,
  serverOf,
  setActiveResult,
  setState,
  setTabConnection,
  setTableFilter,
  setTableSection,
  startExport,
  state,
  switchDatabase,
  tableDirty,
  toggleInspector,
  updateSql,
  countTable,
  reloadTableSafe,
  rerunActive,
  startTableExport,
  setTableSort,
  upsertTableFilter,
  type ColumnFilter,
  type SqlTab,
  type Tab,
  type TableTab,
} from "../state";
import { engineOf, type Cell } from "../types";
import { api, isTauri } from "../api";
import { CodeView, SqlEditor } from "./Editor";
import { TabLink } from "./LinkDot";
import { DataGrid, type GridApi } from "./Grid";
import { askAi } from "../ai";
import { startImport } from "../importer";
import { withShortcut } from "../commands";
import { libraryDirty, saveToLibrary, scriptById } from "../library";
import { claimTabDrop, endTabDrag, incomingDrag, otherFullWindows, sendTab, startTabDrag } from "../windows";
import { windowName } from "../windowModel";
import { openFkLookup } from "../fkLookup";
import { FilterChips, FilterEditor, newFilter, type FilterDraft } from "./TableFilters";

export function Workspace() {
  return (
    <section class="center">
      <TabBar />
      <div class="panes">
        <For each={state.tabs}>
          {(tab) => (
            <div class="pane-host" classList={{ active: tab.id === state.activeTabId }}>
              <Show when={tab.kind === "sql"} fallback={<TablePane tab={tab as TableTab} />}>
                <SqlPane tab={tab as SqlTab} />
              </Show>
            </div>
          )}
        </For>
        <Show when={!state.tabs.length && state.ready}>
          <Welcome />
        </Show>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- tabs

function TabBar() {
  const [dragFrom, setDragFrom] = createSignal(-1);
  const [renaming, setRenaming] = createSignal("");
  /** The tab was dropped on this tab bar (a reorder): it does not go to another window. */
  let droppedHere = false;

  function menu(event: MouseEvent, tab: Tab) {
    // Another window, or a new one: the tab goes on there with its session as it is.
    const windows = isTauri()
      ? [
          { separator: true },
          { label: "Mover a una ventana nueva", run: () => void sendTab(tab.id, null) },
          ...otherFullWindows().map((w) => ({ label: `Mover a ${windowName(w.label)}${w.title ? ` (${w.title})` : ""}`, run: () => void sendTab(tab.id, w.label) })),
        ]
      : [];
    openMenu(event, [
      { label: "Cerrar", hint: "Ctrl+W", run: () => void closeTab(tab.id) },
      { label: "Cerrar las demás", run: () => void closeOtherTabs(tab.id) },
      { separator: true },
      { label: "Renombrar", disabled: tab.kind !== "sql", run: () => setRenaming(tab.id) },
      { label: "Duplicar consola", disabled: tab.kind !== "sql", run: () => tab.kind === "sql" && openQuery(tab.connId, tab.sql, `${tab.title} (2)`) },
      ...windows,
    ]);
  }

  return (
    <div
      class="tabbar"
      role="tablist"
      classList={{ "drop-in": Boolean(incomingDrag()) }}
      onDblClick={(event) => event.target === event.currentTarget && openQuery(activeSql()?.connId ?? null)}
      onDragOver={(event) => incomingDrag() && event.preventDefault()}
      onDrop={(event) => {
        // A tab from another window let go after the last tab.
        if (event.target !== event.currentTarget || !incomingDrag()) return;
        event.preventDefault();
        claimTabDrop(state.tabs.length);
      }}
    >
      <For each={state.tabs}>
        {(tab, index) => {
          const conn = () => connectionById(tab.connId);
          const dirty = () => (tab.kind === "table" ? tableDirty(tab) : tab.inTransaction);
          const busy = () => (tab.kind === "sql" ? tab.running : tab.loading);
          return (
            <div
              class="tab"
              role="tab"
              aria-selected={tab.id === state.activeTabId}
              classList={{ on: tab.id === state.activeTabId, dragging: dragFrom() === index() }}
              draggable={renaming() !== tab.id}
              onDragStart={(event) => {
                setDragFrom(index());
                droppedHere = false;
                event.dataTransfer?.setData("application/x-celer-tab", tab.id);
                // Out of the window it goes to another one, or to a new one where it is let go.
                startTabDrag(tab.id, tab.title);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (dragFrom() >= 0) {
                  droppedHere = true;
                  moveTab(dragFrom(), index());
                } else claimTabDrop(index());
                setDragFrom(-1);
              }}
              onDragEnd={() => {
                setDragFrom(-1);
                void endTabDrag(tab.id, droppedHere);
              }}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  void closeTab(tab.id);
                } else if (event.button === 0) selectTab(tab.id);
              }}
              onDblClick={() => tab.kind === "sql" && setRenaming(tab.id)}
              onContextMenu={(event) => menu(event, tab)}
              title={`${tab.title}${conn() ? ` · ${conn()!.name}` : ""}${tab.database ? ` · ${tab.database}` : ""}`}
            >
              <span class="tab-strip" style={{ background: tab.connId ? connColor(conn()) : "transparent" }} />
              <ObjIcon kind={tab.kind === "table" ? (tab.obj.kind === "view" ? "view" : "table") : tab.title.endsWith(".sql") ? "file" : "console"} size={14} />
              <TabLink tab={tab} />
              <Show when={renaming() === tab.id} fallback={<span class="tab-title">{tab.title}</span>}>
                <input
                  class="tab-rename"
                  value={tab.title}
                  ref={(el) => queueMicrotask(() => el.select())}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      renameTab(tab.id, event.currentTarget.value);
                      setRenaming("");
                    }
                    if (event.key === "Escape") setRenaming("");
                  }}
                  onBlur={(event) => {
                    renameTab(tab.id, event.currentTarget.value);
                    setRenaming("");
                  }}
                />
              </Show>
              <Show when={busy()}><span class="tab-spinner" /></Show>
              <Show when={dirty() && !busy()}><span class="tab-dirty" title={tab.kind === "table" ? "Cambios sin guardar" : "Transacción abierta"} /></Show>
              <button
                type="button"
                class="tab-close"
                title={withShortcut("Cerrar", "close-tab")}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        }}
      </For>
      <button type="button" class="tab-new" title={withShortcut("Nueva consola", "new-console")} onClick={() => openQuery(activeSql()?.connId ?? null)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- console

function ConnectionPicker(props: { tab: SqlTab }) {
  const conn = () => connectionById(props.tab.connId);
  const session = () => (props.tab.connId ? state.sessions[props.tab.connId] : undefined);
  return (
    <div class="ctx-pickers">
      <button
        type="button"
        class="picker"
        title="Conexión de esta consola"
        onClick={(event) =>
          openMenu(
            event,
            state.connections.length
              ? [
                  ...state.connections.map((item) => ({
                    label: `${item.id === props.tab.connId ? "● " : ""}${item.name}`,
                    hint: engineOf(item.kind).label,
                    run: () => void setTabConnection(props.tab.id, item.id),
                  })),
                  { separator: true },
                  { label: "Nueva conexión…", run: () => openConnDialog() },
                ]
              : [{ label: "Nueva conexión…", run: () => openConnDialog() }],
          )
        }
      >
        <Show when={conn()} fallback={<span class="muted">Sin conexión</span>}>
          <EngineIcon kind={conn()!.kind} size={14} server={serverOf(conn()!.id)} />
          <span class="picker-dot" style={{ background: session() ? connColor(conn()) : "var(--text-faint)" }} />
          <span>{conn()!.name}</span>
        </Show>
        <ChevronDown size={12} />
      </button>
      <Show when={conn()}>
        <button
          type="button"
          class="picker"
          title="Base de datos"
          disabled={!session()}
          onClick={(event) => {
            const dbs = session()?.databases ?? [];
            openMenu(event, dbs.length ? dbs.map((name) => ({ label: `${name === props.tab.database ? "● " : ""}${name}`, run: () => void switchDatabase(name) })) : [{ label: "Sin bases de datos", disabled: true }]);
          }}
        >
          <ObjIcon kind="database" size={13} />
          <span>{props.tab.database || session()?.database || "—"}</span>
          <ChevronDown size={12} />
        </button>
      </Show>
      <Show when={conn()?.production}><span class="tag prod">PROD</span></Show>
      <Show when={conn()?.readOnly}><span class="tag">Solo lectura</span></Show>
      <Show when={conn() && !session() && !state.connecting[conn()!.id]}>
        <button type="button" class="btn tiny" onClick={() => void connect(conn()!.id)}>Conectar</button>
      </Show>
    </div>
  );
}

function SqlPane(props: { tab: SqlTab }) {
  let paneRef: HTMLDivElement | undefined;
  const pinned = () => (props.tab.activePinned ? props.tab.pinned.find((pin) => pin.id === props.tab.activePinned) : undefined);
  const current = () => (props.tab.activeResult >= 0 ? props.tab.results[props.tab.activeResult] : undefined);
  /** What the grid shows: a pinned result, or the current one. */
  const result = () => pinned()?.result ?? current();
  // Quick filter over the rows already loaded (any column contains the text, case-insensitive).
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [filterText, setFilterText] = createSignal("");
  const [filterApplied, setFilterApplied] = createSignal("");
  let filterTimer = 0;
  const typeFilter = (text: string) => {
    setFilterText(text);
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => setFilterApplied(text.trim().toLowerCase()), 160);
  };
  const closeFilter = () => {
    window.clearTimeout(filterTimer);
    setFilterOpen(false);
    setFilterText("");
    setFilterApplied("");
  };
  onCleanup(() => window.clearTimeout(filterTimer));
  // Lower-cased text of each row, built once per set of rows (not on every keystroke of the filter).
  const rowTexts = createMemo(() => {
    if (!filterOpen()) return null;
    return (result()?.rows ?? []).map((row) => row.map((cell) => (isNullCell(cell) ? "" : cellText(cell).toLowerCase())).join("\u0000"));
  });
  const shownRows = createMemo(() => {
    const rows = result()?.rows ?? [];
    const needle = filterApplied();
    const texts = rowTexts();
    if (!needle || !texts) return rows;
    return rows.filter((_, i) => texts[i]?.includes(needle));
  });
  const filtering = () => Boolean(filterApplied());
  // Pinned or filtered rows never page in more by themselves (a filter would keep asking for pages). One memo: the grid
  // reads it while painting and in event handlers, where an inline condition would create a memo on every read.
  const gridHasMore = createMemo(() => Boolean(result()?.hasMore) && !pinned() && !filtering());
  /** Export what is on show: a pinned result re-runs its own SQL; the quick filter is a view and is not applied. */
  const exportShown = () => {
    if (filtering()) notify("Se exportan todas las filas", "info", "El filtro rápido solo cambia lo que ves; la exportación vuelve a leer la consulta completa.");
    void startExport(pinned()?.sql);
  };
  const gridResults = createMemo(() => props.tab.results.map((item, index) => ({ item, index })));
  const elapsedLive = () => (props.tab.running && props.tab.startedAt ? now() - props.tab.startedAt : null);
  // What the session does besides the statement (SQL Server reading the rest of the previous result to keep a
  // transaction or #temp tables): asked every half second while it runs.
  const [progress, setProgress] = createSignal<string | null>(null);
  createEffect(() => {
    const sessionId = props.tab.running ? props.tab.sessionId : null;
    setProgress(null);
    if (!sessionId) return;
    const timer = window.setInterval(() => {
      void api()
        .sessionProgress(sessionId)
        .then((text) => setProgress(props.tab.running ? text : null))
        .catch(() => setProgress(null));
    }, 500);
    onCleanup(() => window.clearInterval(timer));
  });

  function resize(event: MouseEvent) {
    event.preventDefault();
    const rect = paneRef!.getBoundingClientRect();
    const move = (ev: MouseEvent) => setState("settings", "editorRatio", Math.min(0.85, Math.max(0.12, (ev.clientY - rect.top) / rect.height)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      void saveSettings({ editorRatio: state.settings.editorRatio });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <div class="pane" ref={paneRef}>
      <div class="pane-toolbar">
        <Show
          when={!props.tab.running}
          fallback={
            <button type="button" class="tb-btn stop" title={withShortcut("Detener", "stop")} onClick={() => void cancelActive()}>
              <Square size={13} fill="currentColor" /> <span>Detener</span>
            </button>
          }
        >
          <button type="button" class="tb-btn run" title={withShortcut("Ejecutar sentencia o selección", "run")} onClick={() => { gib("mouse-run"); void runActive("statement"); }}>
            <Play size={14} fill="currentColor" /> <span>Ejecutar</span>
          </button>
        </Show>
        <button type="button" class="tb-icon" title={withShortcut("Ejecutar script completo", "run-script")} disabled={props.tab.running} onClick={() => void runActive("script")}>
          <PlayCircle size={16} />
        </button>
        <button type="button" class="tb-icon" title={withShortcut("Plan de ejecución", "explain")} disabled={props.tab.running} onClick={() => void runActive("explain")}>
          <Gauge size={16} />
        </button>
        <span class="tb-sep" />
        <div class="tx-toggle" title="Modo de transacción">
          <button type="button" classList={{ on: props.tab.autocommit }} onClick={() => !props.tab.autocommit && void changeAutocommit(true)}>Auto</button>
          <button type="button" classList={{ on: !props.tab.autocommit }} onClick={() => props.tab.autocommit && void changeAutocommit(false)}>Manual</button>
        </div>
        <button type="button" class="tb-icon commit" title={withShortcut("Commit", "commit")} disabled={!props.tab.inTransaction} onClick={() => void commitActive(false)}>
          <Check size={16} />
        </button>
        <button type="button" class="tb-icon rollback" title={withShortcut("Rollback", "rollback")} disabled={!props.tab.inTransaction} onClick={() => void commitActive(true)}>
          <Undo2 size={16} />
        </button>
        <Show when={props.tab.inTransaction}><span class="tag warn">Transacción abierta</span></Show>
        <span class="tb-sep" />
        <button type="button" class="tb-icon secondary" title={withShortcut("Formatear SQL", "format")} onClick={formatActive}>
          <AlignLeft size={16} />
        </button>
        <button type="button" class="tb-icon secondary" title={withShortcut("Abrir script", "open")} onClick={() => void openScript()}>
          <FolderOpen size={16} />
        </button>
        <button type="button" class="tb-icon secondary" title={withShortcut("Guardar script", "save")} onClick={() => void saveScript()}>
          <Save size={16} />
        </button>
        <button
          type="button"
          class="tb-icon secondary lib-save"
          classList={{ dirty: Boolean(props.tab.libraryId && libraryDirty(props.tab.libraryId)) }}
          title={withShortcut(props.tab.libraryId && scriptById(props.tab.libraryId) ? `Guardar los cambios en la biblioteca («${scriptById(props.tab.libraryId)!.name}»)` : "Guardar en la biblioteca de scripts", "save-library")}
          onClick={() => void saveToLibrary()}
        >
          <BookmarkPlus size={16} />
        </button>
        <span class="spacer" />
        <ConnectionPicker tab={props.tab} />
      </div>
      <div class="editor-wrap" style={{ height: `${state.settings.editorRatio * 100}%` }}>
        <SqlEditor
          doc={props.tab.sql}
          revision={props.tab.revision}
          cursor={props.tab.cursor}
          kind={kindOf(props.tab.connId)}
          tables={completionTables(props.tab)}
          snippets={allSnippets(kindOf(props.tab.connId), state.settings.snippets)}
          keymap={state.settings.keymap}
          defaultSchema={kindOf(props.tab.connId) === "postgres" ? "public" : kindOf(props.tab.connId) === "mssql" ? "dbo" : undefined}
          onOpenTable={(table) => openTableFromSql(props.tab, table)}
          fontSize={state.settings.editorFontSize}
          onDoc={(sql, cursor, selection) => updateSql(props.tab.id, sql, cursor, selection)}
          onCursor={(line, col) => props.tab.id === state.activeTabId && setState("cursorPos", { line, col })}
          onRun={() => void runActive("statement")}
          onRunAll={() => void runActive("script")}
          onExplain={() => void runActive("explain")}
          onCancel={() => void cancelActive()}
          onFormat={formatActive}
        />
        <Show when={!props.tab.connId && state.connections.length}>
          <div class="editor-hint">
            Esta consola no tiene conexión ·{" "}
            <button type="button" class="link" onClick={(event) => openMenu(event, state.connections.map((item) => ({ label: item.name, hint: engineOf(item.kind).label, run: () => void setTabConnection(props.tab.id, item.id) })))}>
              elegir conexión
            </button>
          </div>
        </Show>
      </div>
      <div class="hsplit" onMouseDown={resize} />
      <div class="results">
        <div class="results-head">
          <button type="button" class="rtab" classList={{ on: props.tab.activeResult === -1 && !props.tab.activePinned && !props.tab.activePlan && !props.tab.compare, error: Boolean(props.tab.error) }} onClick={() => setActiveResult(props.tab.id, -1)}>
            <Show when={props.tab.error} fallback={<FileCode2 size={13} />}><CircleAlert size={13} /></Show>
            Salida
            <Show when={props.tab.output.length}><small>{props.tab.output.length}</small></Show>
          </button>
          <For each={gridResults()}>
            {({ item, index }) => (
              <button type="button" class="rtab" classList={{ on: index === props.tab.activeResult && !props.tab.activePinned && !props.tab.activePlan && !props.tab.compare }} onClick={() => setActiveResult(props.tab.id, index)}>
                <Show when={item.columns.length} fallback={<Rows3 size={13} />}><ObjIcon kind="table" size={13} /></Show>
                {item.columns.length ? `Resultado ${gridResults().filter((r) => r.item.columns.length && r.index <= index).length}` : "Actualización"}
                <small>{item.columns.length ? `${item.rows.length.toLocaleString()}${item.hasMore ? "+" : ""}` : (item.rowsAffected ?? 0).toLocaleString()}</small>
              </button>
            )}
          </For>
          <Show when={props.tab.plan}>
            <button type="button" class="rtab" classList={{ on: props.tab.activePlan }} title={props.tab.plan!.sql} onClick={() => showPlan(props.tab.id)}>
              <Gauge size={13} /> Plan
            </button>
          </Show>
          <For each={props.tab.pinned}>
            {(pin) => (
              <span class="rtab pinned" classList={{ on: pin.id === props.tab.activePinned || pin.id === props.tab.compare?.pinId }} title={pin.sql}>
                <button type="button" class="rtab-main" onClick={() => showPinned(props.tab.id, pin.id)}>
                  <Pin size={12} />
                  {pin.title}
                  <small>{pin.result.rows.length.toLocaleString()}</small>
                </button>
                <button type="button" class="rtab-close" classList={{ on: props.tab.compare?.pinId === pin.id }} title="Comparar con el resultado actual" onClick={() => (props.tab.compare?.pinId === pin.id ? closeCompare(props.tab.id) : compareWithCurrent(props.tab.id, pin.id))}><GitCompare size={11} /></button>
                <button type="button" class="rtab-close" title="Quitar este resultado fijado" onClick={() => unpinResult(props.tab.id, pin.id)}><X size={11} /></button>
              </span>
            )}
          </For>
          <span class="spacer" />
          <Show when={filterOpen()}>
            <span class="result-filter">
              <ListFilter size={13} />
              <input
                value={filterText()}
                placeholder="Filtrar filas cargadas…"
                spellcheck={false}
                ref={(el) => queueMicrotask(() => el.focus())}
                onInput={(event) => typeFilter(event.currentTarget.value)}
                onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), closeFilter())}
              />
              <button type="button" class="icon-btn tiny" title="Quitar el filtro (Esc)" onClick={closeFilter}><X size={12} /></button>
            </span>
          </Show>
          <Show when={props.tab.running}>
            <span class="running-timer"><span class="pulse" /> Ejecutando… {formatMs(elapsedLive())}<Show when={progress()}>{(text) => <> · {text()}</>}</Show></span>
          </Show>
          <Show when={!props.tab.running && !props.tab.activePlan && !props.tab.compare && result()?.columns.length}>
            <span class="muted small">
              <Show when={filtering()} fallback={<>{rowsLabel(result()?.rows.length ?? 0, result()?.hasMore)}{pinned() ? "" : ` · ${formatMs(props.tab.elapsedMs)}`}</>}>
                {shownRows().length.toLocaleString()} de {rowsLabel(result()?.rows.length ?? 0, result()?.hasMore)}
              </Show>
            </span>
            <Show when={!filterOpen()}>
              <button type="button" class="tb-icon" title="Filtrar las filas cargadas" onClick={() => setFilterOpen(true)}><ListFilter size={15} /></button>
            </Show>
            <Show when={!pinned()}>
              <button type="button" class="tb-icon" title="Fijar este resultado (se conserva al volver a ejecutar)" onClick={() => pinResult(props.tab.id)}><Pin size={14} /></button>
            </Show>
            <Show when={result()?.hasMore && !pinned() && !filtering()}>
              <button type="button" class="tb-icon" title="Cargar la siguiente página" onClick={() => void fetchMore(props.tab.id)}><ArrowDownToLine size={15} /></button>
              <button type="button" class="btn tiny" title="Cargar todas las filas" onClick={() => void fetchAll(props.tab.id)}>Cargar todo</button>
            </Show>
          </Show>
          <button type="button" class="tb-icon" title="Volver a ejecutar" disabled={!props.tab.lastSql || props.tab.running} onClick={() => void rerunActive()}><RefreshCw size={14} /></button>
          <button type="button" class="tb-icon" title="Exportar…" disabled={!props.tab.connId} onClick={exportShown}><Download size={15} /></button>
          <button type="button" class="tb-icon" title="Panel de valor / registro" classList={{ on: state.inspectorOpen && state.inspectorMode !== "history" }} onClick={() => toggleInspector("value")}><PanelRight size={15} /></button>
        </div>
        <Show when={props.tab.running && !props.tab.results.length}>
          <div class="progress-bar" />
        </Show>
        <Switch>
          <Match when={props.tab.compare}>
            <CompareView tab={props.tab} />
          </Match>
          <Match when={props.tab.activePlan && props.tab.plan}>
            {(view) => <PlanView tab={props.tab} plan={view().plan} sql={view().sql} />}
          </Match>
          <Match when={props.tab.activeResult === -1 && !pinned()}>
            <OutputLog tab={props.tab} />
          </Match>
          <Match when={result() && !result()!.columns.length}>
            <div class="affected">
              <CircleCheck size={28} />
              <div>
                <strong>{rowsLabel(result()?.rowsAffected ?? 0)} {(result()?.rowsAffected ?? 0) === 1 ? "afectada" : "afectadas"}</strong>
                <span>{formatMs(props.tab.elapsedMs)}{props.tab.inTransaction ? " · pendiente de commit" : ""}</span>
              </div>
            </div>
          </Match>
          <Match when={result()}>
            <DataGrid
              columns={result()?.columns ?? []}
              rows={shownRows()}
              resetKey={`${props.tab.runId}:${props.tab.activeResult}:${props.tab.activePinned ?? ""}`}
              rowsKey={filterApplied()}
              busyKey={props.tab.id}
              hasMore={gridHasMore()}
              loading={props.tab.running}
              dialect={kindOf(props.tab.connId)}
              onNeedMore={() => !pinned() && !filtering() && void fetchMore(props.tab.id)}
              onExport={exportShown}
              onActivate={(row, col) => {
                const r = result();
                if (!r) return;
                const values = shownRows()[row] ?? [];
                setState("inspect", { column: r.columns[col].name, typeName: r.columns[col].typeName, value: values[col] ?? null });
                setState("record", { columns: r.columns, row: values, index: row });
                openInspector("value");
              }}
            />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function OutputLog(props: { tab: SqlTab }) {
  let host: HTMLDivElement | undefined;
  onMount(() => host && (host.scrollTop = host.scrollHeight));
  return (
    <div class="output" ref={host}>
      <Show when={!props.tab.output.length}>
        <div class="output-empty">
          <Gib size={72} mood="idle" />
          <p>
            <kbd>Ctrl</kbd>+<kbd>Intro</kbd> ejecuta la sentencia bajo el cursor o la selección.
            <br />
            <kbd>Ctrl</kbd>+<kbd>Mayús</kbd>+<kbd>Intro</kbd> ejecuta el script entero.
          </p>
        </div>
      </Show>
      <For each={props.tab.output}>
        {(entry) => (
          <div class="out-entry" classList={{ error: !entry.ok }}>
            <span class="out-icon">{entry.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}</span>
            <div class="out-body">
              <div class="out-meta">
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <code title={entry.sql}>{entry.sql.replace(/\s+/g, " ").slice(0, 220)}</code>
                <button type="button" class="link small" onClick={() => void copyText(entry.sql, "SQL copiado")}>copiar</button>
                <Show when={!entry.ok && entry === props.tab.output[props.tab.output.length - 1]}>
                  <button type="button" class="link small ai-link" onClick={() => void askAi("fix")}>✦ Corregir con IA</button>
                </Show>
              </div>
              <pre class="out-text">{entry.text}</pre>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------- table viewer

function TablePane(props: { tab: TableTab }) {
  const editable = () => canEdit(props.tab);
  const conn = () => connectionById(props.tab.connId);
  const rows = createMemo(() => displayRows(props.tab));
  const pkCols = createMemo(() => props.tab.columnsMeta.map((col, index) => (col.primaryKey ? index : -1)).filter((index) => index >= 0));
  // Grid columns that belong to a foreign key (Ctrl+click jumps to the referenced row).
  const linkCols = createMemo(() => {
    const fkCols = new Set(foreignKeys(props.tab).flatMap((fk) => fk.columns));
    return props.tab.gridCols.map((col, index) => (fkCols.has(col.name) ? index : -1)).filter((index) => index >= 0);
  });
  const changes = () => Object.keys(props.tab.edits).length + props.tab.deleted.length + props.tab.inserts.length;
  const [where, setWhere] = createSignal(props.tab.where);
  const [orderBy, setOrderBy] = createSignal(props.tab.orderBy);
  const apply = () => setTableFilter(props.tab.id, where(), orderBy());
  let whereInput: HTMLInputElement | undefined;
  // Checked while typing: "click" on engines where double quotes name columns, LIKE without wildcards.
  const hints = createMemo(() => whereHints(where(), props.tab.columnsMeta.map((col) => col.name), kindOf(props.tab.connId)));
  const useFix = (fixed: string, run = false) => {
    setWhere(fixed);
    if (run || props.tab.where.trim()) apply();
    else whereInput?.focus();
  };
  // When the engine's error points inside the WHERE, select that spot in the box.
  createEffect(() => {
    const at = props.tab.errorAt;
    if (at === null || !whereInput) return;
    const text = whereInput.value;
    let from = at;
    let to = at;
    while (from > 0 && /[\w"'$]/.test(text[from - 1])) from--;
    while (to < text.length && /[\w"'$]/.test(text[to])) to++;
    queueMicrotask(() => {
      whereInput?.focus();
      whereInput?.setSelectionRange(from, Math.max(to, from + 1));
    });
  });
  let gridApi: GridApi | undefined;
  const [draft, setDraft] = createSignal<FilterDraft | null>(null);
  const openFilter = (filter: ColumnFilter, el?: HTMLElement) => {
    const rect = el?.getBoundingClientRect();
    setDraft({ filter, x: rect ? rect.left : window.innerWidth / 2 - 180, y: rect ? rect.bottom + 6 : 160 });
  };

  return (
    <div class="pane">
      <div class="pane-toolbar">
        <ObjIcon kind={props.tab.obj.kind === "view" ? "view" : "table"} size={16} />
        <strong class="obj-title">{props.tab.qualified}</strong>
        <span class="tag">{props.tab.obj.kind === "view" ? "vista" : "tabla"}</span>
        <Show when={conn()}>
          <span class="muted small">
            <span class="picker-dot" style={{ background: connColor(conn()) }} /> {conn()!.name}
          </span>
        </Show>
        <span class="spacer" />
        <div class="seg">
          <For each={[["data", "Datos"], ["columns", "Columnas"], ["indexes", "Índices"], ["keys", "Claves"], ["ddl", "DDL"]] as const}>
            {([id, label]) => (
              <button type="button" classList={{ on: props.tab.section === id }} onClick={() => setTableSection(props.tab.id, id)}>
                {label}
                <Show when={id === "columns" && props.tab.columnsMeta.length}><small>{props.tab.columnsMeta.length}</small></Show>
                <Show when={id === "indexes" && props.tab.indexes.length}><small>{props.tab.indexes.length}</small></Show>
                <Show when={id === "keys" && props.tab.keys.length}><small>{props.tab.keys.length}</small></Show>
              </button>
            )}
          </For>
        </div>
      </div>
      <Show when={props.tab.error}>
        <div class="banner error">
          <CircleAlert size={15} />
          <span class="banner-text">
            {props.tab.error}
            <Show when={hints().find((hint) => hint.kind === "dquote")}>
              {(hint) => <small class="banner-hint">{hint().message}</small>}
            </Show>
            <Show when={props.tab.rows.length}>
              <small class="banner-hint muted">La tabla muestra los datos de la consulta anterior.</small>
            </Show>
          </span>
          <Show when={hints().find((hint) => hint.kind === "dquote")}>
            {(hint) => <button type="button" class="btn tiny primary" onClick={() => useFix(hint().fixed, true)}>Corregir y reintentar</button>}
          </Show>
          <button type="button" class="btn tiny" onClick={() => void reloadTable(props.tab.id, true)}>Reintentar</button>
        </div>
      </Show>
      <Switch>
        <Match when={props.tab.section === "data"}>
          <div class="data-toolbar">
            <button type="button" class="tb-icon" title={withShortcut("Recargar", "reload-table")} onClick={() => void reloadTableSafe(props.tab.id)}><RefreshCw size={14} class={props.tab.loading ? "spin" : ""} /></button>
            <Show when={editable()}>
              <span class="tb-sep" />
              <button type="button" class="tb-icon" title="Añadir fila (Alt+Insert)" onClick={() => insertTableRow(props.tab.id)}><Plus size={15} /></button>
              <button type="button" class="tb-icon" title="Eliminar filas seleccionadas (Supr)" onClick={() => gridApi?.deleteSelected()}><Minus size={15} /></button>
              <button type="button" class="tb-icon" title="Revertir cambios" disabled={!changes()} onClick={() => revertTable(props.tab.id)}><Undo2 size={14} /></button>
              <button type="button" class="tb-btn submit" title="Guardar cambios (Ctrl+Intro)" disabled={!changes()} onClick={() => void saveTable(props.tab.id)}>
                <Check size={14} /> <span>Guardar{changes() ? ` (${changes()})` : ""}</span>
              </button>
            </Show>
            <span class="tb-sep" />
            <button type="button" class="tb-btn filter" classList={{ on: props.tab.filters.some((item) => item.enabled) }} title="Añadir un filtro por columna" disabled={!props.tab.columnsMeta.length} onClick={(event) => openFilter(newFilter(props.tab), event.currentTarget)}>
              <Filter size={13} /> <span>Filtro{props.tab.filters.length ? ` (${props.tab.filters.filter((item) => item.enabled).length})` : ""}</span>
            </button>
            <div class="filter-field" classList={{ warn: hints().length > 0, err: props.tab.errorAt !== null }}>
              <span>WHERE</span>
              <input
                ref={whereInput}
                value={where()}
                placeholder="id > 100 AND estado = 'ok'"
                spellcheck={false}
                onInput={(event) => setWhere(event.currentTarget.value)}
                onKeyDown={(event) => event.key === "Enter" && apply()}
              />
              <Show when={props.tab.where}><button type="button" class="icon-btn tiny" title="Quitar filtro" onClick={() => { setWhere(""); setTableFilter(props.tab.id, "", orderBy()); }}><X size={12} /></button></Show>
            </div>
            <div class="filter-field narrow">
              <span>ORDER BY</span>
              <input value={orderBy()} placeholder="1 DESC" spellcheck={false} onInput={(event) => setOrderBy(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && apply()} />
            </div>
            <span class="spacer" />
            <span class="muted small">
              {props.tab.loading && !props.tab.rows.length ? "Cargando…" : rowsLabel(props.tab.rows.length, props.tab.hasMore)}
              <Show when={props.tab.elapsedMs !== null}> · {formatMs(props.tab.elapsedMs)}</Show>
            </span>
            <Show when={props.tab.totalCount !== null} fallback={
              <button type="button" class="btn tiny" title="Contar todas las filas que cumplen los filtros" disabled={props.tab.counting || !props.tab.columnsMeta.length} onClick={() => void countTable(props.tab.id)}>{props.tab.counting ? "Contando…" : "Contar"}</button>
            }>
              <span class="tag count" title="Filas que cumplen los filtros">{props.tab.totalCount!.toLocaleString()} en total</span>
            </Show>
            <Show when={props.tab.hasMore}>
              <button type="button" class="btn tiny" onClick={() => void fetchAll(props.tab.id)}>Cargar todo</button>
            </Show>
            <Show when={!editable() && props.tab.columnsMeta.length}>
              <span class="tag" title={conn()?.readOnly ? "Conexión de solo lectura" : props.tab.obj.kind === "view" ? "Las vistas no se editan" : "Sin clave primaria"}>solo lectura</span>
            </Show>
            <Show when={editable()}>
              <button type="button" class="tb-icon" title="Importar datos (CSV, JSON, Excel)…" onClick={() => void startImport(props.tab.connId, props.tab.obj)}><Upload size={15} /></button>
            </Show>
            <button type="button" class="tb-icon" title="Exportar con los filtros actuales…" disabled={!props.tab.baseSelect} onClick={() => startTableExport(props.tab.id)}><Download size={15} /></button>
            <button type="button" class="tb-icon" title="Panel de valor / registro" classList={{ on: state.inspectorOpen && state.inspectorMode !== "history" }} onClick={() => toggleInspector("record")}><PanelRight size={15} /></button>
          </div>
          <Show when={hints().length && !props.tab.error}>
            <div class="where-hints">
              <For each={hints()}>
                {(hint) => (
                  <div class="where-hint" classList={{ info: hint.kind === "like" }}>
                    <Lightbulb size={13} />
                    <span>{hint.message}</span>
                    <button type="button" class="btn tiny" onClick={() => useFix(hint.fixed)}>{hint.fixLabel}</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <FilterChips tab={props.tab} onEdit={(filter, el) => openFilter(filter, el)} onAdd={(el) => openFilter(newFilter(props.tab), el)} />
          <Show when={draft()}>{(d) => <FilterEditor tab={props.tab} draft={d()} onClose={() => setDraft(null)} />}</Show>
          <Show when={props.tab.loading && !props.tab.rows.length}><div class="progress-bar" /></Show>
          <DataGrid
            columns={props.tab.gridCols}
            rows={rows()}
            resetKey={props.tab.gridCols}
            busyKey={props.tab.id}
            linkCols={linkCols()}
            linkLabel={(col) => {
              const fk = foreignKeyOf(props.tab, props.tab.gridCols[col]?.name ?? "");
              return fk ? fk.target.name : "";
            }}
            onFollow={(source, col) => {
              const fk = foreignKeyOf(props.tab, props.tab.gridCols[col]?.name ?? "");
              if (!fk) return;
              const row: Record<string, Cell> = {};
              const data = rows()[source] ?? [];
              props.tab.gridCols.forEach((c, i) => (row[c.name] = data[i] ?? null));
              void followForeignKey(props.tab, fk, row);
            }}
            pkCols={pkCols()}
            deleted={props.tab.deleted}
            edits={props.tab.edits}
            insertStart={props.tab.rows.length}
            hasMore={props.tab.hasMore}
            loading={props.tab.loading}
            editable={editable()}
            tableName={props.tab.qualified}
            dialect={kindOf(props.tab.connId)}
            api={(value) => (gridApi = value)}
            onEdit={(row, col, value) => editCell(props.tab.id, row, col, value)}
            lookup={(col) => {
              const name = props.tab.gridCols[col]?.name ?? "";
              const fk = foreignKeyOf(props.tab, name);
              return fk && fk.columns.length === 1 ? openFkLookup(props.tab, name) : null;
            }}
            onNeedMore={() => void fetchMore(props.tab.id)}
            onDelete={(list) => deleteTableRows(props.tab.id, list)}
            onClone={(row) => insertTableRow(props.tab.id, row)}
            onInsert={() => insertTableRow(props.tab.id)}
            onRevert={(row, col) => revertTableChange(props.tab.id, row, col)}
            sortState={props.tab.sort}
            onSortChange={(sort) => setTableSort(props.tab.id, sort)}
            onFilter={(quick) => upsertTableFilter(props.tab.id, { ...newFilter(props.tab, props.tab.gridCols[quick.col]?.name, quick.op, quick.value), enabled: true })}
            onExport={() => startTableExport(props.tab.id)}
            onSave={() => void saveTable(props.tab.id)}
            onColumnFilter={(col) => openFilter(newFilter(props.tab, props.tab.gridCols[col]?.name, "in"))}
            onActivate={(row, col) => {
              const r = rows();
              setState("inspect", { column: props.tab.gridCols[col].name, typeName: props.tab.gridCols[col].typeName, value: r[row]?.[col] ?? null });
              setState("record", { columns: props.tab.gridCols, row: r[row] ?? [], index: row });
              openInspector("value");
            }}
          />
          <Show when={changes()}>
            <div class="changes-bar">
              <span class="tab-dirty" />
              {changes()} {changes() === 1 ? "cambio pendiente" : "cambios pendientes"}
              <span class="spacer" />
              <button type="button" class="btn tiny" onClick={() => revertTable(props.tab.id)}>Revertir</button>
              <button type="button" class="btn tiny primary" onClick={() => void saveTable(props.tab.id)}>Revisar y guardar</button>
            </div>
          </Show>
        </Match>
        <Match when={props.tab.section === "columns"}>
          <div class="meta-scroll">
            <table class="meta">
              <thead>
                <tr><th>#</th><th>Columna</th><th>Tipo</th><th>Nulos</th><th>Por defecto</th><th>Clave</th></tr>
              </thead>
              <tbody>
                <For each={props.tab.columnsMeta}>
                  {(col, index) => (
                    <tr>
                      <td class="num">{index() + 1}</td>
                      <td><span class="cell-icon"><ObjIcon kind={col.primaryKey ? "pkcolumn" : "column"} size={14} /> <b>{col.name}</b></span></td>
                      <td><code>{col.typeName}</code></td>
                      <td>{col.nullable ? <span class="muted">null</span> : <span>not null</span>}</td>
                      <td><code class="muted">{col.default ?? ""}</code></td>
                      <td>{col.primaryKey ? <span class="tag key">PK</span> : ""}{col.identity ? <span class="tag">auto</span> : ""}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Match>
        <Match when={props.tab.section === "indexes" || props.tab.section === "keys"}>
          <div class="meta-scroll">
            <Show when={(props.tab.section === "indexes" ? props.tab.indexes : props.tab.keys).length} fallback={<p class="meta-empty">{props.tab.section === "indexes" ? "Sin índices" : "Sin claves foráneas"}</p>}>
              <table class="meta">
                <thead><tr><th>Nombre</th><th>Definición</th><Show when={props.tab.section === "keys"}><th /></Show></tr></thead>
                <tbody>
                  <For each={props.tab.section === "indexes" ? props.tab.indexes : props.tab.keys}>
                    {(node) => {
                      const fk = () => (props.tab.section === "keys" ? foreignKeys(props.tab).find((item) => item.name === node.name) : undefined);
                      return (
                        <tr classList={{ "fk-row": Boolean(fk()) }} onDblClick={() => fk() && void followForeignKey(props.tab, fk()!)}>
                          <td><span class="cell-icon"><ObjIcon kind={node.kind} size={14} /> <b>{node.name}</b></span></td>
                          <td><code>{node.detail}</code></td>
                          <Show when={props.tab.section === "keys"}>
                            <td class="fk-action">
                              <Show when={fk()}>
                                <button type="button" class="btn tiny" title="Abrir la tabla referenciada (doble clic en la fila)" onClick={() => void followForeignKey(props.tab, fk()!)}>
                                  Abrir {fk()!.target.name} <ArrowRight size={12} />
                                </button>
                              </Show>
                            </td>
                          </Show>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Match>
        <Match when={props.tab.section === "ddl"}>
          <div class="ddl-view">
            <div class="ddl-actions">
              <button type="button" class="btn tiny" onClick={() => void copyText(props.tab.ddl, "DDL copiado")}>Copiar</button>
              <button type="button" class="btn tiny" onClick={() => openQuery(props.tab.connId, props.tab.ddl, `${props.tab.obj.name}.sql`)}>Abrir en consola</button>
            </div>
            <CodeView doc={props.tab.ddl} kind={kindOf(props.tab.connId)} />
          </div>
        </Match>
      </Switch>
    </div>
  );
}

// ---------------------------------------------------------------- welcome

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "Trabajando tarde";
  if (hour < 13) return "Buenos días";
  if (hour < 21) return "Buenas tardes";
  return "Buenas noches";
}

function Welcome() {
  const [mood, setMood] = createSignal<"wave" | "idle" | "love">("wave");
  onMount(() => {
    const timer = window.setTimeout(() => setMood("idle"), 1800);
    return () => window.clearTimeout(timer);
  });
  const recent = () => state.connections.slice(0, 6);
  return (
    <div class="welcome">
      <div class="welcome-inner">
        <div class="welcome-hero">
          <Gib size={112} mood={mood()} onClick={() => { setMood("love"); window.setTimeout(() => setMood("idle"), 1400); }} />
          <div>
            <h1>{greeting()}</h1>
            <p>SQL rápido para cualquier base de datos.</p>
          </div>
        </div>
        <Show when={recent().length}>
          <h3>Conexiones</h3>
          <div class="welcome-conns">
            <For each={recent()}>
              {(conn) => (
                <button type="button" class="conn-card" onClick={() => { const id = openQuery(conn.id); void id; if (!state.sessions[conn.id]) void connect(conn.id); }}>
                  <EngineIcon kind={conn.kind} size={22} server={serverOf(conn.id)} />
                  <span>
                    <b>{conn.name}</b>
                    <small>{engineOf(conn.kind).label}{conn.host ? ` · ${conn.host}` : ""}</small>
                  </span>
                  <Show when={state.sessions[conn.id]}><i class="conn-dot on" style={{ background: connColor(conn) }} /></Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <h3>Empezar</h3>
        <div class="welcome-actions">
          <button type="button" class="action-card" onClick={() => openConnDialog()}>
            <Plus size={18} />
            <span><b>Nueva conexión</b><small>PostgreSQL, MySQL, SQL Server, SQLite…</small></span>
            <kbd>Ctrl+Alt+N</kbd>
          </button>
          <button type="button" class="action-card" onClick={() => openQuery(state.connections[0]?.id ?? null)}>
            <FileCode2 size={18} />
            <span><b>Nueva consola</b><small>Escribe y ejecuta SQL</small></span>
            <kbd>Ctrl+Mayús+L</kbd>
          </button>
          <button type="button" class="action-card" onClick={() => void openScript()}>
            <FolderOpen size={18} />
            <span><b>Abrir script</b><small>Un fichero .sql del disco</small></span>
            <kbd>Ctrl+O</kbd>
          </button>
          <button type="button" class="action-card" onClick={() => setState({ paletteOpen: true, paletteMode: "all" })}>
            <span class="kbd-glyph">⇧⇧</span>
            <span><b>Buscar en todo</b><small>Tablas, acciones y ajustes</small></span>
            <kbd>Mayús Mayús</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

export function inspectText(value: unknown) {
  return isNullCell(value as never) ? "NULL" : cellText(value as never);
}
