import { CircleAlert, CircleCheck, FolderOpen, LoaderCircle, X } from "lucide-solid";
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { isTauri } from "../api";
import { Mark } from "../brand/Mark";
import { themeChoices } from "../commands";
import { EngineIcon } from "../icons";
import {
  answerParams,
  answerPassword,
  applyTheme,
  browseSqlite,
  connect,
  dismissConfirm,
  downloadDriver,
  kindOf,
  runPreview,
  saveSettings,
  setState,
  state,
  submitConnection,
  testConnection,
  connectionFolders,
} from "../state";
import { ACCENTS, ENGINES, emptyConn, engineOf, type ConnConfig, type DbKind, type ThemeName } from "../types";
import { CodeView } from "./Editor";
import { ExportDialog } from "./ExportDialog";
import { AiSettings } from "./AiSettings";
import { SnippetSettings } from "./SnippetSettings";
import { ImportDialog } from "./ImportDialog";
import { importer } from "../importer";
import { checkForUpdates, openReleasePage } from "../update";

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
  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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

// ---------------------------------------------------------------- connection

/**
 * Folder of a connection: every existing folder, "Sin carpeta", or "Nueva carpeta…" to type one.
 * (A <datalist> only suggests entries matching what is already typed, so other folders never showed.)
 */
function FolderPicker(props: { value: string; onChange: (folder: string) => void }) {
  const NEW = "__celer_new_folder__";
  const [typing, setTyping] = createSignal(Boolean(props.value) && !connectionFolders().includes(props.value));
  return (
    <Show
      when={!typing()}
      fallback={
        <div class="folder-new">
          <input value={props.value} placeholder="Nombre de la carpeta" ref={(el) => queueMicrotask(() => el.focus())} onInput={(event) => props.onChange(event.currentTarget.value)} />
          <button type="button" class="icon-btn tiny" title="Elegir una carpeta existente" onClick={() => { setTyping(false); if (!connectionFolders().includes(props.value)) props.onChange(""); }}>
            <X size={12} />
          </button>
        </div>
      }
    >
      <select
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === NEW) {
            setTyping(true);
            props.onChange("");
          } else props.onChange(value);
        }}
      >
        <option value="" selected={!props.value}>Sin carpeta</option>
        <For each={connectionFolders()}>{(folder) => <option value={folder} selected={folder === props.value}>{folder}</option>}</For>
        <option value={NEW}>Nueva carpeta…</option>
      </select>
    </Show>
  );
}

