import { ArrowDownToLine, CircleAlert, ExternalLink, RefreshCw, RotateCcw, ShieldCheck } from "lucide-solid";
import { Match, Show, Switch } from "solid-js";
import { Gib, type GibMood } from "../gib/Gib";
import { saveSettings, state } from "../state";
import { checkForUpdates, downloadUpdate, formatMb, installLater, installUpdate, openReleasePage, setUpdate, skipVersion, update } from "../update";
import { Dialog } from "./Modals";
import { Markdown } from "./Markdown";

export function UpdateDialog() {
  const info = () => update.info;
  const busy = () => update.status === "downloading" || update.status === "installing";
  const close = () => {
    if (!busy()) setUpdate({ dialogOpen: false });
  };
  const pct = () => (update.total ? Math.min(100, (update.done / update.total) * 100) : 0);
  const mood = (): GibMood => {
    switch (update.status) {
      case "checking":
      case "downloading":
        return "think";
      case "available":
        return "idea";
      case "ready":
      case "installing":
        return "happy";
      case "error":
        return "error";
      case "current":
        return "ok";
      default:
        return "idle";
    }
  };
  const date = () => {
    const d = info()?.publishedAt ? new Date(info()!.publishedAt) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
  };

  return (
    <Dialog title="Actualizaciones" class="update-dialog" onClose={close}>
      <div class="upd-head">
        <Gib size={76} pose="poker" mood={mood()} />
        <div class="upd-title">
          <Switch>
            <Match when={update.status === "checking"}>
              <h3>Buscando novedades…</h3>
              <p class="muted">Consultando los releases de Celer en GitHub.</p>
            </Match>
            <Match when={update.status === "current"}>
              <h3>Estás al día</h3>
              <p class="muted">Celer {info()?.current} es la última versión.</p>
            </Match>
            <Match when={update.status === "error"}>
              <h3>No se ha podido completar</h3>
              <p class="upd-error"><CircleAlert size={13} /> {update.error}</p>
            </Match>
            <Match when={info()?.available}>
              <h3>Celer {info()!.latest} está disponible</h3>
              <p class="muted">
                Tienes la {info()!.current}
                <Show when={date()}> · publicada el {date()}</Show>
                <Show when={info()!.assetSize}> · {formatMb(info()!.assetSize)}</Show>
              </p>
            </Match>
          </Switch>
        </div>
      </div>

      <Show when={info()?.available && info()!.notes.trim()}>
        <div class="upd-notes">
          <Markdown text={info()!.notes} />
        </div>
      </Show>

      <Show when={update.status === "downloading" || update.status === "ready" || update.status === "installing"}>
        <div class="upd-progress">
          <div class="upd-track"><div class="upd-fill" classList={{ done: update.status !== "downloading" }} style={{ transform: `translateX(${(update.status === "downloading" ? pct() : 100) - 100}%)` }} /></div>
          <div class="upd-meta">
            <span>
              <Switch>
                <Match when={update.status === "downloading"}>Descargando · {formatMb(update.done)} de {formatMb(update.total)}</Match>
                <Match when={update.status === "ready"}><ShieldCheck size={13} /> Descargada y verificada (SHA-256)</Match>
                <Match when={update.status === "installing"}>Cerrando Celer para actualizar…</Match>
              </Switch>
            </span>
            <Show when={update.status === "downloading"}><b>{Math.round(pct())}%</b></Show>
          </div>
        </div>
      </Show>

      <Show when={info()?.available && update.status !== "error"}>
        <p class="upd-fine">
          {{
            setup: "Al pulsar Actualizar, Celer descarga el instalador, comprueba su SHA-256, se cierra y vuelve a abrirse con la versión nueva. Tus conexiones, consultas y ajustes se conservan.",
            portable: "Esta copia es portable y no se actualiza sola: descarga Celer-Portable-Windows.exe o Celer-Setup-Windows.exe desde la página de la versión. Tus conexiones y ajustes se conservan.",
            msi: "Celer se instaló con el antiguo paquete MSI, que ya no se publica: desinstálalo e instala Celer-Setup-Windows.exe desde la página de la versión (tus datos se conservan).",
            other: "Descarga el paquete de tu sistema (.dmg, .deb, .rpm o AppImage) desde la página de la versión. Tus conexiones y ajustes se conservan.",
          }[info()!.installKind ?? "setup"]}
        </p>
      </Show>

      <footer>
        <Switch>
          <Match when={update.status === "available"}>
            <button type="button" class="btn ghost-btn" onClick={() => void skipVersion()}>Omitir esta versión</button>
            <button type="button" class="btn" onClick={() => void openReleasePage()}><ExternalLink size={13} /> Ver en GitHub</button>
            <span class="spacer" />
            <button type="button" class="btn" onClick={close}>Más tarde</button>
            <button type="button" class="btn primary" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => void downloadUpdate()}>
              <ArrowDownToLine size={14} /> {info()?.assetUrl ? "Actualizar" : "Descargar desde GitHub"}
            </button>
          </Match>
          <Match when={update.status === "downloading"}>
            <span class="spacer" />
            <button type="button" class="btn" disabled>Descargando…</button>
          </Match>
          <Match when={update.status === "ready"}>
            <span class="spacer" />
            <button type="button" class="btn" onClick={installLater}>Al cerrar Celer</button>
            <button type="button" class="btn primary" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => void installUpdate()}>
              <RotateCcw size={14} /> Instalar y reiniciar
            </button>
          </Match>
          <Match when={update.status === "error"}>
            <button type="button" class="btn" onClick={() => void openReleasePage()}><ExternalLink size={13} /> Descargar desde GitHub</button>
            <span class="spacer" />
            <button type="button" class="btn" onClick={close}>Cerrar</button>
            <button type="button" class="btn primary" onClick={() => void (info()?.available ? downloadUpdate() : checkForUpdates(true))}><RefreshCw size={14} /> Reintentar</button>
          </Match>
          <Match when={true}>
            <label class="toggle-line">
              <input type="checkbox" checked={state.settings.checkUpdates} onChange={(event) => void saveSettings({ checkUpdates: event.currentTarget.checked })} />
              <span>Buscar actualizaciones al iniciar</span>
            </label>
            <span class="spacer" />
            <button type="button" class="btn" disabled={update.status === "checking"} onClick={() => { setUpdate({ status: "idle" }); void checkForUpdates(true); }}><RefreshCw size={14} /> Comprobar de nuevo</button>
            <button type="button" class="btn primary" onClick={close}>Cerrar</button>
          </Match>
        </Switch>
      </footer>
    </Dialog>
  );
}
