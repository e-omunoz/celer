import { CircleAlert, LoaderCircle, TriangleAlert } from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import { cancelRowHistory, closeRowHistory, loadRowHistory, rowHistory, setRowHistory } from "../rowHistory";
import { columnChanges, keyText, newestFirst, OP_LABEL, rangeText, timeText, unavailableText, userText, valueText } from "../rowHistoryView";
import type { RowHistoryEvent } from "../types";
import { Dialog } from "./Modals";

/** «Historial de la fila»: the changes of one row read from Informix's logical logs, newest first. */
export function RowHistoryDialog() {
  const result = () => rowHistory.result;
  const key = () => keyText(rowHistory.request?.key ?? []);
  return (
    <Dialog title={`Historial de la fila · ${rowHistory.title}`} wide class="row-history" onClose={closeRowHistory}>
      <p class="dialog-lead">
        Fila <code>{key()}</code>. Los valores salen de los logs lógicos del servidor (API CDC de Informix): solo lo que el log todavía tiene, sin
        suponer nada.
      </p>
      <Show when={rowHistory.loading}>
        <div class="rh-loading">
          <LoaderCircle size={16} class="spin" />
          <span>Leyendo los logs lógicos… puede tardar si hay muchos en disco.</span>
          <button type="button" class="btn tiny" onClick={cancelRowHistory}>Detener</button>
        </div>
      </Show>
      <Show when={rowHistory.error}>
        <p class="rh-box bad"><CircleAlert size={15} /> <span>{rowHistory.error}</span></p>
      </Show>
      <Show when={result()?.status === "unavailable"}>
        <p class="rh-box bad"><CircleAlert size={15} /> <span>{unavailableText(result()!.reason)}</span></p>
      </Show>
      <Show when={result()?.status === "needsFullRowLogging"}>
        <div class="rh-box warn">
          <TriangleAlert size={15} />
          <div>
            <p>{unavailableText(result()!.reason)}</p>
            <p class="muted">
              Celer puede activarlo solo para esta lectura y desactivarlo al terminar (<code>cdc_set_fullrowlogging</code>). Es un cambio en el servidor que
              necesita un usuario con permisos de administrador; mientras está activo, los cambios de la tabla ocupan más log. Los cambios anteriores siguen
              legibles: el log ya guarda la fila entera.
            </p>
            <button type="button" class="btn primary" onClick={() => void loadRowHistory(true)}>Activar solo durante la lectura y leer</button>
          </div>
        </div>
      </Show>
      <Show when={result()?.status === "ok" && result()}>
        {(h) => (
          <>
            <Show when={h().range}>{(range) => <p class="rh-range">{rangeText(range())}</p>}</Show>
            <Show when={h().partial.length}>
              <div class="rh-box warn">
                <TriangleAlert size={15} />
                <div>
                  <b>Historial parcial</b>
                  <ul>
                    <For each={h().partial}>{(why) => <li>{why}</li>}</For>
                  </ul>
                </div>
              </div>
            </Show>
            <Show when={h().notes.length || h().skipped.length}>
              <ul class="rh-notes">
                <For each={h().notes}>{(note) => <li>{note}</li>}</For>
                <Show when={h().skipped.length}>
                  <li>No incluidas (la API CDC no envía ese tipo): {h().skipped.join(", ")}.</li>
                </Show>
              </ul>
            </Show>
            <Show when={h().events.length} fallback={<p class="rh-empty">Sin cambios de esta fila en los logs disponibles.</p>}>
              <div class="rh-toolbar">
                <span class="muted small">{h().events.length === 1 ? "1 cambio" : `${h().events.length} cambios`}, del más reciente al más antiguo</span>
                <label class="check small">
                  <input type="checkbox" checked={rowHistory.allColumns} onChange={(event) => setRowHistory("allColumns", event.currentTarget.checked)} /> Todas las columnas
                </label>
              </div>
              <div class="rh-list">
                <For each={newestFirst(h().events)}>{(event) => <EventCard event={event} columns={h().columns} />}</For>
              </div>
            </Show>
          </>
        )}
      </Show>
      <footer>
        <Show when={result()?.status === "ok"}>
          <button type="button" class="btn" disabled={rowHistory.loading} onClick={() => void loadRowHistory(rowHistory.request?.enableFullRowLogging ?? false)}>Volver a leer</button>
        </Show>
        <button type="button" class="btn" onClick={closeRowHistory}>Cerrar</button>
      </footer>
    </Dialog>
  );
}

function EventCard(props: { event: RowHistoryEvent; columns: string[] }) {
  // «Ver la fila en este momento»: every column, as it was right after this change.
  const [whole, setWhole] = createSignal(false);
  const rows = () => columnChanges(props.columns, props.event, rowHistory.allColumns || whole());
  return (
    <section class={`rh-event ${props.event.op}`}>
      <header>
        <span class="rh-op">{OP_LABEL[props.event.op]}</span>
        <time>{timeText(props.event.time)}</time>
        <span class="muted small" title={`Posición en el log lógico: ${props.event.lsn}`}>
          transacción {props.event.tx} · {userText(props.event)} · log {props.event.lsn}
        </span>
        <span class="spacer" />
        <Show when={props.event.op !== "truncate"}>
          <button type="button" class="link small" onClick={() => setWhole(!whole())}>{whole() ? "Solo lo que cambió" : "Ver la fila en este momento"}</button>
        </Show>
      </header>
      <Show when={props.event.op !== "truncate"} fallback={<p class="muted small">Se vaciaron todas las filas de la tabla.</p>}>
        <table class="rh-values">
          <thead>
            <tr>
              <th>Columna</th>
              <Show when={props.event.op !== "insert"}><th>Antes</th></Show>
              <Show when={props.event.op !== "delete"}><th>Después</th></Show>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(change) => (
                <tr classList={{ changed: change.changed && props.event.op === "update" }}>
                  <td class="rh-col">{change.column}</td>
                  <Show when={props.event.op !== "insert"}>
                    <td classList={{ null: change.before === null }}>{props.event.before ? valueText(change.before) : "(sin imagen anterior)"}</td>
                  </Show>
                  <Show when={props.event.op !== "delete"}>
                    <td classList={{ null: change.after === null }}>{valueText(change.after)}</td>
                  </Show>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  );
}