function ConnectionDialog(props: { cfg: ConnConfig }) {
  const [cfg, setCfg] = createSignal<ConnConfig>({ ...props.cfg });
  const [advanced, setAdvanced] = createSignal(false);
  const set = <K extends keyof ConnConfig>(key: K, value: ConnConfig[K]) => setCfg({ ...cfg(), [key]: value });
  const kind = () => cfg().kind;
  const network = () => kind() === "postgres" || kind() === "mysql" || kind() === "mssql" || kind() === "informix";
  const editing = () => Boolean(props.cfg.id);

  function pickEngine(next: DbKind) {
    const base = emptyConn(next);
    const current = cfg();
    setCfg({
      ...base,
      id: current.id,
      name: current.name,
      folder: current.folder,
      color: current.color,
      production: current.production,
      readOnly: current.readOnly,
      host: next === "sqlite" || next === "odbc" ? "" : current.host || "localhost",
      database: current.database,
    });
    setState({ testOutput: "", testOk: null });
  }

  function autoName(c: ConnConfig) {
    if (c.name.trim()) return c.name.trim();
    if (c.kind === "sqlite") return c.filePath ? c.filePath.split(/[\\/]/).pop() || "SQLite" : "SQLite";
    return `${c.database ? `${c.database}@` : ""}${c.host || engineOf(c.kind).label}`;
  }

  async function save(andConnect: boolean) {
    const c = { ...cfg(), name: autoName(cfg()) };
    try {
      const saved = await submitConnection(c);
      if (andConnect) void connect(saved.id, c.password || undefined);
    } catch (err) {
      setState({ testOutput: String(err), testOk: false });
    }
  }

  return (
    <Dialog title={editing() ? `Propiedades de ${props.cfg.name}` : "Nueva conexión"} wide class="conn-dialog" onClose={() => setState("connDialog", null)}>
      <div class="conn-layout">
        <nav class="engine-list">
          <For each={ENGINES}>
            {(engine) => (
              <button type="button" classList={{ on: kind() === engine.kind }} onClick={() => pickEngine(engine.kind)}>
                <EngineIcon kind={engine.kind} size={20} />
                <span>
                  <b>{engine.label}</b>
                  <small>{engine.hint}</small>
                </span>
              </button>
            )}
          </For>
        </nav>
        <form
          class="conn-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(!editing());
          }}
        >
          <div class="form-row">
            <label class="field grow">
              <span>Nombre</span>
              <input value={cfg().name} placeholder={autoName({ ...cfg(), name: "" })} onInput={(event) => set("name", event.currentTarget.value)} ref={(el) => queueMicrotask(() => el.focus())} />
            </label>
            <label class="field" style={{ width: "170px" }}>
              <span>Carpeta</span>
              <FolderPicker value={cfg().folder} onChange={(folder) => set("folder", folder)} />
            </label>
          </div>

          <Show when={kind() === "sqlite"}>
            <label class="field">
              <span>Fichero</span>
              <div class="input-group">
                <input value={cfg().filePath} placeholder="C:\datos\app.db  ·  :memory:" onInput={(event) => set("filePath", event.currentTarget.value)} />
                <button type="button" class="btn" onClick={() => void browseSqlite((path) => set("filePath", path))}><FolderOpen size={14} /> Examinar</button>
                <button type="button" class="btn" onClick={() => set("filePath", ":memory:")}>Memoria</button>
              </div>
              <small class="field-hint">Si el fichero no existe se crea al conectar.</small>
            </label>
          </Show>

          <Show when={kind() === "odbc"}>
            <label class="field">
              <span>Cadena de conexión</span>
              <textarea rows="3" spellcheck={false} value={cfg().odbcConnStr} placeholder="DSN=mi_origen;UID=usuario;PWD=…  o  DRIVER={…};SERVER=…" onInput={(event) => set("odbcConnStr", event.currentTarget.value)} />
            </label>
          </Show>

          <Show when={network()}>
            <div class="form-row">
              <label class="field grow">
                <span>Servidor</span>
                <input value={cfg().host} placeholder="localhost" spellcheck={false} onInput={(event) => set("host", event.currentTarget.value)} />
              </label>
              <label class="field" style={{ width: "96px" }}>
                <span>Puerto</span>
                <input type="number" value={cfg().port ?? ""} placeholder={String(engineOf(kind()).port ?? "")} onInput={(event) => set("port", event.currentTarget.value ? Number(event.currentTarget.value) : null)} />
              </label>
            </div>
            <div class="form-row">
              <label class="field grow">
                <span>Usuario</span>
                <input value={cfg().user} spellcheck={false} disabled={cfg().integratedAuth} onInput={(event) => set("user", event.currentTarget.value)} />
              </label>
              <label class="field grow">
                <span>Contraseña</span>
                <input type="password" value={cfg().password ?? ""} disabled={cfg().integratedAuth} placeholder={editing() ? "sin cambios" : ""} onInput={(event) => set("password", event.currentTarget.value)} />
              </label>
            </div>
            <div class="form-row">
              <label class="field grow">
                <span>Base de datos</span>
                <input value={cfg().database} spellcheck={false} placeholder={kind() === "postgres" ? "postgres" : "opcional"} onInput={(event) => set("database", event.currentTarget.value)} />
              </label>
              <Show when={kind() === "mssql" || kind() === "informix"}>
                <label class="field grow">
                  <span>{kind() === "informix" ? "INFORMIXSERVER" : "Instancia"}</span>
                  <input value={cfg().instance} spellcheck={false} onInput={(event) => set("instance", event.currentTarget.value)} />
                </label>
              </Show>
            </div>
            <div class="checks">
              <label class="check"><input type="checkbox" checked={cfg().savePassword} onChange={(event) => set("savePassword", event.currentTarget.checked)} /> Recordar contraseña</label>
              <Show when={kind() === "mssql"}>
                <label class="check"><input type="checkbox" checked={cfg().integratedAuth} onChange={(event) => set("integratedAuth", event.currentTarget.checked)} /> Autenticación de Windows</label>
              </Show>
            </div>
          </Show>

          <div class="checks">
            <label class="check"><input type="checkbox" checked={cfg().readOnly} onChange={(event) => set("readOnly", event.currentTarget.checked)} /> Solo lectura</label>
            <label class="check danger"><input type="checkbox" checked={cfg().production} onChange={(event) => set("production", event.currentTarget.checked)} /> Producción <small>(confirma cambios peligrosos)</small></label>
          </div>

          <div class="field">
            <span>Color</span>
            <div class="swatches">
              <button type="button" class="swatch none" classList={{ on: !cfg().color }} title="Automático" onClick={() => set("color", "")} />
              <For each={["#E5534B", "#E8833A", "#D4A72C", "#57AB5A", "#4A9BD9", "#986EE2", "#8B949E"]}>
                {(color) => <button type="button" class="swatch" classList={{ on: cfg().color.toLowerCase() === color.toLowerCase() }} style={{ background: color }} onClick={() => set("color", color)} />}
              </For>
            </div>
          </div>

          <Show when={network() || kind() === "sqlite"}>
            <button type="button" class="disclosure" onClick={() => setAdvanced(!advanced())}>{advanced() ? "▾" : "▸"} Opciones avanzadas</button>
            <Show when={advanced()}>
              <div class="advanced">
                <Show when={network() && kind() !== "informix"}>
                  <div class="form-row">
                    <label class="field grow">
                      <span>Cifrado SSL/TLS</span>
                      <select value={cfg().encryption} onChange={(event) => set("encryption", event.currentTarget.value)}>
                        <option value="required">Obligatorio</option>
                        <option value="login">Preferido</option>
                        <option value="off">Desactivado</option>
                      </select>
                    </label>
                    <label class="check" style={{ "align-self": "end", "padding-bottom": "6px" }}><input type="checkbox" checked={cfg().trustCert} onChange={(event) => set("trustCert", event.currentTarget.checked)} /> Confiar en el certificado</label>
                  </div>
                </Show>
                <Show when={kind() === "informix"}>
                  <label class="field">
                    <span>Protocolo</span>
                    <select value={cfg().informixMode} onChange={(event) => set("informixMode", event.currentTarget.value)}>
                      <option value="drda">DRDA (IBM CLI)</option>
                      <option value="sqli">SQLI (Client SDK / ODBC)</option>
                    </select>
                  </label>
                </Show>
                <label class="field">
                  <span>Parámetros extra</span>
                  <input value={cfg().extra} spellcheck={false} placeholder="clave=valor;clave2=valor2" onInput={(event) => set("extra", event.currentTarget.value)} />
                </label>
              </div>
            </Show>
          </Show>

          <Show when={state.testing || state.testOutput}>
            <div class="test-result" classList={{ ok: state.testOk === true, bad: state.testOk === false }}>
              <Show when={!state.testing} fallback={<><LoaderCircle size={15} class="spin" /> Probando conexión…</>}>
                {state.testOk ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
                <pre>{state.testOutput}</pre>
              </Show>
            </div>
          </Show>

          <footer>
            <button type="button" class="btn" disabled={state.testing} onClick={() => void testConnection({ ...cfg(), name: autoName(cfg()) })}>Probar conexión</button>
            <span class="spacer" />
            <button type="button" class="btn" onClick={() => setState("connDialog", null)}>Cancelar</button>
            <Show when={!editing()}><button type="button" class="btn" onClick={() => void save(false)}>Guardar</button></Show>
            <button type="submit" class="btn primary">{editing() ? "Guardar" : "Guardar y conectar"}</button>
          </footer>
        </form>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- settings

const SECTIONS = [
  ["appearance", "Apariencia"],
  ["editor", "Editor y resultados"],
  ["templates", "Plantillas"],
  ["safety", "Seguridad"],
  ["ai", "IA y MCP"],
  ["drivers", "Drivers"],
] as const;

function SettingsDialog() {
  const [section, setSection] = createSignal<(typeof SECTIONS)[number][0]>("appearance");
  const s = () => state.settings;
  const close = () => {
    applyTheme();
    setState("settingsOpen", false);
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
          <Show when={section() === "safety"}>
            <label class="check"><input type="checkbox" checked={s().confirmNoWhere} onChange={(event) => void saveSettings({ confirmNoWhere: event.currentTarget.checked })} /> En todas las conexiones, confirmar UPDATE y DELETE sin WHERE (el editor ya los subraya)</label>
            <label class="check"><input type="checkbox" checked={s().confirmMutations} onChange={(event) => void saveSettings({ confirmMutations: event.currentTarget.checked })} /> En conexiones de producción, confirmar UPDATE/DELETE sin WHERE, DROP, TRUNCATE y ALTER</label>
            <p class="settings-note">Las conexiones de solo lectura rechazan cualquier sentencia que modifique datos, también desde el núcleo en Rust. Las contraseñas se guardan en el almacén de credenciales del sistema operativo.</p>
          </Show>
          <Show when={section() === "ai"}>
            <AiSettings />
          </Show>
          <Show when={section() === "drivers"}>
            <p class="settings-note">PostgreSQL, MySQL/MariaDB, SQL Server y SQLite son nativos: no hace falta instalar nada. Informix (DRDA) usa el driver IBM Data Server, que Celer puede descargar.</p>
            <label class="field">
              <span>Ruta del driver IBM (opcional)</span>
              <input value={s().ibmDriverPath} placeholder="detección automática" onChange={(event) => void saveSettings({ ibmDriverPath: event.currentTarget.value })} />
            </label>
            <p class="settings-note">Estado: {state.driverPath || "no encontrado"} {state.driverProgress}</p>
            <button type="button" class="btn" disabled={!isTauri()} onClick={() => void downloadDriver()}>Descargar driver IBM</button>
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
