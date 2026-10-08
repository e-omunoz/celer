import { BookMarked, BookmarkPlus, Braces, Code2, Copy, History, Pencil, Rows3, Search, Sparkles, Trash2, WrapText, X } from "lucide-solid";
import { AiPanel } from "./AiPanel";
import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { cancelNaming, deleteLibraryScript, filteredScripts, finishNaming, library, loadLibrary, openLibraryScript, renameLibraryScript, saveToLibrary, setLibrary, type LibraryScript } from "../library";
import { shortcutLabel, withShortcut } from "../commands";
import { prettyXml } from "../prettyXml";
import { cellText, isNullCell, prettyJson } from "../sql";
import { activeSql, clearHistory, confirmDialog, connectionById, copyText, formatMs, openInspector, openQuery, refreshHistory, setState, state, useHistory } from "../state";

export function Inspector() {
  return (
    <aside class="inspector" style={{ width: `${state.settings.inspectorWidth}px` }}>
      <div class="toolwin-head">
        <div class="seg small">
          <button type="button" classList={{ on: state.inspectorMode === "value" }} title="Valor de la celda" onClick={() => openInspector("value")}><Braces size={13} /><span class="seg-label">Valor</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "record" }} title="Registro: la fila como formulario" onClick={() => openInspector("record")}><Rows3 size={13} /><span class="seg-label">Registro</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "history" }} title={withShortcut("Historial de consultas", "history")} onClick={() => openInspector("history")}><History size={13} /><span class="seg-label">Historial</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "library" }} title="Biblioteca de scripts guardados" onClick={() => openInspector("library")}><BookMarked size={13} /><span class="seg-label">Biblioteca</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "ai" }} title={withShortcut("Asistente IA", "ai")} onClick={() => openInspector("ai")}><Sparkles size={13} /><span class="seg-label">IA</span></button>
        </div>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Cerrar panel" onClick={() => setState("inspectorOpen", false)}><X size={14} /></button>
      </div>
      <Switch>
        <Match when={state.inspectorMode === "value"}><ValueView /></Match>
        <Match when={state.inspectorMode === "record"}><RecordView /></Match>
        <Match when={state.inspectorMode === "history"}><HistoryView /></Match>
        <Match when={state.inspectorMode === "library"}><LibraryView /></Match>
        <Match when={state.inspectorMode === "ai"}><AiPanel /></Match>
      </Switch>
    </aside>
  );
}

function ValueView() {
  const [wrap, setWrap] = createSignal(true);
  const [formatJson, setFormatJson] = createSignal(true);
  const value = () => state.inspect;
  const text = createMemo(() => {
    const v = value();
    if (!v || isNullCell(v.value)) return "";
    const raw = cellText(v.value);
    return formatJson() ? prettyJson(raw) ?? prettyXml(raw) ?? raw : raw;
  });
  /** JSON or XML that can be shown indented. */
  const structured = createMemo((): "JSON" | "XML" | null => {
    const v = value();
    if (!v || isNullCell(v.value)) return null;
    const raw = cellText(v.value);
    return prettyJson(raw) !== null ? "JSON" : prettyXml(raw) !== null ? "XML" : null;
  });
  return (
    <Show when={value()} fallback={<p class="inspector-empty">Selecciona una celda para ver su valor completo.</p>}>
      <div class="value-head">
        <b>{value()!.column}</b>
        <span class="muted">{value()!.typeName}</span>
        <span class="spacer" />
        <Show when={structured()}>
          <button type="button" class="icon-btn" classList={{ on: formatJson() }} title={`Formatear ${structured()}`} onClick={() => setFormatJson(!formatJson())}>
            {structured() === "XML" ? <Code2 size={14} /> : <Braces size={14} />}
          </button>
        </Show>
        <button type="button" class="icon-btn" classList={{ on: wrap() }} title="Ajuste de línea" onClick={() => setWrap(!wrap())}><WrapText size={14} /></button>
        {/* The stored value, not the indented view (XML and JSON would come back altered). */}
        <button type="button" class="icon-btn" title="Copiar valor" onClick={() => void copyText(isNullCell(value()!.value) ? "NULL" : cellText(value()!.value))}><Copy size={14} /></button>
      </div>
      <Show when={!isNullCell(value()!.value)} fallback={<div class="value-null">NULL</div>}>
        <pre class="value-text" classList={{ nowrap: !wrap() }}>{text()}</pre>
        <div class="value-foot muted">{cellText(value()!.value).length.toLocaleString()} caracteres</div>
      </Show>
    </Show>
  );
}

