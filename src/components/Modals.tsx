import { X } from "lucide-solid";
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Mark } from "../brand/Mark";
import { returnFocus } from "../focus";
import {
  answerParams,
  answerPassword,
  dismissConfirm,
  kindOf,
  runPreview,
  setState,
  state,
} from "../state";
import { CodeView } from "./Editor";
import { ExportDialog } from "./ExportDialog";
import { SettingsDialog } from "./settings/SettingsDialog";
import { ErrorLogView } from "./ErrorLogView";
import { errorLog } from "../errorLog";
import { ErDiagram } from "./ErDiagram";
import { ActivityView } from "./ActivityView";
import { SchemaCompareView } from "./SchemaCompareView";
import { schemaCompare } from "../schemaCompareRun";
import { DataCompareView } from "./DataCompareView";
import { dataCompare } from "../dataCompareRun";
import { ImportDialog } from "./ImportDialog";
import { importer } from "../importer";
import { checkForUpdates, openReleasePage } from "../update";
import { isDetached, isPanelWindow } from "../windows";
import { InformixGuideDialog, JdbcSetupDialog } from "./InformixDrivers";
import { ConnectionDialog } from "./ConnectionDialog";

export function Modals() {
  return (
    <>
      <Show when={state.connDialog}>{(cfg) => <ConnectionDialog cfg={cfg()} />}</Show>
      <Show when={state.settingsOpen}><SettingsDialog /></Show>
      <Show when={state.exportOpen}><ExportDialog /></Show>
      <Show when={importer.open}><ImportDialog /></Show>
      <Show when={state.aboutOpen}><AboutDialog /></Show>
      <Show when={errorLog.open}><ErrorLogView /></Show>
      <Show when={state.previewSql}>
        <Dialog title="Revisar cambios antes de guardar" wide onClose={() => setState({ previewSql: "", previewRun: null })}>
          <p class="dialog-lead">Se ejecutarán estas sentencias en una sola operación.</p>
          <div class="preview-code"><CodeView doc={state.previewSql} kind={kindOf(state.tabs.find((tab) => tab.id === state.activeTabId)?.connId)} /></div>
          <footer>
            <button type="button" class="btn" onClick={() => setState({ previewSql: "", previewRun: null })}>Cancelar</button>
            <button type="button" class="btn primary" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => void runPreview()}>Ejecutar y guardar</button>
          </footer>
        </Dialog>
      </Show>
      <Show when={state.confirm}>
        {(ask) => (
          <Dialog title={ask().title} onClose={dismissConfirm} small>
            <p class="dialog-lead">{ask().body}</p>
            <footer>
              <button type="button" class="btn" onClick={dismissConfirm}>Cancelar</button>
              <button type="button" class="btn" classList={{ danger: ask().danger, primary: !ask().danger }} ref={(el) => queueMicrotask(() => el.focus())} onClick={() => ask().run()}>{ask().confirmLabel}</button>
            </footer>
          </Dialog>
        )}
      </Show>
      <Show when={state.paramAsk}>{(ask) => <ParamsDialog ask={ask()} />}</Show>
      <Show when={state.jdbcSetup}><JdbcSetupDialog /></Show>
      <Show when={state.informixGuide}><InformixGuideDialog /></Show>
      {/* A panel window shows these itself; a comparison in a window of its own is not shown here too. */}
      <Show when={state.er && !isPanelWindow()}><ErDiagram /></Show>
      <Show when={state.activity}><ActivityView /></Show>
      <Show when={schemaCompare.open && !isPanelWindow() && !isDetached("schema-compare")}><SchemaCompareView /></Show>
      <Show when={dataCompare.open && !isPanelWindow() && !isDetached("data-compare")}><DataCompareView /></Show>
      <Show when={state.passwordAsk}>
        {(ask) => (
          <Dialog title={`Conectar a ${ask().name}`} onClose={() => answerPassword(null)} small>
            <form onSubmit={(event) => { event.preventDefault(); answerPassword(String(new FormData(event.currentTarget).get("password") ?? "")); }}>
              <label class="field">
                <span>Contraseña</span>
                <input name="password" type="password" ref={(el) => queueMicrotask(() => el.focus())} />
              </label>
              <footer>
                <button type="button" class="btn" onClick={() => answerPassword(null)}>Cancelar</button>
                <button type="submit" class="btn primary">Conectar</button>
              </footer>
            </form>
          </Dialog>
        )}
      </Show>
    </>
  );
}

