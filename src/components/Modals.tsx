import { For, Show } from "solid-js";
import { isTauri } from "../api";
import { ACCENTS, type ThemeName } from "../types";
import {
  answerPassword,
  applyTheme,
  browseSqlite,
  dismissConfirm,
  downloadDriver,
  refreshConnections,
  runExport,
  runPreview,
  saveSettings,
  setState,
  state,
  submitConnection,
  testConnection,
} from "../state";
import type { ConnConfig, DbKind } from "../types";
import { prettyJson } from "../sql";

export function Modals() {
  return (
    <>
      <Show when={state.connDialog}>{(cfg) => <ConnectionDialog cfg={cfg()} />}</Show>
      <Show when={state.settingsOpen}><SettingsDialog /></Show>
      <Show when={state.exportOpen}><ExportDialog /></Show>
      <Show when={state.valueText !== null}>
        <dialog class="modal" open>
          <header><h2>Valor</h2><button type="button" onClick={() => setState("valueText", null)}>✕</button></header>
          <pre class="code">{prettyJson(state.valueText ?? "") ?? state.valueText}</pre>
        </dialog>
      </Show>
      <Show when={state.previewSql}>
        <dialog class="modal wide" open>
          <header><h2>SQL antes de guardar</h2><button type="button" onClick={() => setState({ previewSql: "", previewRun: null })}>✕</button></header>
          <pre class="code">{state.previewSql}</pre>
          <footer>
            <button type="button" class="btn" onClick={() => setState({ previewSql: "", previewRun: null })}>Cancelar</button>
            <button type="button" class="btn primary" onClick={() => void runPreview()}>Ejecutar</button>
          </footer>
        </dialog>
      </Show>
      <Show when={state.confirm}>
        {(ask) => (
          <dialog class="modal" open>
            <header><h2>{ask().title}</h2></header>
            <p>{ask().body}</p>
            <footer>
              <button type="button" class="btn" onClick={dismissConfirm}>Cancelar</button>
              <button type="button" class="btn danger" onClick={() => ask().run()}>{ask().confirmLabel}</button>
            </footer>
          </dialog>
        )}
      </Show>
      <Show when={state.passwordAsk}>
        {(ask) => (
          <form class="modal dialog" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); answerPassword(String(data.get("password") ?? "")); }}>
            <header><h2>Contraseña</h2></header>
            <p>Contraseña para {ask().name}</p>
            <input name="password" type="password" autofocus />
            <footer>
              <button type="button" class="btn" onClick={() => answerPassword(null)}>Cancelar</button>
              <button type="submit" class="btn primary">Conectar</button>
            </footer>
          </form>
        )}
      </Show>
    </>
  );
}