function RecordView() {
  const [filter, setFilter] = createSignal("");
  const record = () => state.record;
  const fields = createMemo(() => {
    const r = record();
    if (!r) return [];
    const f = filter().toLowerCase();
    return r.columns.map((col, index) => ({ col, value: r.row[index] })).filter((item) => !f || item.col.name.toLowerCase().includes(f) || cellText(item.value).toLowerCase().includes(f));
  });
  return (
    <Show when={record()} fallback={<p class="inspector-empty">Selecciona una fila para verla como formulario.</p>}>
      <div class="record-head">
        <span class="muted">Fila {(record()!.index + 1).toLocaleString()}</span>
        <div class="mini-search">
          <Search size={12} />
          <input placeholder="Filtrar campos" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} />
        </div>
      </div>
      <div class="record">
        <For each={fields()}>
          {(item) => (
            <div class="record-field" onClick={() => setState("inspect", { column: item.col.name, typeName: item.col.typeName, value: item.value ?? null })} onDblClick={() => openInspector("value")}>
              <div class="record-label">
                <span>{item.col.name}</span>
                <small>{item.col.typeName}</small>
              </div>
              <div class="record-value" classList={{ null: isNullCell(item.value), num: item.col.kind === "number" }}>
                {isNullCell(item.value) ? "NULL" : cellText(item.value)}
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function HistoryView() {
  let timer = 0;
  return (
    <>
      <div class="record-head">
        <div class="mini-search grow">
          <Search size={12} />
          <input
            placeholder="Buscar en el historial"
            value={state.historyQuery}
            onInput={(event) => {
              setState("historyQuery", event.currentTarget.value);
              window.clearTimeout(timer);
              timer = window.setTimeout(() => void refreshHistory(), 150);
            }}
          />
        </div>
        <button type="button" class="icon-btn" title="Vaciar historial" onClick={() => void clearHistory()}><Trash2 size={14} /></button>
      </div>
      <div class="history-list">
        <Show when={!state.history.length}><p class="inspector-empty">Aún no hay consultas en el historial.</p></Show>
        <For each={state.history}>
          {(entry) => (
            <button
              type="button"
              class="history-item"
              title="Clic: pegar en la consola · Doble clic: abrir en una consola nueva"
              onClick={() => void useHistory(entry.sql, entry.connId)}
              onDblClick={() => openQuery(connectionById(entry.connId) ? entry.connId : null, entry.sql)}
            >
              <code>{entry.sql.replace(/\s+/g, " ").slice(0, 240)}</code>
              <small>
                <i classList={{ ok: entry.ok, bad: !entry.ok }} />
                {entry.connName || "—"} · {relative(entry.at)}
                {entry.ok ? ` · ${formatMs(entry.elapsedMs)}${entry.rows !== null ? ` · ${entry.rows.toLocaleString()} filas` : ""}` : " · error"}
              </small>
            </button>
          )}
        </For>
      </div>
    </>
  );
}

function LibraryView() {
  onMount(() => void loadLibrary());
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const focusSelect = (el: HTMLInputElement) => queueMicrotask(() => {
    el.focus();
    el.select();
  });
  const remove = async (script: LibraryScript) => {
    if (await confirmDialog("Borrar de la biblioteca", `Se borra «${script.name}» de la biblioteca. Las consolas abiertas conservan su texto.`, "Borrar", true)) void deleteLibraryScript(script.id);
  };
  return (
    <>
      <Show when={library.naming}>
        {(naming) => (
          <form
            class="library-name"
            onSubmit={(event) => {
              event.preventDefault();
              void finishNaming(new FormData(event.currentTarget).get("name") as string);
            }}
          >
            <label for="library-name">Nombre del script</label>
            <div class="library-name-row">
              <input
                id="library-name"
                name="name"
                value={naming().name}
                ref={focusSelect}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    cancelNaming();
                  }
                }}
              />
              <button type="submit" class="btn primary tiny">Guardar</button>
              <button type="button" class="btn tiny" onClick={cancelNaming}>Cancelar</button>
            </div>
          </form>
        )}
      </Show>
      <div class="record-head">
        <div class="mini-search grow">
          <Search size={12} />
          <input placeholder="Buscar en la biblioteca" value={library.query} onInput={(event) => setLibrary("query", event.currentTarget.value)} />
        </div>
        <button type="button" class="icon-btn" title={withShortcut("Guardar la consola actual en la biblioteca", "save-library")} disabled={!activeSql()} onClick={() => void saveToLibrary()}><BookmarkPlus size={14} /></button>
      </div>
      <div class="history-list">
        <Show when={library.loaded && !library.scripts.length}>
          <p class="inspector-empty">
            La biblioteca está vacía. Guarda aquí las consultas que repites
            {shortcutLabel("save-library") ? ` con ${shortcutLabel("save-library")}` : " con el botón de arriba"} desde la consola.
          </p>
        </Show>
        <Show when={library.scripts.length && !filteredScripts().length}>
          <p class="inspector-empty">Ningún script coincide con la búsqueda.</p>
        </Show>
        <For each={filteredScripts()}>
          {(script) => (
            <div class="library-item" classList={{ open: activeSql()?.libraryId === script.id }}>
              <Show
                when={renaming() === script.id}
                fallback={
                  <button type="button" class="history-item" title="Abrir en una consola" onClick={() => openLibraryScript(script.id)}>
                    <b class="library-title">{script.name}</b>
                    <code>{script.sql.replace(/\s+/g, " ").slice(0, 180)}</code>
                    <small>{connectionById(script.connId)?.name ?? "Sin conexión"} · {relative(script.updatedAt)}</small>
                  </button>
                }
              >
                <input
                  class="library-rename"
                  value={script.name}
                  ref={focusSelect}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void renameLibraryScript(script.id, event.currentTarget.value);
                      setRenaming(null);
                    } else if (event.key === "Escape") {
                      event.stopPropagation();
                      setRenaming(null);
                    }
                  }}
                  onBlur={(event) => {
                    if (renaming() === script.id) void renameLibraryScript(script.id, event.currentTarget.value);
                    setRenaming(null);
                  }}
                />
              </Show>
              <div class="library-actions">
                <button type="button" class="icon-btn" title="Renombrar" onClick={() => setRenaming(script.id)}><Pencil size={13} /></button>
                <button type="button" class="icon-btn" title="Borrar de la biblioteca" onClick={() => void remove(script)}><Trash2 size={13} /></button>
              </div>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

function relative(at: number) {
  const diff = Date.now() - at;
  if (diff < 60_000) return "ahora";
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`;
  return new Date(at).toLocaleDateString();
}