/**
 * Values for the statement's parameters. Numbers, NULL, TRUE and FALSE go in as they are and the rest as text;
 * "SQL" writes the value verbatim (an expression, a list for IN…). Values are remembered per console.
 */
function ParamsDialog(props: { ask: NonNullable<typeof state.paramAsk> }) {
  const [values, setValues] = createSignal({ ...props.ask.values });
  const [raw, setRaw] = createSignal({ ...props.ask.raw });
  const label = (name: string) => (name.startsWith("?") ? `Parámetro ${name.slice(1)} (?)` : name);
  return (
    <Dialog title={props.ask.names.length === 1 ? "Valor del parámetro" : "Valores de los parámetros"} onClose={() => answerParams(null)} class="params-dialog">
      <form onSubmit={(event) => { event.preventDefault(); answerParams({ values: values(), raw: raw() }); }}>
        <p class="dialog-lead">
          La sentencia tiene {props.ask.names.length === 1 ? "un parámetro" : `${props.ask.names.length} parámetros`}. Los números, NULL, TRUE y FALSE se escriben tal
          cual; el resto, como texto entre comillas.
        </p>
        <div class="params-list">
          <For each={props.ask.names}>
            {(name, index) => (
              <label class="param-row">
                <span class="param-name">{label(name)}</span>
                <input
                  value={values()[name] ?? ""}
                  spellcheck={false}
                  ref={(el) => index() === 0 && queueMicrotask(() => el.select())}
                  onInput={(event) => setValues({ ...values(), [name]: event.currentTarget.value })}
                />
                <span class="check param-raw" title="Escribir el valor tal cual, sin comillas (una expresión, una lista para IN…)">
                  <input type="checkbox" checked={raw()[name] ?? false} onChange={(event) => setRaw({ ...raw(), [name]: event.currentTarget.checked })} /> SQL
                </span>
              </label>
            )}
          </For>
        </div>
        <footer>
          <span class="muted small">Se puede desactivar en Ajustes › Editor.</span>
          <span class="spacer" />
          <button type="button" class="btn" onClick={() => answerParams(null)}>Cancelar</button>
          <button type="submit" class="btn primary">Ejecutar</button>
        </footer>
      </form>
    </Dialog>
  );
}

/** Dialogs open, newest last: Esc closes only the one on top (a confirmation over Ajustes, not both). */
const openDialogs: symbol[] = [];

export function Dialog(props: { title: string; onClose: () => void; children: JSX.Element; wide?: boolean; small?: boolean; class?: string }) {
  // Read before the children render (they focus their first field): it gets the focus back on close.
  const opener = document.activeElement;
  const me = Symbol(props.title);
  openDialogs.push(me);
  onCleanup(() => {
    openDialogs.splice(openDialogs.indexOf(me), 1);
    returnFocus(opener);
  });
  onMount(() => {
    const key = (event: KeyboardEvent) => {
      // A shortcut being recorded takes Esc for itself (it cancels the recording, not the dialog).
      if (event.key === "Escape" && !state.capturingKeys && openDialogs[openDialogs.length - 1] === me) {
        event.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    onCleanup(() => window.removeEventListener("keydown", key, true));
  });
  return (
    <>
      <div class="scrim" onMouseDown={props.onClose} />
      <div class={`dialog ${props.class ?? ""}`} classList={{ wide: props.wide, small: props.small }} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button type="button" class="icon-btn" title="Cerrar (Esc)" onClick={props.onClose}><X size={15} /></button>
        </header>
        {props.children}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- export

function AboutDialog() {
  return (
    <Dialog title="Acerca de Celer" small onClose={() => setState("aboutOpen", false)}>
      <div class="about">
        <Mark size={56} />
        <h3>Celer</h3>
        <p>SQL rápido para cualquier base de datos.</p>
        <p class="muted small">Versión {state.appInfo.version || "dev"} · Tauri 2 · Rust · SolidJS</p>
        <div class="about-actions">
          <button type="button" class="btn tiny primary" onClick={() => { setState("aboutOpen", false); void checkForUpdates(true); }}>Buscar actualizaciones</button>
          <button type="button" class="btn tiny" onClick={() => void openReleasePage()}>Novedades en GitHub</button>
        </div>
      </div>
    </Dialog>
  );
}
