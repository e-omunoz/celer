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
  trustSshHostKey,
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
import { answerSecretsPassphrase, runConnectionsExport } from "../connManage";
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
      <Show when={state.connExport}>{(ask) => <ConnExportDialog ask={ask()} />}</Show>
      <Show when={state.secretsAsk}>{(ask) => <SecretsPassphraseDialog error={ask().error} />}</Show>
      <Show when={state.sshHostKey}>
        {(ask) => (
          <Dialog title="Clave del servidor SSH" onClose={() => setState("sshHostKey", null)} small class="ssh-hostkey">
            <p class="dialog-lead">{ask().text}</p>
            <Show when={ask().info}>
              {(info) => (
                <dl class="hostkey-facts">
                  <dt>Servidor</dt>
                  <dd>{info().host}:{info().port}</dd>
                  <dt>Tipo</dt>
                  <dd>{info().keyType}</dd>
                  <dt>Huella</dt>
                  <dd><code>{info().fingerprint}</code></dd>
                </dl>
              )}
            </Show>
            <p class="muted small">Compárala con la que te dé quien administra el servidor (en él: <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>). Si no coincide, no la aceptes.</p>
            <footer>
              <button type="button" class="btn" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => setState("sshHostKey", null)}>Cancelar</button>
              <button type="button" class="btn primary" onClick={() => void trustSshHostKey()}>Confiar en esta clave</button>
            </footer>
          </Dialog>
        )}
      </Show>
      <Show when={state.passwordAsk}>
        {(ask) => (
          <Dialog title={`Conectar a ${ask().name}`} onClose={() => answerPassword(null)} small>
            <form onSubmit={(event) => { event.preventDefault(); answerPassword(String(new FormData(event.currentTarget).get("password") ?? "")); }}>
              <label class="field">
                <span>{ask().label ?? "Contraseña"}</span>
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
 * «Exportar conexiones»: without passwords by default (the file as always). «Incluir contraseñas» asks for a passphrase
 * twice and the core encrypts every secret with it; «sin cifrar» exists only behind an explicit warning.
 */
function ConnExportDialog(props: { ask: { ids: string[]; title: string; count: number } }) {
  const [include, setInclude] = createSignal(false);
  const [first, setFirst] = createSignal("");
  const [second, setSecond] = createSignal("");
  const [plain, setPlain] = createSignal(false);
  const [understood, setUnderstood] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [tried, setTried] = createSignal(false);
  const close = () => setState("connExport", null);
  // In the browser there is no Argon2id: only in clear.
  const encryptable = () => isTauri();
  const problem = () => {
    if (!include()) return "";
    if (plain() || !encryptable()) return understood() ? "" : "Marca que entiendes que el fichero llevará las contraseñas sin cifrar.";
    if (first().length < 8) return "La contraseña del fichero tiene que tener al menos 8 caracteres.";
    if (first() !== second()) return "Las dos contraseñas no coinciden.";
    return "";
  };
  const run = async () => {
    setTried(true);
    if (problem() || busy()) return;
    setBusy(true);
    const secrets = include() ? { passphrase: plain() || !encryptable() ? null : first() } : null;
    const done = await runConnectionsExport(props.ask.ids, props.ask.title, secrets);
    setBusy(false);
    if (done) close();
  };
  const what = () => (props.ask.count === 1 ? "1 conexión" : `${props.ask.count} conexiones`);
  return (
    <Dialog title={`Exportar ${what()}`} onClose={close} class="conn-export">
      <form onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <p class="dialog-lead">Un fichero JSON con la configuración de las conexiones y sus carpetas, para compartirlas o llevarlas a otro equipo.</p>
        <label class="check"><input type="checkbox" checked={include()} onChange={(event) => setInclude(event.currentTarget.checked)} /> Incluir contraseñas</label>
        <Show when={!include()}>
          <small class="field-hint">Sin contraseñas: al importarlo, Celer las pedirá al conectar.</small>
        </Show>
        <Show when={include()}>
          <div class="export-secrets">
            <small class="field-hint">Van la contraseña de la base, las del túnel SSH (contraseña, frase de paso y clave pegada) y los parámetros secretos de la cadena ODBC y de «Parámetros extra».</small>
            <Show when={encryptable() && !plain()}>
              <div class="form-row">
                <label class="field grow">
                  <span>Contraseña del fichero</span>
                  <input type="password" value={first()} autocomplete="new-password" ref={(el) => queueMicrotask(() => el.focus())} onInput={(event) => setFirst(event.currentTarget.value)} />
                </label>
                <label class="field grow">
                  <span>Repítela</span>
                  <input type="password" value={second()} autocomplete="new-password" onInput={(event) => setSecond(event.currentTarget.value)} />
                </label>
              </div>
              <small class="field-hint">Cifra las contraseñas con Argon2id y AES-256-GCM. Sin ella no se pueden recuperar: guárdala aparte del fichero.</small>
            </Show>
            <Show when={encryptable()}>
              <label class="check danger"><input type="checkbox" checked={plain()} onChange={(event) => setPlain(event.currentTarget.checked)} /> Sin cifrar (no recomendado)</label>
            </Show>
            <Show when={plain() || !encryptable()}>
              <div class="export-warning" role="alert">
                <b>Las contraseñas irán en claro.</b> Cualquiera que abra el fichero, o una copia suya en el correo, un chat o una copia de seguridad, podrá
                leerlas y conectarse con ellas.
                <label class="check"><input type="checkbox" checked={understood()} onChange={(event) => setUnderstood(event.currentTarget.checked)} /> Lo entiendo: exportar sin cifrar</label>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={tried() && problem()}><small class="field-msg error" role="alert">{problem()}</small></Show>
        <footer>
          <button type="button" class="btn" onClick={close}>Cancelar</button>
          <button type="submit" class="btn primary" classList={{ danger: include() && (plain() || !encryptable()) }} disabled={busy()}>{busy() ? "Exportando…" : "Exportar…"}</button>
        </footer>
      </form>
    </Dialog>
  );
}

/** Importing a file with encrypted passwords: its passphrase, or without them, or cancel. */
function SecretsPassphraseDialog(props: { error: string }) {
  const [value, setValue] = createSignal("");
  return (
    <Dialog title="Fichero con contraseñas" onClose={() => answerSecretsPassphrase(null)} small>
      <form onSubmit={(event) => { event.preventDefault(); answerSecretsPassphrase(value()); }}>
        <p class="dialog-lead">El fichero trae las contraseñas cifradas. Escribe la contraseña con la que se exportó y se guardarán en el almacén de credenciales del sistema.</p>
        <label class="field">
          <span>Contraseña del fichero</span>
          <input type="password" value={value()} aria-invalid={Boolean(props.error)} ref={(el) => queueMicrotask(() => el.focus())} onInput={(event) => setValue(event.currentTarget.value)} />
          <Show when={props.error}><small class="field-msg error" role="alert">{props.error}</small></Show>
        </label>
        <footer>
          <button type="button" class="btn" onClick={() => answerSecretsPassphrase(null)}>Cancelar</button>
          <span class="spacer" />
          <button type="button" class="btn" onClick={() => answerSecretsPassphrase(false)}>Importar sin contraseñas</button>
          <button type="submit" class="btn primary" disabled={!value()}>Importar</button>
        </footer>
      </form>
    </Dialog>
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
            <p class="settings-note">Los resultados se leen por páginas con un cursor abierto: aunque la consulta devuelva millones de filas, sólo se traen las que ves. «Cargar todo» lee el resto bajo demanda.</p>
          </Show>
          <Show when={section() === "templates"}>
            <SnippetSettings />
          </Show>
          <Show when={section() === "keys"}>
            <KeymapSettings />
          </Show>
          <Show when={section() === "safety"}>
            <label class="check"><input type="checkbox" checked={s().confirmNoWhere} onChange={(event) => void saveSettings({ confirmNoWhere: event.currentTarget.checked })} /> En todas las conexiones, confirmar UPDATE y DELETE sin WHERE (el editor ya los subraya)</label>
            <label class="check"><input type="checkbox" checked={s().confirmMutations} onChange={(event) => void saveSettings({ confirmMutations: event.currentTarget.checked })} /> En conexiones de producción, confirmar UPDATE/DELETE sin WHERE, DROP, TRUNCATE y ALTER</label>
            <p class="settings-note">Las conexiones de solo lectura rechazan cualquier sentencia que modifique datos, también desde el núcleo en Rust. Las contraseñas se guardan en el almacén de credenciales del sistema operativo.</p>
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
