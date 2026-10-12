import { BookMarked, Braces, Code2, Copy, ExternalLink, Filter, History, Rows3, Search, Sparkles, Trash2, Variable, WrapText, X } from "lucide-solid";
import { VariablesPanel } from "./VariablesPanel";
import { guessEngines, isCompatible, kindLabel } from "../engineCompat";
import type { HistoryEntry } from "../types";
import { EngineBadge } from "./EngineBadge";
import { AiPanel } from "./AiPanel";
import { LibraryView, relative } from "./LibraryView";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { withShortcut } from "../commands";
import { prettyXml } from "../prettyXml";
import { cellText, isNullCell, prettyJson } from "../sql";
import { activeTab, clearHistory, connectionById, copyText, formatMs, openInspector, openQuery, refreshHistory, setState, state, useHistory } from "../state";
import { isTauri } from "../api";
import { detachPanel } from "../windows";

export function Inspector() {
  return (
    <aside class="inspector" style={{ width: `${state.settings.inspectorWidth}px` }}>
      <div class="toolwin-head">
        <div class="seg small">
          <button type="button" classList={{ on: state.inspectorMode === "value" }} title="Valor de la celda" onClick={() => openInspector("value")}><Braces size={13} /><span class="seg-label">Valor</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "record" }} title="Registro: la fila como formulario" onClick={() => openInspector("record")}><Rows3 size={13} /><span class="seg-label">Registro</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "history" }} title={withShortcut("Historial de consultas", "history")} onClick={() => openInspector("history")}><History size={13} /><span class="seg-label">Historial</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "library" }} title={withShortcut("Biblioteca de scripts guardados", "library")} onClick={() => openInspector("library")}><BookMarked size={13} /><span class="seg-label">Biblioteca</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "variables" }} title={withShortcut("Variables: ${nombre} con un valor por consola, conexión o global", "variables")} onClick={() => openInspector("variables")}><Variable size={13} /><span class="seg-label">Variables</span></button>
          <button type="button" classList={{ on: state.inspectorMode === "ai" }} title={withShortcut("Asistente IA", "ai")} onClick={() => openInspector("ai")}><Sparkles size={13} /><span class="seg-label">IA</span></button>
        </div>
        <span class="spacer" />
        <Show when={isTauri() && (state.inspectorMode === "library" || state.inspectorMode === "ai")}>
          <button type="button" class="icon-btn" title="Abrir en su propia ventana" onClick={() => void detachPanel(state.inspectorMode === "ai" ? "ai" : "library")}><ExternalLink size={14} /></button>
        </Show>
        <button type="button" class="icon-btn" title="Cerrar panel" onClick={() => setState("inspectorOpen", false)}><X size={14} /></button>
      </div>
      <Switch>
        <Match when={state.inspectorMode === "value"}><ValueView /></Match>
        <Match when={state.inspectorMode === "record"}><RecordView /></Match>
        <Match when={state.inspectorMode === "history"}><HistoryView /></Match>
        <Match when={state.inspectorMode === "library"}><LibraryView /></Match>
        <Match when={state.inspectorMode === "variables"}><VariablesPanel /></Match>
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

const HISTORY_COMPAT_KEY = "celer.history.onlyCompat";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function HistoryView() {
  let timer = 0;
  /** «Solo compatibles con esta conexión»: the entries that fit the active tab's engine. */
  const [onlyCompat, setOnlyCompat] = createSignal(readFlag(HISTORY_COMPAT_KEY));
  const activeKind = () => connectionById(activeTab()?.connId)?.kind;
  const guessOf = (entry: HistoryEntry) => guessEngines(entry.sql, { connKind: connectionById(entry.connId)?.kind });
  const entries = createMemo(() => {
    const kind = activeKind();
    const all = state.history.map((entry) => ({ entry, guess: guessOf(entry) }));
    return onlyCompat() && kind ? all.filter((item) => isCompatible(item.guess, kind)) : all;
  });
  const toggleCompat = () => {
    const on = !onlyCompat();
    setOnlyCompat(on);
    try {
      localStorage.setItem(HISTORY_COMPAT_KEY, on ? "1" : "0");
    } catch {
      // Not kept: it starts off next time.
    }
  };
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
        <button
          type="button"
          class="icon-btn"
          classList={{ on: onlyCompat() }}
          title={activeKind() ? `Solo las compatibles con esta conexión (${kindLabel(activeKind()!)})` : "Solo las compatibles con esta conexión (abre una consola con conexión)"}
          aria-pressed={onlyCompat()}
          onClick={toggleCompat}
        >
          <Filter size={14} />
        </button>
        <button type="button" class="icon-btn" title="Vaciar historial" onClick={() => void clearHistory()}><Trash2 size={14} /></button>
      </div>
      <div class="history-list">
        <Show when={!state.history.length}><p class="inspector-empty">Aún no hay consultas en el historial.</p></Show>
        <Show when={state.history.length && !entries().length}><p class="inspector-empty">Ninguna consulta del historial es compatible con {kindLabel(activeKind() ?? "odbc")}.</p></Show>
        <For each={entries()}>
          {({ entry, guess }) => (
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
                <EngineBadge guess={guess} kind={activeKind()} />
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