function ConnectionDialog(props: { cfg: ConnConfig }) {
  return (
    <form
      class="modal dialog wide"
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        void submitConnection(data).catch((err) => setState("testOutput", String(err)));
      }}
    >
      <header><h2>{props.cfg.id ? "Editar conexión" : "Nueva conexión"}</h2><button type="button" onClick={() => setState("connDialog", null)}>✕</button></header>
      <div class="form-grid">
        <label>Nombre<input name="name" required value={props.cfg.name} /></label>
        <label>Motor
          <select name="kind" value={props.cfg.kind} onChange={(event) => { const data = readForm(event.currentTarget.form!); setState("connDialog", { ...data, kind: event.currentTarget.value as DbKind }); }}>
            <option value="sqlite">SQLite</option>
            <option value="mssql">SQL Server</option>
            <option value="informix">Informix</option>
            <option value="odbc">ODBC</option>
          </select>
        </label>
        <label>Carpeta<input name="folder" value={props.cfg.folder} list="folders" /></label>
        <label>Color<input name="color" type="color" value={props.cfg.color || "#c2410c"} /></label>
        <Show when={props.cfg.kind === "sqlite"}>
          <label class="span">Fichero
            <span class="row">
              <input name="filePath" value={props.cfg.filePath} placeholder="ruta, o :memory:" />
              <button type="button" class="btn" onClick={(event) => { const data = readForm(event.currentTarget.form!); void browseSqlite(data, (filePath) => setState("connDialog", { ...data, filePath })); }}>Examinar</button>
              <button type="button" class="btn" onClick={(event) => { const data = readForm(event.currentTarget.form!); setState("connDialog", { ...data, filePath: ":memory:" }); }}>Memoria</button>
            </span>
          </label>
        </Show>
        <Show when={props.cfg.kind === "odbc"}>
          <label class="span">Cadena de conexión<textarea name="odbcConnStr" rows="3">{props.cfg.odbcConnStr}</textarea></label>
        </Show>
        <Show when={props.cfg.kind === "mssql" || props.cfg.kind === "informix"}>
          <label>Servidor<input name="host" value={props.cfg.host} /></label>
          <label>Puerto<input name="port" type="number" value={props.cfg.port ?? ""} /></label>
          <label>Base de datos<input name="database" value={props.cfg.database} /></label>
          <label>{props.cfg.kind === "informix" ? "INFORMIXSERVER" : "Instancia"}<input name="instance" value={props.cfg.instance} /></label>
          <label>Usuario<input name="user" value={props.cfg.user} /></label>
          <label>Contraseña<input name="password" type="password" placeholder={props.cfg.id ? "dejar vacío para no cambiar" : ""} /></label>
        </Show>
        <Show when={props.cfg.kind === "mssql"}>
          <label>Cifrado
            <select name="encryption" value={props.cfg.encryption}>
              <option value="required">required</option>
              <option value="login">login</option>
              <option value="off">off</option>
            </select>
          </label>
          <label class="check"><input name="integratedAuth" type="checkbox" checked={props.cfg.integratedAuth} /> Autenticación de Windows</label>
          <label class="check"><input name="trustCert" type="checkbox" checked={props.cfg.trustCert} /> Confiar en el certificado</label>
        </Show>
        <Show when={props.cfg.kind === "informix"}>
          <label>Modo
            <select name="informixMode" value={props.cfg.informixMode}>
              <option value="drda">DRDA (IBM CLI)</option>
              <option value="sqli">SQLI (CSDK / ODBC)</option>
            </select>
          </label>
        </Show>
        <label class="span">Parámetros extra<input name="extra" value={props.cfg.extra} /></label>
        <label class="check"><input name="savePassword" type="checkbox" checked={props.cfg.savePassword} /> Recordar contraseña</label>
        <label class="check"><input name="readOnly" type="checkbox" checked={props.cfg.readOnly} /> Solo lectura</label>
        <label class="check"><input name="production" type="checkbox" checked={props.cfg.production} /> Producción</label>
      </div>
      <datalist id="folders">
        <For each={[...new Set(state.connections.map((conn) => conn.folder).filter(Boolean))]}>{(folder) => <option value={folder} />}</For>
      </datalist>
      <Show when={state.testOutput}><pre class="code">{state.testOutput}</pre></Show>
      <footer>
        <button type="button" class="btn" onClick={(event) => void testConnection(readForm(event.currentTarget.form!))}>Probar</button>
        <button type="button" class="btn" onClick={() => setState("connDialog", null)}>Cancelar</button>
        <button type="submit" class="btn primary">Guardar</button>
      </footer>
    </form>
  );
}

function readForm(form: HTMLFormElement): ConnConfig {
  const data = new FormData(form);
  const current = state.connDialog ?? ({} as ConnConfig);
  const kind = String(data.get("kind") ?? current.kind) as DbKind;
  const port = String(data.get("port") ?? "");
  return {
    ...current,
    name: String(data.get("name") ?? current.name),
    kind,
    folder: String(data.get("folder") ?? ""),
    color: String(data.get("color") ?? current.color),
    filePath: String(data.get("filePath") ?? current.filePath ?? ""),
    odbcConnStr: String(data.get("odbcConnStr") ?? current.odbcConnStr ?? ""),
    host: String(data.get("host") ?? current.host ?? ""),
    port: port ? Number(port) : null,
    database: String(data.get("database") ?? ""),
    instance: String(data.get("instance") ?? ""),
    user: String(data.get("user") ?? ""),
    password: String(data.get("password") ?? ""),
    encryption: String(data.get("encryption") ?? current.encryption ?? "required"),
    informixMode: String(data.get("informixMode") ?? current.informixMode ?? "drda"),
    extra: String(data.get("extra") ?? ""),
    integratedAuth: data.get("integratedAuth") === "on",
    trustCert: data.get("trustCert") === "on",
    savePassword: data.get("savePassword") === "on",
    readOnly: data.get("readOnly") === "on",
    production: data.get("production") === "on",
  };
}

