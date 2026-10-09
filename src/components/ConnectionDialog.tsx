import { BookOpen, CircleAlert, CircleCheck, Copy, FolderOpen, Lightbulb, LoaderCircle, Minus, OctagonX, X } from "lucide-solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { EngineIcon } from "../icons";
import { browseSqlite, connect, copyText, formatMs, plainError, setState, state, submitConnection, testConnection } from "../state";
import { knownFolders } from "../connManage";
import { ENGINES, emptyConn, engineOf, type ConnConfig, type ConnTestReport, type DbKind } from "../types";
import { applyJdbcUrl, defaultPort, hasErrors, looksLikeJdbcUrl, validateConn, visibleFields, withInstanceName, type FieldIssue, type IssueField } from "../connForm";
import { Dialog } from "./Modals";
import { openInformixGuide } from "./InformixDrivers";

/** Informix: what each protocol needs, under the protocol select. */
const INFORMIX_MODES: Record<string, string> = {
  auto: "El Client SDK si está instalado; si no, JDBC (Celer ofrece descargar lo que falte).",
  jdbc: "SQLI, el protocolo nativo (puerto 9088), con Java y el driver JDBC de IBM, como DBeaver.",
  sqli: "SQLI con el driver ODBC del Informix Client SDK, que tiene que estar instalado.",
  drda: "DRDA (a menudo el puerto 9089) con el driver IBM CLI: el servidor necesita un listener drsoctcp.",
};

/**
 * Folder of a connection: every folder (nested ones as "Clientes/Egarsat", and the empty ones created in the explorer),
 * "Sin carpeta", or "Nueva carpeta…" to type one.
 * (A <datalist> only suggests entries matching what is already typed, so other folders never showed.)
 */
