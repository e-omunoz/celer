// Informix drivers: Settings › Drivers (what is installed and what connections use), the dialog that offers what
// Informix over JDBC lacks, and the guide shown instead of a raw driver error.
import { BookOpen, CircleAlert, CircleCheck, Download, ExternalLink, LoaderCircle } from "lucide-solid";
import { createSignal, For, onMount, Show, type JSX } from "solid-js";
import { api, errorText, isTauri } from "../api";
import { cancelDriverDownload, completeJdbcSetup, confirmDialog, downloadDriver, downloadJdbcPiece, refreshInformixDrivers, saveSettings, setState, state } from "../state";
import type { Settings } from "../types";
import { Dialog } from "./Modals";

const SOURCES: Record<string, string> = { settings: "Ajustes", JAVA_HOME: "JAVA_HOME", DBeaver: "DBeaver", PATH: "PATH", Celer: "descargado por Celer" };
const sourceLabel = (source: string) => SOURCES[source] ?? source;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

async function openLink(url: string) {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

function Link(props: { href: string; children: JSX.Element }) {
  return (
    <a href={props.href} class="text-link" onClick={(event) => { event.preventDefault(); void openLink(props.href); }}>
      {props.children} <ExternalLink size={11} />
    </a>
  );
}

export function openInformixGuide(topic = "jdbc", message = "") {
  setState("informixGuide", { topic, message });
}

const JAVA_CONFIRM =
  "Celer descargará Eclipse Temurin JRE 21 (unos 50 MB) de Adoptium a su carpeta de datos y comprobará su firma SHA-256. No se instala nada en el sistema ni hace falta ser administrador. Si ya tienes Java 11 o superior (DBeaver trae uno), indica su ruta en su lugar.";

/** A driver download in progress, with its cancel button. */
function DownloadProgress() {
  return (
    <Show when={state.driverDownload}>
      {(download) => (
        <div class="driver-progress">
          <LoaderCircle size={14} class="spin" />
          <span class="grow">{download().what}</span>
          <progress max={download().total || 1} value={download().total ? download().done : 0} />
          <span class="muted small">{download().total ? `${Math.round((download().done / download().total) * 100)} %` : `${(download().done / 1048576).toFixed(1)} MB`}</span>
          <button type="button" class="btn tiny" onClick={cancelDriverDownload}>Cancelar</button>
        </div>
      )}
    </Show>
  );
}

function Status(props: { ok: boolean; title: string; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <div class="driver-row" classList={{ ok: props.ok }}>
      {props.ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
      <div class="driver-main">
        <b>{props.title}</b>
        <span>{props.children}</span>
      </div>
      {props.actions}
    </div>
  );
}

/** Settings › Drivers. */
export function DriversSettings() {
  const [check, setCheck] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = createSignal(false);
  onMount(() => void refreshInformixDrivers());
  const s = () => state.settings;
  const busy = () => Boolean(state.driverDownload);

  async function save(patch: Partial<Settings>) {
    await saveSettings(patch);
    setCheck(null);
    await refreshInformixDrivers();
  }

  async function downloadJava() {
    if (await confirmDialog("Descargar Java", JAVA_CONFIRM, "Descargar Java")) await downloadJdbcPiece("java");
  }

  async function runCheck() {
    setChecking(true);
    try {
      setCheck({ ok: true, text: await api().jdbcCheck() });
    } catch (err) {
      setCheck({ ok: false, text: errorText(err).replace(/^[A-Z_]+(:[\w,]+)?: /, "") });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <p class="settings-note">
        PostgreSQL, MySQL/MariaDB, SQL Server y SQLite son nativos: no hace falta instalar nada. Informix se conecta por SQLI, su protocolo de siempre, con el driver JDBC de
        IBM o con el Client SDK, o por DRDA con el driver IBM CLI. Celer no incluye nada de IBM: usa lo que ya tienes (también lo de DBeaver) y descarga el resto cuando se lo pides.
      </p>
      <div class="driver-actions">
        <button type="button" class="btn tiny" onClick={() => openInformixGuide()}><BookOpen size={13} /> Guía de drivers de Informix</button>
        <button type="button" class="btn tiny" disabled={!isTauri()} onClick={() => void refreshInformixDrivers()}>Volver a buscar</button>
      </div>
      <DownloadProgress />

      <h4>Informix por JDBC (SQLI) · recomendado</h4>
      <Show when={state.informixDrivers} fallback={<p class="settings-note">{isTauri() ? "Buscando…" : "Solo en la aplicación de escritorio."}</p>}>
        {(info) => (
          <>
            <Show when={!info().bridge}>
              <p class="settings-note warn">Esta compilación de Celer no incluye el puente JDBC (se compiló sin un JDK): usa una versión publicada para conectar por JDBC.</p>
            </Show>
            <Status
              ok={Boolean(info().javaUsed)}
              title={`Java ${info().javaMin} o superior`}
              actions={
                <Show when={!info().javaUsed && info().jreDownload}>
                  <button type="button" class="btn tiny" disabled={busy()} onClick={() => void downloadJava()}><Download size={13} /> Descargar Java…</button>
                </Show>
              }
            >
              <Show
                when={info().javaUsed}
                fallback={info().java.length ? `Solo hay Java ${info().java[0].major} (${info().java[0].path}): el puente necesita ${info().javaMin} o superior.` : "No se encontró ninguno."}
              >
                {(java) => `Java ${java().version} · ${sourceLabel(java().source)} · ${java().path}`}
              </Show>
            </Status>
            <For each={info().java.filter((java) => java.source === "DBeaver" && java.major >= info().javaMin && java.path !== info().javaUsed?.path)}>
              {(java) => (
                <div class="driver-alt">
                  También está el Java {java.version} de DBeaver.
                  <button type="button" class="btn tiny" onClick={() => void save({ javaPath: java.path })}>Usar</button>
                </div>
              )}
            </For>
            <label class="field">
              <span>Ruta de Java (opcional: el ejecutable o la carpeta del JRE)</span>
              <input value={s().javaPath} placeholder="detección automática" spellcheck={false} onChange={(event) => void save({ javaPath: event.currentTarget.value.trim() })} />
            </label>

            <Status
              ok={Boolean(info().jdbcUsed)}
              title="Driver JDBC de Informix"
              actions={
                <Show when={!info().jdbcUsed}>
                  <button type="button" class="btn tiny" disabled={busy()} onClick={() => void downloadJdbcPiece("jdbc")}><Download size={13} /> Descargar {info().jdbcVersion}</button>
                </Show>
              }
            >
              <Show when={info().jdbcUsed} fallback="No se encontró. Celer lo descarga de Maven Central (1,7 MB, con su firma SHA-256 comprobada).">
                {(jdbc) => `${fileName(jdbc().jars[0])} · ${sourceLabel(jdbc().source)}${jdbc().jars.length > 1 ? ` · con ${jdbc().jars.slice(1).map(fileName).join(", ")}` : ""}`}
              </Show>
            </Status>
            <For each={info().jdbc.filter((jdbc) => jdbc.source === "DBeaver" && jdbc.jars[0] !== info().jdbcUsed?.jars[0])}>
              {(jdbc) => (
                <div class="driver-alt">
                  También está el driver {jdbc.version} de DBeaver.
                  <button type="button" class="btn tiny" onClick={() => void save({ informixJdbcPath: jdbc.jars[0] })}>Usar</button>
                </div>
              )}
            </For>
            <label class="field">
              <span>Ruta del driver JDBC (opcional: el .jar o su carpeta)</span>
              <input value={s().informixJdbcPath} placeholder="detección automática" spellcheck={false} onChange={(event) => void save({ informixJdbcPath: event.currentTarget.value.trim() })} />
            </label>
            <div class="driver-actions">
              <button type="button" class="btn tiny" disabled={checking() || !info().bridge || !info().javaUsed || !info().jdbcUsed} onClick={() => void runCheck()}>
                {checking() ? "Arrancando Java…" : "Comprobar"}
              </button>
              <Show when={check()}>{(result) => <span class="small" classList={{ "driver-ok": result().ok, "driver-bad": !result().ok }}>{result().text}</span>}</Show>
            </div>

            <h4>Informix Client SDK (ODBC, SQLI)</h4>
            <Status
              ok={info().sdkReady}
              title="IBM INFORMIX ODBC DRIVER (64-bit)"
              actions={<button type="button" class="btn tiny" onClick={() => openInformixGuide("sdk")}>Cómo instalarlo</button>}
            >
              {info().sdkReady
                ? "Instalado: «Automático» lo usa."
                : info().odbc.length
                  ? `Hay otro driver Informix registrado (${info().odbc.join(", ")}), pero no el de 64 bits que usa Celer.`
                  : "No instalado. No hace falta si conectas por JDBC."}
            </Status>
          </>
        )}
      </Show>

      <h4>IBM Data Server Driver (CLI, DRDA)</h4>
      <Status
        ok={Boolean(state.driverPath)}
        title="Driver IBM CLI"
        actions={<button type="button" class="btn tiny" disabled={!isTauri() || busy()} onClick={() => void downloadDriver()}><Download size={13} /> Descargar</button>}
      >
        {state.driverPath || "No encontrado. Solo hace falta si el servidor tiene un listener DRDA."}
      </Status>
      <label class="field">
        <span>Ruta del driver IBM (opcional)</span>
        <input value={s().ibmDriverPath} placeholder="detección automática" onChange={(event) => void saveSettings({ ibmDriverPath: event.currentTarget.value })} />
      </label>
    </>
  );
}

/** What Informix over JDBC lacks, and the downloads that fix it (each one only on the user's click). */
export function JdbcSetupDialog() {
  const setup = () => state.jdbcSetup!;
  const info = () => state.informixDrivers;
  const needJava = () => setup().missing.includes("java") && !info()?.javaUsed;
  const needJdbc = () => setup().missing.includes("jdbc") && !info()?.jdbcUsed;
  const pieces = (): ("java" | "jdbc")[] => [...(needJava() ? (["java"] as const) : []), ...(needJdbc() ? (["jdbc"] as const) : [])];
  const close = () => {
    if (state.driverDownload) cancelDriverDownload();
    setState("jdbcSetup", null);
  };
  const label = () => {
    if (!pieces().length) return "Reintentar";
    if (needJava() && needJdbc()) return "Descargar Java y el driver";
    return needJava() ? "Descargar Java" : "Descargar el driver";
  };
  return (
    <Dialog title="Informix por JDBC" onClose={close} class="jdbc-setup">
      <p class="dialog-lead">{setup().text}</p>
      <ul class="setup-list">
        <Show when={setup().missing.includes("java")}>
          <li classList={{ done: !needJava() }}>
            {needJava() ? <Download size={15} /> : <CircleCheck size={15} />}
            <div>
              <b>Java · Eclipse Temurin JRE 21</b>
              <span>
                Unos 50 MB de Adoptium, a la carpeta de datos de Celer: no se instala en el sistema ni pide permisos de administrador. ¿Tienes Java 11 o superior, o DBeaver, en
                otra ruta? Indícala en Ajustes › Drivers y no hará falta.
              </span>
            </div>
          </li>
        </Show>
        <Show when={setup().missing.includes("jdbc")}>
          <li classList={{ done: !needJdbc() }}>
            {needJdbc() ? <Download size={15} /> : <CircleCheck size={15} />}
            <div>
              <b>Driver JDBC de Informix {info()?.jdbcVersion ?? ""}</b>
              <span>1,7 MB de Maven Central (com.ibm.informix:jdbc y org.mongodb:bson), con su firma SHA-256 comprobada.</span>
            </div>
          </li>
        </Show>
      </ul>
      <DownloadProgress />
      <footer>
        <button type="button" class="btn" onClick={() => setState({ jdbcSetup: null, settingsOpen: true, settingsSection: "drivers" })}>Indicar rutas…</button>
        <span class="spacer" />
        <button type="button" class="btn" onClick={close}>Cancelar</button>
        <button type="button" class="btn primary" disabled={Boolean(state.driverDownload)} onClick={() => void completeJdbcSetup(pieces())}>{label()}</button>
      </footer>
    </Dialog>
  );
}

const GUIDE: { id: string; title: string; body: () => JSX.Element }[] = [
  {
    id: "jdbc",
    title: "Qué protocolo elegir",
    body: () => (
      <>
        <p>Informix habla dos protocolos. Elige el que tenga abierto tu servidor (los DBA lo saben; en DBeaver, una URL <code>jdbc:informix-sqli://…</code> es SQLI):</p>
        <ul>
          <li><b>Automático</b> (recomendado): usa el Client SDK si está instalado y, si no, JDBC.</li>
          <li><b>SQLI (JDBC)</b>: el protocolo nativo (<code>onsoctcp</code>, normalmente el puerto 9088), el mismo que usa DBeaver. Necesita Java 11 o superior (vale el de DBeaver) y el driver JDBC de IBM, que Celer descarga de Maven Central.</li>
          <li><b>SQLI (Client SDK / ODBC)</b>: el mismo protocolo con el driver ODBC del Informix Client SDK, si ya lo tienes instalado.</li>
          <li><b>DRDA (IBM CLI)</b>: solo si el servidor tiene un listener DRDA (<code>drsoctcp</code>, a menudo el 9089). Celer descarga el driver IBM CLI.</li>
        </ul>
        <p>En el campo <b>INFORMIXSERVER</b> va el nombre del servidor (su DBSERVERNAME o un alias); por SQLI es obligatorio. Lo demás (<code>DB_LOCALE</code>, <code>IFX_LOCK_MODE_WAIT</code>…) va en <b>Parámetros extra</b>, como <code>clave=valor;clave2=valor2</code>.</p>
        <p>Si el driver JDBC está dañado o es de otra versión, vuelve a descargarlo en Ajustes › Drivers o indica el tuyo.</p>
      </>
    ),
  },
  {
    id: "sdk",
    title: "Client SDK (ODBC)",
    body: () => (
      <>
        <p>El Client SDK no hace falta si conectas por JDBC. Si prefieres el driver ODBC:</p>
        <ol>
          <li>
            Descárgalo de <Link href="https://esd.actian.com/product/HCL_Informix/14.10/Windows_64-Bit/Client">Actian ESD</Link> (pide registrarse) o de IBM Fix Central / las
            descargas de Informix (con IBMid y suscripción). Elige siempre la versión de <b>64 bits</b>.
          </li>
          <li>En el instalador, marca <b>ODBC Driver</b>. La instalación pide permisos de administrador.</li>
          <li>Compruébalo en <code>odbcad32</code> (Orígenes de datos ODBC de 64 bits › Controladores): debe aparecer <b>IBM INFORMIX ODBC DRIVER (64-bit)</b>.</li>
          <li>En la conexión, elige «Automático» o «SQLI (Client SDK / ODBC)».</li>
        </ol>
      </>
    ),
  },
  {
    id: "drda",
    title: "DRDA",
    body: () => (
      <>
        <p>DRDA solo funciona si el servidor escucha en DRDA. Muchos Informix solo tienen SQLI: en ese caso usa «Automático» o «SQLI (JDBC)», que no necesitan nada en el servidor.</p>
        <p>Para activar DRDA, los DBA tienen que añadir un alias en <code>sqlhosts</code> (por ejemplo <code>miservidor_dr drsoctcp host 9089</code>) y su nombre en <code>DBSERVERALIASES</code> del ONCONFIG.</p>
        <p>Por DRDA hay que indicar siempre la base de datos.</p>
      </>
    ),
  },
  {
    id: "locale",
    title: "Locale",
    body: () => (
      <>
        <p>Los errores -23101 y -23197 indican que el locale de la conexión no es el de la base de datos. Indícalo en <b>Parámetros extra</b>:</p>
        <pre class="guide-code">DB_LOCALE=es_ES.819</pre>
        <p>El de cada base se consulta con <code>SELECT dbs_dbsname, dbs_collate FROM sysmaster:sysdbslocale</code>. Si hace falta, añade también <code>CLIENT_LOCALE</code> con el mismo valor.</p>
      </>
    ),
  },
  {
    id: "server",
    title: "Nombre del servidor",
    body: () => (
      <>
        <p>Los errores -908, -761 y -25596 suelen deberse al servidor, al puerto o al campo <b>INFORMIXSERVER</b>:</p>
        <ul>
          <li>Por SQLI el puerto suele ser el 9088; el 9089 suele ser DRDA.</li>
          <li><b>INFORMIXSERVER</b> debe ser el DBSERVERNAME del servidor o uno de sus DBSERVERALIASES de tipo <code>onsoctcp</code>. En DBeaver aparece en la URL como <code>informixserver=…</code>; con una conexión que ya funcione, <code>SELECT DBSERVERNAME FROM systables WHERE tabid = 1</code> lo devuelve.</li>
        </ul>
      </>
    ),
  },
];

/** The Informix drivers guide, open on a topic, with the error that led there. */
export function InformixGuideDialog() {
  const [topic, setTopic] = createSignal(GUIDE.some((g) => g.id === state.informixGuide?.topic) ? state.informixGuide!.topic : "jdbc");
  const close = () => setState("informixGuide", null);
  return (
    <Dialog title="Conectar con Informix" wide onClose={close} class="ifx-guide">
      <Show when={state.informixGuide?.message}>
        {(message) => (
          <div class="test-result bad">
            <CircleAlert size={15} />
            <pre>{message()}</pre>
          </div>
        )}
      </Show>
      <nav class="seg guide-tabs">
        <For each={GUIDE}>{(g) => <button type="button" classList={{ on: topic() === g.id }} onClick={() => setTopic(g.id)}>{g.title}</button>}</For>
      </nav>
      <div class="guide-body">{GUIDE.find((g) => g.id === topic())?.body()}</div>
      <footer>
        <button type="button" class="btn" onClick={() => { close(); setState({ settingsOpen: true, settingsSection: "drivers" }); }}>Ajustes › Drivers</button>
        <span class="spacer" />
        <button type="button" class="btn primary" onClick={close}>Entendido</button>
      </footer>
    </Dialog>
  );
}
