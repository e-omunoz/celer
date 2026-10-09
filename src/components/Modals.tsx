import { X } from "lucide-solid";
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { isTauri } from "../api";
import { Mark } from "../brand/Mark";
import { returnFocus } from "../focus";
import { themeChoices } from "../commands";
import {
  answerParams,
  answerPassword,
  applyTheme,
  dismissConfirm,
  kindOf,
  runPreview,
  saveSettings,
  setState,
  state,
} from "../state";
import { ACCENTS, type ThemeName } from "../types";
import { CodeView } from "./Editor";
import { ExportDialog } from "./ExportDialog";
import { AiSettings } from "./AiSettings";
import { SnippetSettings } from "./SnippetSettings";
import { KeymapSettings } from "./KeymapSettings";
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
import { DriversSettings, InformixGuideDialog, JdbcSetupDialog } from "./InformixDrivers";
import { ConnectionDialog } from "./ConnectionDialog";

export function Modals() {
  return (
    <>
      <Show when={state.connDialog}>{(cfg) => <ConnectionDialog cfg={cfg()} />}</Show>
      <Show when={state.settingsOpen}><SettingsDialog /></Show>
      <Show when={state.exportOpen}><ExportDialog /></Show>
      <Show when={importer.open}><ImportDialog /></Show>
      <Show when={state.aboutOpen}><AboutDialog /></Show>
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

export function Dialog(props: { title: string; onClose: () => void; children: JSX.Element; wide?: boolean; small?: boolean; class?: string }) {
  // Read before the children render (they focus their first field): it gets the focus back on close.
  const opener = document.activeElement;
  onCleanup(() => returnFocus(opener));
  onMount(() => {
    const key = (event: KeyboardEvent) => {
      // A shortcut being recorded takes Esc for itself (it cancels the recording, not the dialog).
      if (event.key === "Escape" && !state.capturingKeys) {
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

// ---------------------------------------------------------------- settings

const SECTIONS = [
  ["appearance", "Apariencia"],
  ["editor", "Editor y resultados"],
  ["templates", "Plantillas"],
  ["keys", "Atajos de teclado"],
  ["safety", "Seguridad"],
  ["ai", "IA y MCP"],
  ["drivers", "Drivers"],
] as const;

function SettingsDialog() {
  type Section = (typeof SECTIONS)[number][0];
  const section = () => (SECTIONS.some(([id]) => id === state.settingsSection) ? state.settingsSection : "appearance") as Section;
  const setSection = (id: Section) => setState("settingsSection", id);
  const s = () => state.settings;
  const close = () => {
    applyTheme();
    setState({ settingsOpen: false, settingsSection: "appearance" });
  };
  return (
    <Dialog title="Ajustes" wide class="settings" onClose={close}>
      <div class="settings-layout">
        <nav class="settings-nav">
          <For each={SECTIONS}>{([id, label]) => <button type="button" classList={{ on: section() === id }} onClick={() => setSection(id)}>{label}</button>}</For>
        </nav>
        <div class="settings-body">
          <Show when={section() === "appearance"}>
            <h4>Tema</h4>
            <div class="theme-grid">
              <For each={themeChoices}>
                {(theme) => (
                  <button
                    type="button"
                    class="theme-card"
                    classList={{ on: s().theme === theme.id }}
                    onMouseEnter={() => applyTheme(state.settings, theme.id)}
                    onMouseLeave={() => applyTheme()}
                    onClick={() => void saveSettings({ theme: theme.id as ThemeName })}
                  >
                    <ThemePreview theme={theme.id} />
                    <span>{theme.label}</span>
                  </button>
                )}
              </For>
            </div>
            <h4>Color de acento</h4>
            <div class="swatches">
              <For each={ACCENTS}>
                {(item) => <button type="button" class="swatch big" classList={{ on: s().accent.toLowerCase() === item.value.toLowerCase() }} style={{ background: item.value }} title={item.name} onClick={() => void saveSettings({ accent: item.value })} />}
              </For>
              <label class="swatch big custom" title="Personalizado">
                <input type="color" value={s().accent} onChange={(event) => void saveSettings({ accent: event.currentTarget.value })} />
              </label>
            </div>
            <div class="form-row">
              <label class="field">
                <span>Densidad</span>
                <div class="seg">
                  <button type="button" classList={{ on: s().density === "compact" }} onClick={() => void saveSettings({ density: "compact" })}>Compacta</button>
                  <button type="button" classList={{ on: s().density === "comfortable" }} onClick={() => void saveSettings({ density: "comfortable" })}>Cómoda</button>
                </div>
              </label>
              <label class="field">
                <span>Tamaño de la interfaz</span>
                <NumberStepper value={s().fontSize} min={11} max={18} onChange={(value) => void saveSettings({ fontSize: value })} />
              </label>
              <label class="field">
                <span>Compañero (Gib)</span>
                <select value={s().companion} onChange={(event) => void saveSettings({ companion: event.currentTarget.value as "off" | "quiet" | "normal" })}>
                  <option value="normal">Normal</option>
                  <option value="quiet">Silencioso</option>
                  <option value="off">Apagado</option>
                </select>
              </label>
              <label class="field">
                <span>Animaciones</span>
                <select value={s().motion} onChange={(event) => void saveSettings({ motion: event.currentTarget.value as "system" | "reduce" | "full" })}>
                  <option value="system">Como el sistema</option>
                  <option value="reduce">Reducidas</option>
                  <option value="full">Todas</option>
                </select>
              </label>
            </div>
          </Show>
          <Show when={section() === "editor"}>
            <div class="form-row">
              <label class="field">
                <span>Tamaño del editor</span>
                <NumberStepper value={s().editorFontSize} min={10} max={24} onChange={(value) => void saveSettings({ editorFontSize: value })} />
              </label>
              <label class="field">
                <span>Filas por página</span>
                <select value={String(s().pageSize)} onChange={(event) => void saveSettings({ pageSize: Number(event.currentTarget.value) })}>
                  <For each={[100, 200, 500, 1000, 2000, 5000, 10000]}>{(n) => <option value={n}>{n.toLocaleString()}</option>}</For>
                </select>
              </label>
            </div>
            <label class="check"><input type="checkbox" checked={s().zebra} onChange={(event) => void saveSettings({ zebra: event.currentTarget.checked })} /> Filas alternas en la tabla de resultados</label>
            <label class="check"><input type="checkbox" checked={s().askParams} onChange={(event) => void saveSettings({ askParams: event.currentTarget.checked })} /> Pedir el valor de los parámetros (<code>:nombre</code>, <code>?</code>, <code>{"${nombre}"}</code>) antes de ejecutar</label>
            <p class="settings-note">Los resultados llegan por páginas: solo se traen las filas que ves. «Cargar todo» lee el resto.</p>
          </Show>
          <Show when={section() === "templates"}>
            <SnippetSettings />
          </Show>
          <Show when={section() === "keys"}>
            <KeymapSettings />
          </Show>
          <Show when={section() === "safety"}>
            <label class="check"><input type="checkbox" checked={s().confirmNoWhere} onChange={(event) => void saveSettings({ confirmNoWhere: event.currentTarget.checked })} /> Confirmar UPDATE y DELETE sin WHERE en todas las conexiones</label>
            <label class="check"><input type="checkbox" checked={s().confirmMutations} onChange={(event) => void saveSettings({ confirmMutations: event.currentTarget.checked })} /> En conexiones de producción, confirmar UPDATE/DELETE sin WHERE, DROP, TRUNCATE y ALTER</label>
            <p class="settings-note">Las conexiones de solo lectura rechazan cualquier escritura. Las contraseñas van al almacén de credenciales del sistema.</p>
          </Show>
          <Show when={section() === "ai"}>
            <AiSettings />
          </Show>
          <Show when={section() === "drivers"}>
            <DriversSettings />
          </Show>
          <p class="settings-foot">{isTauri() ? "Aplicación de escritorio" : "Modo navegador: SQLite en memoria (demo)."} · Celer {state.appInfo.version} · {state.appInfo.dataDir}</p>
        </div>
      </div>
    </Dialog>
  );
}

function NumberStepper(props: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <div class="stepper">
      <button type="button" disabled={props.value <= props.min} onClick={() => props.onChange(props.value - 1)}>−</button>
      <span>{props.value}px</span>
      <button type="button" disabled={props.value >= props.max} onClick={() => props.onChange(props.value + 1)}>+</button>
    </div>
  );
}

/** A miniature of the real workspace rendered with a theme's tokens. */
function ThemePreview(props: { theme: string }) {
  const theme = () => (props.theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : props.theme);
  return (
    <div class="theme-preview" data-theme-preview={theme()}>
      <div class="tp-side">
        <i /><i /><i class="t" /><i class="t" /><i />
      </div>
      <div class="tp-main">
        <div class="tp-code">
          <span class="k">SELECT</span> <span class="n">id</span>, <span class="f">count</span>(*)<br />
          <span class="k">FROM</span> <span class="t">orders</span> <span class="k">WHERE</span> <span class="s">'ok'</span>
        </div>
        <div class="tp-grid"><i /><i /><i /></div>
      </div>
    </div>
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