function SettingsDialog() {
  return (
    <form class="modal dialog" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void saveSettings({
      theme: String(data.get("theme")) as ThemeName,
      accent: String(data.get("accent")),
      fontSize: Number(data.get("fontSize")),
      editorFontSize: Number(data.get("editorFontSize")),
      pageSize: Number(data.get("pageSize")),
      ibmDriverPath: String(data.get("ibmDriverPath") ?? ""),
      companion: String(data.get("companion")) as "off" | "quiet" | "normal",
    }); setState("settingsOpen", false); }}>
      <header><h2>Ajustes</h2><button type="button" onClick={() => { applyTheme(); setState("settingsOpen", false); }}>✕</button></header>
      <div class="form-grid">
        <label class="span">Tema
          <select name="theme" value={state.settings.theme} onChange={(event) => { document.documentElement.dataset.theme = event.currentTarget.value === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : event.currentTarget.value; }}>
            <option value="dark">Celer Dark</option>
            <option value="light">Celer Light</option>
            <option value="contrast">Alto contraste oscuro</option>
            <option value="contrast-light">Alto contraste claro</option>
            <option value="fjord">Fjord</option>
            <option value="sand">Sand</option>
            <option value="system">Sistema</option>
          </select>
        </label>
        <label class="span">Acento
          <div class="swatches">
            <For each={ACCENTS}>
              {(item) => <button type="button" classList={{ on: state.settings.accent.toLowerCase() === item.value.toLowerCase() }} style={{ background: item.value }} title={item.name} onClick={() => { const input = document.querySelector<HTMLInputElement>("input[name=accent]"); if (input) input.value = item.value; }} />}
            </For>
            <input name="accent" type="color" value={state.settings.accent} />
          </div>
        </label>
        <label>Compañero
          <select name="companion" value={state.settings.companion}>
            <option value="normal">Normal</option>
            <option value="quiet">Silencioso</option>
            <option value="off">Apagado</option>
          </select>
        </label>
        <label>Tamaño de interfaz<input name="fontSize" type="number" min="11" max="20" value={state.settings.fontSize} /></label>
        <label>Tamaño del editor<input name="editorFontSize" type="number" min="11" max="22" value={state.settings.editorFontSize} /></label>
        <label>Filas por página<input name="pageSize" type="number" min="50" max="5000" value={state.settings.pageSize} /></label>
        <label class="span">Ruta del driver IBM<input name="ibmDriverPath" value={state.settings.ibmDriverPath} placeholder="opcional" /></label>
      </div>
      <p class="hint">Driver IBM: {state.driverPath || "no encontrado"} {state.driverProgress}</p>
      <footer>
        <button type="button" class="btn" onClick={() => void downloadDriver()}>Descargar driver IBM</button>
        <button type="button" class="btn" onClick={() => void refreshConnections()}>Recargar</button>
        <button type="submit" class="btn primary">Guardar</button>
      </footer>
      <p class="hint">{isTauri() ? "Aplicación de escritorio" : "Modo navegador: SQLite en memoria. SQL Server, Informix y ODBC usan la aplicación de escritorio."} · {state.appInfo.version} · {state.appInfo.dataDir}</p>
    </form>
  );
}

function ExportDialog() {
  return (
    <form class="modal dialog" onSubmit={(event) => { event.preventDefault(); void runExport(); }}>
      <header><h2>Exportar</h2><button type="button" onClick={() => setState("exportOpen", false)}>✕</button></header>
      <div class="form-grid">
        <label>Formato
          <select value={state.exportFormat} onChange={(event) => setState("exportFormat", event.currentTarget.value as never)}>
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
            <option value="json">JSON</option>
            <option value="sql">SQL INSERT</option>
            <option value="xlsx" disabled={!isTauri()}>Excel</option>
          </select>
        </label>
        <label>Fichero<input value={state.exportPath} onInput={(event) => setState("exportPath", event.currentTarget.value)} /></label>
      </div>
      <Show when={state.exportRunning}><p class="hint">Exportando… {state.exportRows} filas</p></Show>
      <footer>
        <button type="button" class="btn" onClick={() => setState("exportOpen", false)}>Cancelar</button>
        <button type="submit" class="btn primary" disabled={state.exportRunning}>Exportar</button>
      </footer>
    </form>
  );
}