function FolderPicker(props: { value: string; onChange: (folder: string) => void }) {
  const NEW = "__celer_new_folder__";
  const [typing, setTyping] = createSignal(Boolean(props.value) && !knownFolders().includes(props.value));
  return (
    <Show
      when={!typing()}
      fallback={
        <div class="folder-new">
          <input value={props.value} placeholder="Nombre de la carpeta" ref={(el) => queueMicrotask(() => el.focus())} onInput={(event) => props.onChange(event.currentTarget.value)} />
          <button type="button" class="icon-btn tiny" title="Elegir una carpeta existente" onClick={() => { setTyping(false); if (!knownFolders().includes(props.value)) props.onChange(""); }}>
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
        <For each={knownFolders()}>{(folder) => <option value={folder} selected={folder === props.value}>{folder}</option>}</For>
        <option value={NEW}>Nueva carpeta…</option>
      </select>
    </Show>
  );
}

/** The messages of one field, under it; a warning may offer its fix ("Separar"). */
function FieldMessages(props: { issues: FieldIssue[]; onFix: (patch: Partial<ConnConfig>) => void }) {
  return (
    <For each={props.issues}>
      {(issue) => (
        <small class="field-msg" classList={{ error: issue.level === "error", warning: issue.level === "warning" }} role={issue.level === "error" ? "alert" : undefined}>
          {issue.message}
          <Show when={issue.fix}>
            {(fix) => (
              <>
                {" "}
                <button type="button" class="text-link" onClick={() => props.onFix(fix())}>{issue.fixLabel ?? "Corregir"}</button>
              </>
            )}
          </Show>
        </small>
      )}
    </For>
  );
}

/** "Probar conexión": each step with its time, how Celer got there and, when it failed, what to do. */
function TestReportView(props: { report: ConnTestReport }) {
  const stepIcon = (status: string) => (status === "ok" ? <CircleCheck size={14} /> : status === "failed" ? <OctagonX size={14} /> : <Minus size={14} />);
  return (
    <div class="test-report">
      <div class="test-head">
        {props.report.ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
        <b>{props.report.ok ? "Conexión correcta" : "No se pudo conectar"}</b>
        <Show when={props.report.totalMs > 0}><span class="test-total">{formatMs(props.report.totalMs)}</span></Show>
      </div>
      <Show when={props.report.steps.length}>
        <ol class="test-steps">
          <For each={props.report.steps}>
            {(step) => (
              <li classList={{ [step.status]: true }}>
                <span class="step-icon" aria-label={step.status === "ok" ? "correcto" : step.status === "failed" ? "falló" : "no aplica"}>{stepIcon(step.status)}</span>
                <span class="step-label">{step.label}</span>
                <span class="step-detail" title={step.detail}>{step.detail}</span>
                <span class="step-ms">{step.status === "skipped" ? "—" : formatMs(step.ms)}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={props.report.serverInfo}>
        <div class="test-line"><span>Servidor</span><span>{props.report.serverInfo}</span></div>
      </Show>
      <Show when={props.report.route}>
        <div class="test-line"><span>Vía</span><span>{props.report.route}</span></div>
      </Show>
      <Show when={!props.report.ok && props.report.hint}>
        <div class="test-hint"><Lightbulb size={14} /><p>{props.report.hint}</p></div>
      </Show>
      <Show when={!props.report.ok && props.report.error}>
        <details class="test-error" open={!props.report.hint}>
          <summary>Error del driver</summary>
          <pre>{plainError(props.report.error)}</pre>
          <button type="button" class="btn tiny" onClick={() => void copyText(plainError(props.report.error), "Error copiado")}><Copy size={13} /> Copiar</button>
        </details>
      </Show>
    </div>
  );
}

export function ConnectionDialog(props: { cfg: ConnConfig }) {
  const [cfg, setCfg] = createSignal<ConnConfig>({ ...props.cfg });
  const [advanced, setAdvanced] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [urlNotes, setUrlNotes] = createSignal<string[]>([]);
  const [urlError, setUrlError] = createSignal("");
  // Messages show for the fields already left, and for every field after trying to save or test.
  const [touched, setTouched] = createSignal<Set<IssueField>>(new Set());
  const [tried, setTried] = createSignal(false);
  let form: HTMLFormElement | undefined;
  const set = <K extends keyof ConnConfig>(key: K, value: ConnConfig[K]) => setCfg({ ...cfg(), [key]: value });
  const kind = () => cfg().kind;
  const show = createMemo(() => visibleFields(cfg()));
  const editing = () => Boolean(props.cfg.id);
  const issues = createMemo(() => validateConn(cfg(), state.connections));
  const issuesOf = (field: IssueField) => (tried() || touched().has(field) ? issues().filter((issue) => issue.field === field) : []);
  const invalid = (field: IssueField) => issuesOf(field).some((issue) => issue.level === "error");
  const touch = (field: IssueField) => {
    if (!touched().has(field)) setTouched(new Set([...touched(), field]));
  };
  const fix = (patch: Partial<ConnConfig>) => setCfg({ ...cfg(), ...patch });

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
      // SQLite and generic ODBC have no database field: a value carried over could not be seen or cleared.
      database: next === "sqlite" || next === "odbc" ? "" : current.database,
    });
    setState({ testOutput: "", testOk: null, testReport: null });
  }

  /** The usual port goes with the protocol (SQLI 9088, DRDA 9089) unless the user typed another one. */
  function pickInformixMode(mode: string) {
    const port = cfg().port;
    const next = mode === "drda" ? 9089 : 9088;
    setCfg({ ...cfg(), informixMode: mode, port: port === 9088 || port === 9089 || port === null ? next : port });
  }

  /** Fills the form from a JDBC URL: engine, server, port, instance, database, user, encryption, extra parameters. */
  function applyUrl(text: string) {
    setUrl(text.trim());
    if (!text.trim()) {
      setUrlNotes([]);
      setUrlError("");
      return;
    }
    if (!looksLikeJdbcUrl(text)) {
      setUrlNotes([]);
      setUrlError("Una URL JDBC empieza por «jdbc:», por ejemplo jdbc:postgresql://servidor:5432/base.");
      return;
    }
    const applied = applyJdbcUrl(cfg(), text);
    if (!applied) {
      setUrlNotes([]);
      setUrlError("Celer no reconoce esta URL. Admite jdbc:sqlserver, jdbc:jtds:sqlserver, jdbc:informix-sqli, jdbc:ids, jdbc:postgresql, jdbc:mysql, jdbc:mariadb y jdbc:sqlite.");
      return;
    }
    setUrlError("");
    setUrlNotes(applied.notes);
    // Advanced settings the URL filled are opened, so nothing changes out of sight.
    if (applied.cfg.extra || applied.cfg.encryption !== cfg().encryption) setAdvanced(true);
    setCfg(applied.cfg);
    setState({ testOutput: "", testOk: null, testReport: null });
  }

  function autoName(c: ConnConfig) {
    if (c.name.trim()) return c.name.trim();
    if (c.kind === "sqlite") return c.filePath ? c.filePath.split(/[\\/]/).pop() || "SQLite" : "SQLite";
    return `${c.database ? `${c.database}@` : ""}${c.host || engineOf(c.kind).label}`;
  }

  /** Errors block saving and testing: they show at once, and the first wrong field gets the focus. */
  function blocked() {
    if (!hasErrors(issues())) return false;
    setTried(true);
    queueMicrotask(() => form?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
    return true;
  }

  async function save(andConnect: boolean) {
    if (blocked()) return;
    const c = { ...cfg(), name: autoName(cfg()) };
    try {
      const saved = await submitConnection(c);
      if (andConnect) void connect(saved.id, c.password || undefined);
    } catch (err) {
      setState({ testOutput: String(err), testOk: false, testReport: null });
    }
  }

  function test() {
    if (blocked()) return;
    void testConnection({ ...cfg(), name: autoName(cfg()) });
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
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void save(!editing());
          }}
        >
          <label class="field">
            <span>URL JDBC <small class="muted">(opcional: pégala y Celer rellena el formulario)</small></span>
            <input
              value={url()}
              spellcheck={false}
              placeholder="jdbc:sqlserver://servidor:1433;databaseName=…  ·  jdbc:postgresql://…  ·  jdbc:informix-sqli://…"
              aria-invalid={Boolean(urlError())}
              onInput={(event) => {
                // Typing it halfway does not complain yet: it applies on paste, Enter or leaving the field.
                const value = event.currentTarget.value;
                setUrl(value);
                if (!value.trim()) applyUrl("");
              }}
              onPaste={(event) => {
                const text = event.clipboardData?.getData("text") ?? "";
                if (!text.trim()) return;
                event.preventDefault();
                applyUrl(text);
              }}
              onChange={(event) => applyUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyUrl(event.currentTarget.value);
                }
              }}
            />
            <Show when={urlError()}><small class="field-msg error" role="alert">{urlError()}</small></Show>
            <Show when={urlNotes().length}>
              <div class="url-notes" role="status">
                <For each={urlNotes()}>{(note, index) => <small classList={{ "field-hint": index() === 0, "field-msg": index() > 0, warning: index() > 0 }}>{note}</small>}</For>
              </div>
            </Show>
          </label>

          <div class="form-row">
            <label class="field grow">
              <span>Nombre</span>
              <input value={cfg().name} placeholder={autoName({ ...cfg(), name: "" })} onInput={(event) => set("name", event.currentTarget.value)} onBlur={() => touch("name")} ref={(el) => queueMicrotask(() => el.focus())} />
              <FieldMessages issues={issuesOf("name")} onFix={fix} />
            </label>
            <label class="field" style={{ width: "170px" }}>
              <span>Carpeta</span>
              <FolderPicker value={cfg().folder} onChange={(folder) => set("folder", folder)} />
            </label>
          </div>

          <Show when={show().file}>
            <label class="field">
              <span>Fichero</span>
              <div class="input-group">
                <input value={cfg().filePath} placeholder="C:\datos\app.db  ·  :memory:" aria-invalid={invalid("filePath")} onInput={(event) => set("filePath", event.currentTarget.value)} onBlur={() => touch("filePath")} />
                <button type="button" class="btn" onClick={() => void browseSqlite((path) => set("filePath", path))}><FolderOpen size={14} /> Examinar</button>
                <button type="button" class="btn" onClick={() => set("filePath", ":memory:")}>Memoria</button>
              </div>
              <FieldMessages issues={issuesOf("filePath")} onFix={fix} />
              <small class="field-hint">Si el fichero no existe se crea al conectar.</small>
            </label>
          </Show>

          <Show when={show().odbc}>
            <label class="field">
              <span>Cadena de conexión</span>
              <textarea rows="3" spellcheck={false} value={cfg().odbcConnStr} aria-invalid={invalid("odbcConnStr")} placeholder="DSN=mi_origen;UID=usuario  o  DRIVER={…};SERVER=…  (la contraseña, abajo)" onInput={(event) => set("odbcConnStr", event.currentTarget.value)} onBlur={() => touch("odbcConnStr")} />
              <FieldMessages issues={issuesOf("odbcConnStr")} onFix={fix} />
            </label>
          </Show>

          <Show when={show().host}>
            <div class="form-row">
              <label class="field grow">
                <span>Servidor</span>
                <input
                  value={cfg().host}
                  placeholder="localhost"
                  spellcheck={false}
                  aria-invalid={invalid("host")}
                  onInput={(event) => set("host", event.currentTarget.value)}
                  onBlur={() => touch("host")}
                  onPaste={(event) => {
                    // A JDBC URL pasted here fills the whole form, as in "URL JDBC".
                    const text = event.clipboardData?.getData("text") ?? "";
                    if (looksLikeJdbcUrl(text)) {
                      event.preventDefault();
                      applyUrl(text);
                    }
                  }}
                />
                <FieldMessages issues={issuesOf("host")} onFix={fix} />
              </label>
              <label class="field" style={{ width: "96px" }}>
                <span>Puerto</span>
                <input
                  type="number"
                  value={cfg().port ?? ""}
                  placeholder={String(defaultPort(cfg()) ?? "")}
                  aria-invalid={invalid("port")}
                  onInput={(event) => set("port", event.currentTarget.value ? Number(event.currentTarget.value) : null)}
                  onBlur={() => touch("port")}
                />
                <FieldMessages issues={issuesOf("port")} onFix={fix} />
              </label>
            </div>
          </Show>

          <Show when={show().informixMode}>
            <label class="field">
              <span>Protocolo</span>
              <select value={cfg().informixMode} onChange={(event) => pickInformixMode(event.currentTarget.value)}>
                <option value="auto">Automático (recomendado)</option>
                <option value="jdbc">SQLI (JDBC)</option>
                <option value="sqli">SQLI (Client SDK / ODBC)</option>
                <option value="drda">DRDA (IBM CLI)</option>
              </select>
              <small class="field-hint">
                {INFORMIX_MODES[cfg().informixMode] ?? ""}{" "}
                <button type="button" class="text-link" onClick={() => openInformixGuide()}>¿Cuál elijo?</button>
              </small>
            </label>
          </Show>

          <Show when={show().user || show().password}>
            <div class="form-row">
              <Show when={show().user}>
                <label class="field grow">
                  <span>Usuario</span>
                  <input value={cfg().user} spellcheck={false} aria-invalid={invalid("user")} onInput={(event) => set("user", event.currentTarget.value)} onBlur={() => touch("user")} />
                  <FieldMessages issues={issuesOf("user")} onFix={fix} />
                </label>
              </Show>
              <Show when={show().password}>
                <label class="field grow">
                  <span>Contraseña</span>
                  <input type="password" value={cfg().password ?? ""} placeholder={editing() ? "sin cambios" : ""} onInput={(event) => set("password", event.currentTarget.value)} />
                </label>
              </Show>
            </div>
          </Show>

          <Show when={show().database || show().instance}>
            <div class="form-row">
              <Show when={show().database}>
                <label class="field grow">
                  <span>Base de datos</span>
                  <input
                    value={cfg().database}
                    spellcheck={false}
                    aria-invalid={invalid("database")}
                    placeholder={kind() === "postgres" ? "postgres" : kind() === "informix" && cfg().informixMode === "drda" ? "obligatoria por DRDA" : "opcional"}
                    onInput={(event) => set("database", event.currentTarget.value)}
                    onBlur={() => touch("database")}
                  />
                  <FieldMessages issues={issuesOf("database")} onFix={fix} />
                </label>
              </Show>
              <Show when={show().instance}>
                <label class="field grow">
                  <span>{show().instanceLabel}</span>
                  <input
                    value={cfg().instance}
                    spellcheck={false}
                    aria-invalid={invalid("instance")}
                    placeholder={kind() === "informix" ? "DBSERVERNAME o un alias" : "opcional (SQLEXPRESS…)"}
                    onInput={(event) => fix(withInstanceName(cfg(), event.currentTarget.value))}
                    onBlur={() => touch("instance")}
                  />
                  <FieldMessages issues={issuesOf("instance")} onFix={fix} />
                </label>
              </Show>
            </div>
          </Show>

          <Show when={show().savePassword || show().integratedAuth}>
            <div class="checks">
              <Show when={show().savePassword}>
                <label class="check"><input type="checkbox" checked={cfg().savePassword} onChange={(event) => set("savePassword", event.currentTarget.checked)} /> Recordar contraseña</label>
              </Show>
              <Show when={show().integratedAuth}>
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

          <button type="button" class="disclosure" aria-expanded={advanced()} onClick={() => setAdvanced(!advanced())}>{advanced() ? "▾" : "▸"} Opciones avanzadas</button>
          <Show when={advanced()}>
            <div class="advanced">
              <Show when={show().encryption}>
                <div class="form-row">
                  <label class="field grow">
                    <span>Cifrado SSL/TLS</span>
                    <select value={cfg().encryption} onChange={(event) => set("encryption", event.currentTarget.value)}>
                      <option value="required">Obligatorio</option>
                      <option value="login">Preferido</option>
                      <option value="off">Desactivado</option>
                    </select>
                  </label>
                  <Show when={show().trustCert}>
                    <label class="check" style={{ "align-self": "end", "padding-bottom": "6px" }}><input type="checkbox" checked={cfg().trustCert} onChange={(event) => set("trustCert", event.currentTarget.checked)} /> Confiar en el certificado</label>
                  </Show>
                </div>
              </Show>
              <Show when={show().extra}>
                <label class="field">
                  <span>Parámetros extra</span>
                  <input value={cfg().extra} spellcheck={false} aria-invalid={invalid("extra")} placeholder="clave=valor;clave2=valor2" onInput={(event) => set("extra", event.currentTarget.value)} onBlur={() => touch("extra")} />
                  <FieldMessages issues={issuesOf("extra")} onFix={fix} />
                </label>
              </Show>
              <label class="field">
                <span>Script al conectar <small class="muted">(se ejecuta en cada sesión nueva)</small></span>
                <textarea
                  class="startup-sql"
                  rows={3}
                  spellcheck={false}
                  value={cfg().startupSql ?? ""}
                  placeholder={kind() === "postgres" ? "SET search_path TO ventas, public;" : kind() === "mssql" ? "SET LOCK_TIMEOUT 5000;" : kind() === "mysql" ? "SET SESSION sql_mode = 'ANSI_QUOTES';" : "PRAGMA foreign_keys = ON;"}
                  onInput={(event) => set("startupSql", event.currentTarget.value)}
                />
              </label>
            </div>
          </Show>

          <Show when={state.testing || state.testOutput || state.testReport}>
            <div class="test-result" classList={{ ok: !state.testing && state.testOk === true, bad: !state.testing && state.testOk === false }} aria-live="polite">
              <Show when={!state.testing} fallback={<><LoaderCircle size={15} class="spin" /> Probando conexión…</>}>
                <Show
                  when={state.testReport}
                  fallback={
                    <>
                      {state.testOk ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
                      <pre>{state.testOutput}</pre>
                    </>
                  }
                >
                  {(report) => <TestReportView report={report()} />}
                </Show>
                <Show when={state.testGuide}>
                  <button type="button" class="btn tiny" onClick={() => openInformixGuide(state.testGuide)}><BookOpen size={13} /> Guía</button>
                </Show>
              </Show>
            </div>
          </Show>

          <footer>
            <button type="button" class="btn" disabled={state.testing} onClick={test}>Probar conexión</button>
            <Show when={tried() && hasErrors(issues())}><span class="field-msg error">Revisa los campos marcados</span></Show>
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
