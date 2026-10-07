import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/jetbrains-mono/400.css";
import { Check, ChevronRight, CircleAlert, Database, FolderOpen, Gauge, KeyRound, Minus, Sparkles, X, Zap } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { render } from "solid-js/web";
import { Mark } from "../../src/brand/Mark";
import { Gib, type GibMood } from "../../src/gib/Gib";
import "../../src/App.css";
import { setup, type InstallOptions, type Progress, type SetupInfo } from "./backend";
import "./setup.css";

type Step = "welcome" | "options" | "installing" | "done" | "error" | "confirm-uninstall" | "uninstalling" | "uninstalled";

const TIPS = [
  "Pulsa Mayús dos veces para buscar tablas, pestañas y acciones.",
  "Ctrl+Intro ejecuta la sentencia bajo el cursor, o la selección.",
  "Los resultados se leen por páginas: millones de filas sin bloquear nada.",
  "Filtra cualquier columna con «+ Filtro», sin escribir SQL.",
  "Ctrl+Alt+I abre el asistente de IA, que conoce tu esquema real.",
  "Las conexiones de producción piden confirmación antes de cambios peligrosos.",
  "Exporta a CSV, Excel, JSON, SQL, Markdown o HTML en streaming.",
];

function App() {
  const [info, setInfo] = createSignal<SetupInfo | null>(null);
  const [step, setStep] = createSignal<Step>("welcome");
  const [opts, setOpts] = createSignal<InstallOptions>({ dir: "", desktopShortcut: true, startMenu: true, associateSql: false, launchAfter: true });
  const [free, setFree] = createSignal<number | null>(null);
  const [progress, setProgress] = createSignal<Progress>({ step: "prepare", pct: 0, detail: "" });
  const [error, setError] = createSignal("");
  const [exePath, setExePath] = createSignal("");
  const [keepData, setKeepData] = createSignal(true);
  const [tip, setTip] = createSignal(0);
  const [loveBurst, setLoveBurst] = createSignal(false);

  onMount(async () => {
    const theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    const data = await setup.info();
    setInfo(data);
    setOpts({ ...opts(), dir: data.existing?.dir ?? data.defaultDir });
    setFree(data.freeMb);
    if (data.isUninstall) setStep("confirm-uninstall");
    const off = await setup.onProgress((p) => setProgress(p));
    onCleanup(off);
    requestAnimationFrame(() => requestAnimationFrame(() => void setup.showWindow()));
    // Update started from Celer: same options, no questions; Celer reopens on its own when done.
    if (data.update) {
      setOpts(data.update);
      void install();
    }
  });

  const autoUpdate = () => Boolean(info()?.update);
  // After an automatic update, reopen Celer by itself unless the user touches something.
  let reopenTimer = 0;
  createEffect(() => {
    if (step() !== "done" || !autoUpdate()) return;
    reopenTimer = window.setTimeout(() => void finish(), 2200);
    onCleanup(() => window.clearTimeout(reopenTimer));
  });

  // Live free-space check while the path is edited.
  let freeTimer = 0;
  createEffect(() => {
    const dir = opts().dir;
    if (!dir) return;
    window.clearTimeout(freeTimer);
    freeTimer = window.setTimeout(() => void setup.driveFree(dir).then(setFree).catch(() => setFree(null)), 250);
  });

  // Rotating tips while installing.
  createEffect(() => {
    if (step() !== "installing") return;
    const timer = window.setInterval(() => setTip((t) => t + 1), 3200);
    onCleanup(() => window.clearInterval(timer));
  });

  const needMb = () => (info()?.payloadMb ?? 20) + 5;
  const pathError = createMemo(() => {
    const dir = opts().dir.trim();
    if (!dir) return "Elige una carpeta";
    if (!/^[a-zA-Z]:\\/.test(dir)) return "Usa una ruta completa, por ejemplo C:\\Programas\\Celer";
    if (/^[a-zA-Z]:\\(windows|program files)/i.test(dir)) return "Esa carpeta necesita permisos de administrador";
    if (free() !== null && free()! < needMb()) return `No hay espacio suficiente (${Math.round(free()!)} MB libres)`;
    return "";
  });

  const isUpdate = () => Boolean(info()?.existing);

  async function install() {
    if (pathError()) {
      setStep("options");
      return;
    }
    setError("");
    setProgress({ step: "prepare", pct: 0, detail: "Preparando" });
    setStep("installing");
    try {
      const exe = await setup.install(opts());
      setExePath(exe);
      setProgress({ step: "finish", pct: 100, detail: "Listo" });
      await new Promise((resolve) => setTimeout(resolve, 450));
      setStep("done");
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "Error inesperado");
      setStep("error");
    }
  }

  async function finish() {
    if (opts().launchAfter && exePath()) await setup.launch(exePath()).catch(() => {});
    await setup.quit();
  }

  async function uninstall() {
    setError("");
    setProgress({ step: "prepare", pct: 0, detail: "Preparando" });
    setStep("uninstalling");
    try {
      await setup.uninstall(keepData());
      setStep("uninstalled");
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "Error inesperado");
      setStep("error");
    }
  }

  const mood = (): GibMood => {
    if (loveBurst()) return "love";
    switch (step()) {
      case "welcome":
      case "confirm-uninstall":
        return "wave";
      case "installing":
      case "uninstalling":
        return progress().pct > 97 ? "idea" : "think";
      case "done":
        return "happy";
      case "error":
        return "error";
      case "uninstalled":
        return "wave";
      default:
        return "idle";
    }
  };

  const tracker = () =>
    autoUpdate()
      ? [
          { id: "downloaded", label: "Descargada" },
          { id: "installing", label: "Actualizando" },
          { id: "done", label: "Listo" },
        ]
      : info()?.isUninstall
      ? [
          { id: "confirm-uninstall", label: "Confirmar" },
          { id: "uninstalling", label: "Desinstalando" },
          { id: "uninstalled", label: "Hecho" },
        ]
      : [
          { id: "welcome", label: "Bienvenida" },
          { id: "options", label: "Opciones" },
          { id: "installing", label: isUpdate() ? "Actualizando" : "Instalando" },
          { id: "done", label: "Listo" },
        ];
  const finished = () => step() === "done" || step() === "uninstalled";
  const stepIndex = () => {
    const ids = tracker().map((item) => item.id);
    const s = step() === "error" ? (info()?.isUninstall ? "uninstalling" : "installing") : step();
    return Math.max(0, ids.indexOf(s));
  };

  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || (event.target as HTMLElement).closest("input")) return;
      const s = step();
      if (s === "welcome" || s === "options") void install();
      else if (s === "done") void finish();
      else if (s === "confirm-uninstall") void uninstall();
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  return (
    <div class="setup" classList={{ busy: step() === "installing" || step() === "uninstalling" }}>
      <aside class="stage">
        <div class="stage-glow" />
        <div class="speed-lines" aria-hidden="true">
          <For each={[0, 1, 2, 3, 4, 5]}>{(i) => <i style={{ "--i": i }} />}</For>
        </div>
        <div class="stage-brand" data-tauri-drag-region>
          <Mark size={20} />
          <span>Celer</span>
          <Show when={info()}><small>{info()!.version}</small></Show>
        </div>
        <div class="stage-gib">
          <Gib size={132} pose="poker" mood={mood()} onClick={() => { setLoveBurst(true); window.setTimeout(() => setLoveBurst(false), 1500); }} />
        </div>
        <ol class="tracker">
          <For each={tracker()}>
            {(item, index) => (
              <li classList={{ done: index() < stepIndex() || finished(), current: index() === stepIndex() && !finished(), failed: step() === "error" && index() === stepIndex() }}>
                <span class="dot">
                  <Show when={index() < stepIndex() || finished()} fallback={<Show when={step() === "error" && index() === stepIndex()} fallback={index() + 1}>!</Show>}>
                    <Check size={11} stroke-width={3} />
                  </Show>
                </span>
                <span>{item.label}</span>
              </li>
            )}
          </For>
        </ol>
      </aside>

      <main class="panel">
        <header class="titlebar" data-tauri-drag-region>
          <span class="spacer" data-tauri-drag-region />
          <button type="button" class="win-btn" title="Minimizar" onClick={() => void setup.minimize()}><Minus size={14} /></button>
          <button type="button" class="win-btn close" title="Cerrar" disabled={step() === "installing" || step() === "uninstalling"} onClick={() => void setup.quit()}><X size={14} /></button>
        </header>

        <div class="content">
          <Switch>
            <Match when={step() === "welcome"}>
              <section class="screen">
                <h1>{isUpdate() ? "Hay una versión nueva de Celer" : "Hola, soy Gib."}</h1>
                <p class="lead">
                  {isUpdate()
                    ? `Voy a actualizar Celer ${info()!.existing!.version} a ${info()?.version}. Tus conexiones, consultas y ajustes se conservan.`
                    : "Voy a instalar Celer, el cliente SQL rápido para cualquier base de datos. Tardaremos unos segundos."}
                </p>
                <ul class="features">
                  <li><span class="fi"><Zap size={15} /></span><div><b>Rápido de verdad</b><small>Arranca en menos de un segundo; millones de filas sin esperas.</small></div></li>
                  <li><span class="fi"><Database size={15} /></span><div><b>Todas tus bases de datos</b><small>PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, Informix y ODBC.</small></div></li>
                  <li><span class="fi"><Sparkles size={15} /></span><div><b>IA con permisos</b><small>Asistente SQL y servidor MCP que solo ve lo que tú permitas.</small></div></li>
                </ul>
                <p class="fine">Se instala solo para tu usuario, sin permisos de administrador · {Math.round(info()?.payloadMb ?? 19)} MB</p>
              </section>
            </Match>

            <Match when={step() === "options"}>
              <section class="screen">
                <h2>Opciones de instalación</h2>
                <label class="field">
                  <span>Carpeta</span>
                  <div class="input-group">
                    <input value={opts().dir} spellcheck={false} onInput={(event) => setOpts({ ...opts(), dir: event.currentTarget.value })} />
                    <button type="button" class="btn" onClick={() => void setup.pickDir(opts().dir).then((dir) => dir && setOpts({ ...opts(), dir }))}><FolderOpen size={14} /> Examinar</button>
                  </div>
                  <small class={pathError() ? "path-error" : "path-ok"}>
                    {pathError() || `${free() !== null ? `${Math.round(free()!).toLocaleString()} MB libres` : "Comprobando espacio…"} · se necesitan ${Math.round(needMb())} MB`}
                  </small>
                </label>
                <div class="toggles">
                  <Toggle label="Acceso directo en el escritorio" value={opts().desktopShortcut} onChange={(v) => setOpts({ ...opts(), desktopShortcut: v })} />
                  <Toggle label="Acceso en el menú Inicio" value={opts().startMenu} onChange={(v) => setOpts({ ...opts(), startMenu: v })} />
                  <Toggle label="Abrir ficheros .sql con Celer" value={opts().associateSql} onChange={(v) => setOpts({ ...opts(), associateSql: v })} />
                  <Toggle label="Abrir Celer al terminar" value={opts().launchAfter} onChange={(v) => setOpts({ ...opts(), launchAfter: v })} />
                </div>
              </section>
            </Match>

            <Match when={step() === "installing" || step() === "uninstalling"}>
              <section class="screen center">
                <h2>{step() === "uninstalling" ? "Desinstalando Celer" : isUpdate() ? "Actualizando Celer" : "Instalando Celer"}</h2>
                <div class="progress-big">
                  <div class="progress-track"><div class="progress-fill" style={{ width: `${Math.max(2, progress().pct)}%` }} /></div>
                  <div class="progress-meta">
                    <span>{progress().detail || "Preparando…"}</span>
                    <b>{Math.round(progress().pct)}%</b>
                  </div>
                </div>
                <Show when={step() === "installing"}>
                  <div class="tip-card">
                    <small>¿Sabías que…?</small>
                    <Show when={String(tip())} keyed>
                      {(key) => <p class="tip-text">{TIPS[Number(key) % TIPS.length]}</p>}
                    </Show>
                  </div>
                </Show>
              </section>
            </Match>

            <Match when={step() === "done"}>
              <section class="screen">
                <div class="burst" aria-hidden="true"><For each={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]}>{(i) => <i style={{ "--i": i }} />}</For></div>
                <h1>Celer está listo.</h1>
                <p class="lead">
                  {autoUpdate()
                    ? `Actualizado a la versión ${info()?.version}. Vuelvo a abrir Celer en un momento…`
                    : isUpdate()
                      ? `Actualizado a la versión ${info()?.version}.`
                      : "Todo instalado. Cuando lo abras te enseñaré lo esencial en un minuto."}
                </p>
                <ul class="checks-done">
                  <li><Check size={14} /> Celer {info()?.version} en <code>{opts().dir}</code></li>
                  <Show when={opts().startMenu}><li><Check size={14} /> Acceso en el menú Inicio</li></Show>
                  <Show when={opts().desktopShortcut}><li><Check size={14} /> Acceso directo en el escritorio</li></Show>
                  <Show when={opts().associateSql}><li><Check size={14} /> Ficheros .sql asociados</li></Show>
                  <li><Check size={14} /> Registrado en Configuración › Aplicaciones</li>
                </ul>
                <Show when={!autoUpdate()}>
                  <Toggle label="Abrir Celer ahora" value={opts().launchAfter} onChange={(v) => setOpts({ ...opts(), launchAfter: v })} />
                </Show>
              </section>
            </Match>

            <Match when={step() === "error"}>
              <section class="screen">
                <h2 class="err-title"><CircleAlert size={20} /> Algo no ha ido bien</h2>
                <p class="lead">La operación no se ha completado. Puedes reintentarlo o cambiar las opciones; Gib te dice abajo qué ha pasado.</p>
                <pre class="error-box">{error()}</pre>
              </section>
            </Match>

            <Match when={step() === "confirm-uninstall"}>
              <section class="screen">
                <h1>¿Desinstalar Celer?</h1>
                <p class="lead">Se quitarán el programa, sus accesos directos y su registro en Windows.</p>
                <Toggle label="Conservar mis conexiones, consultas y ajustes" value={keepData()} onChange={setKeepData} />
                <p class="fine">
                  <KeyRound size={12} /> Las contraseñas guardadas en el almacén de credenciales de Windows no se tocan.
                </p>
              </section>
            </Match>

            <Match when={step() === "uninstalled"}>
              <section class="screen">
                <h1>Hasta pronto.</h1>
                <p class="lead">Celer se ha desinstalado{keepData() ? "; tus datos siguen ahí por si vuelves." : " junto con tus datos."}</p>
              </section>
            </Match>
          </Switch>
        </div>

        <footer class="actions">
          <Switch>
            <Match when={step() === "welcome"}>
              <button type="button" class="btn ghost-btn" onClick={() => setStep("options")}>Personalizar</button>
              <span class="spacer" />
              <button type="button" class="btn primary big" disabled={!info()} onClick={() => void install()}>
                {isUpdate() ? "Actualizar" : "Instalar"} <ChevronRight size={15} />
              </button>
            </Match>
            <Match when={step() === "options"}>
              <button type="button" class="btn" onClick={() => setStep("welcome")}>Atrás</button>
              <span class="spacer" />
              <button type="button" class="btn primary big" disabled={Boolean(pathError())} onClick={() => void install()}>
                {isUpdate() ? "Actualizar" : "Instalar"} <ChevronRight size={15} />
              </button>
            </Match>
            <Match when={step() === "installing" || step() === "uninstalling"}>
              <span class="fine"><Gauge size={12} /> No cierres esta ventana</span>
            </Match>
            <Match when={step() === "done"}>
              <span class="spacer" />
              <button type="button" class="btn primary big" onClick={() => void finish()}>{opts().launchAfter ? "Abrir Celer" : "Cerrar"}</button>
            </Match>
            <Match when={step() === "error"}>
              <button type="button" class="btn" onClick={() => setStep(info()?.isUninstall ? "confirm-uninstall" : "options")}>{info()?.isUninstall ? "Atrás" : "Cambiar opciones"}</button>
              <span class="spacer" />
              <button type="button" class="btn primary big" onClick={() => void (info()?.isUninstall ? uninstall() : install())}>Reintentar</button>
            </Match>
            <Match when={step() === "confirm-uninstall"}>
              <button type="button" class="btn" onClick={() => void setup.quit()}>Cancelar</button>
              <span class="spacer" />
              <button type="button" class="btn danger big" onClick={() => void uninstall()}>Desinstalar</button>
            </Match>
            <Match when={step() === "uninstalled"}>
              <span class="spacer" />
              <button type="button" class="btn primary big" onClick={() => void setup.quit()}>Cerrar</button>
            </Match>
          </Switch>
        </footer>
      </main>
    </div>
  );
}

function Toggle(props: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" class="toggle" role="switch" aria-checked={props.value} classList={{ on: props.value }} onClick={() => props.onChange(!props.value)}>
      <span class="switch"><i /></span>
      <span>{props.label}</span>
    </button>
  );
}

render(() => <App />, document.getElementById("root") as HTMLElement);
