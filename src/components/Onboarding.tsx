import { ArrowLeft, ArrowRight, Check, Database, Keyboard, MousePointerClick, Palette, Sparkles, X } from "lucide-solid";
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Mark } from "../brand/Mark";
import { themeChoices } from "../commands";
import { SEED } from "../demo";
import { Gib, type GibMood } from "../gib/Gib";
import { EngineIcon } from "../icons";
import {
  gibShows,
  activeSql,
  applyTheme,
  gibName,
  createSampleDatabase,
  notify,
  openConnDialog,
  openQuery,
  saveSettings,
  setState,
  state,
} from "../state";
import { migration, openMigration } from "../migrate";
import { ACCENTS, emptyConn, ENGINES, type ThemeName } from "../types";
import { errorText } from "../api";

type Step = "welcome" | "look" | "connect" | "tour" | "keys" | "done";
const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Bienvenida" },
  { id: "look", label: "Apariencia" },
  { id: "connect", label: "Conexión" },
  { id: "tour", label: "Recorrido" },
  { id: "keys", label: "Atajos" },
  { id: "done", label: "Listo" },
];

interface Spot {
  selector: string;
  title: string;
  body: string;
  /** Prepares the UI so the target exists (e.g. opens a console). */
  before?: () => void;
}

const TOUR: Spot[] = [
  { selector: ".explorer", title: "El explorador", body: "Tus conexiones y todo lo que contienen: bases de datos, esquemas, tablas, vistas, funciones. Doble clic en una tabla abre sus datos; clic derecho, todas las acciones (generar SQL, exportar, importar CSV, copiar estructura para IA…)." },
  { selector: ".pane-host.active .editor-wrap", title: "La consola SQL", body: "Escribe aquí. Autocompleta tablas y columnas de tu esquema real, y la sentencia bajo el cursor queda resaltada.", before: () => { if (!activeSql()) openQuery(state.connections[0]?.id ?? null, "SELECT *\nFROM customers\nLIMIT 50;"); } },
  { selector: ".pane-host.active .tb-btn.run", title: "Ejecutar", body: "Ctrl+Intro ejecuta la sentencia del cursor o la selección; Ctrl+Mayús+Intro, el script entero. El botón se convierte en «Detener» mientras corre." },
  { selector: ".pane-host.active .results", title: "Resultados", body: "Millones de filas sin bloquear nada: se leen por páginas. Selecciona celdas para ver suma y media abajo, Ctrl+F para buscar, clic derecho para copiar como CSV, JSON, INSERT…" },
  { selector: ".search-trigger", title: "Buscar en todo", body: "Pulsa Mayús dos veces (o Ctrl+K) para saltar a cualquier tabla, pestaña o acción. Ctrl+N va directo a una tabla." },
  { selector: ".stripe-btn[title^='Biblioteca']", title: "Biblioteca de scripts", body: "Las consultas que repites, guardadas con nombre (Ctrl+Alt+B desde la consola). Ordénalas en carpetas y etiquetas, ábrelas o ejecútalas con un clic y arrástralas al editor." },
  { selector: ".stripe-btn[title^='Asistente']", title: "Asistente de IA", body: "Genera, explica, corrige y optimiza SQL con Claude usando tu esquema real, nunca tus filas. Y desde Ajustes › IA, un servidor MCP con permisos por conexión." },
  { selector: ".companion .gib", get title() { return gibName(); }, body: "Ese soy yo. Pienso mientras corren tus consultas y te aviso cuando terminan; si no hay nada que hacer, me entretengo a mi manera. No me persigas con el ratón, que me molesta. ¿Un consejo? Haz clic en mí." },
];

const KEYS: [string, string][] = [
  ["Ctrl+Intro", "Ejecutar sentencia o selección"],
  ["Ctrl+Mayús+Intro", "Ejecutar script"],
  ["Mayús Mayús", "Buscar en todo"],
  ["Ctrl+N", "Ir a tabla"],
  ["Ctrl+Mayús+L", "Nueva consola"],
  ["Ctrl+Alt+L", "Formatear SQL"],
  ["Ctrl+Mayús+E", "Plan de ejecución"],
  ["Ctrl+Alt+I", "Asistente de IA"],
  ["Ctrl+F", "Buscar en resultados"],
  ["F2 / Supr", "Editar celda / borrar fila"],
  ["Alt+1 / Alt+7", "Explorador / panel derecho"],
  ["Ctrl+Alt+S", "Ajustes"],
];

export function Onboarding() {
  const [step, setStep] = createSignal<Step>("welcome");
  const [spot, setSpot] = createSignal(0);
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const [busy, setBusy] = createSignal(false);
  const index = () => STEPS.findIndex((item) => item.id === step());

  const close = (completed: boolean) => {
    void saveSettings({ onboarded: true });
    setState("onboardingOpen", false);
    if (completed) notify(`Todo listo. ${gibName()} queda en la esquina por si lo necesitas.`, "success");
  };

  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index() + 1)].id);
  const prev = () => setStep(STEPS[Math.max(0, index() - 1)].id);

  // ------------------------------------------------------------ tour spotlight
  function measure() {
    const target = TOUR[spot()];
    const el = document.querySelector<HTMLElement>(target.selector);
    if (!el) return setRect(null);
    // Gib's art overflows its box (he rises above the status bar): spotlight what is actually painted.
    const rects = [el.getBoundingClientRect(), ...[...el.querySelectorAll("svg")].map((s) => s.getBoundingClientRect())].filter((r) => r.width && r.height);
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    setRect(new DOMRect(left, top, right - left, bottom - top));
  }
  // The bubble's real height (its text varies per step) drives where it fits.
  const [bubbleH, setBubbleH] = createSignal(220);
  const bubbleObserver = new ResizeObserver((entries) => {
    for (const entry of entries) setBubbleH((entry.target as HTMLElement).offsetHeight);
  });
  onCleanup(() => bubbleObserver.disconnect());
  const bubbleRef = (el: HTMLDivElement) => {
    bubbleObserver.observe(el);
    setBubbleH(el.offsetHeight || 220);
  };

  createEffect(() => {
    if (step() !== "tour") return;
    const target = TOUR[spot()];
    target.before?.();
    // Let the UI settle (a console may have just opened).
    const timer = window.setTimeout(measure, 60);
    onCleanup(() => window.clearTimeout(timer));
  });

  onMount(() => {
    const onResize = () => step() === "tour" && measure();
    const onKey = (event: KeyboardEvent) => {
      // The import assistant opened from the guide owns the keyboard until it closes.
      if (migration.open) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        if (step() === "tour") setStep("keys");
        else close(false);
      }
      if (step() === "tour" && event.key === "ArrowRight") tourNext();
      if (step() === "tour" && event.key === "ArrowLeft") tourPrev();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  function tourNext() {
    if (spot() < TOUR.length - 1) setSpot(spot() + 1);
    else setStep("keys");
  }
  function tourPrev() {
    if (spot() > 0) setSpot(spot() - 1);
    else setStep("connect");
  }

  /** Spotlight box: the target plus a margin, kept inside the window. */
  const spotBox = () => {
    const r = rect();
    if (!r) return null;
    const m = 8;
    // May touch the window edge (Gib sits in the corner) but never crops the target.
    const left = Math.max(0, r.left - m);
    const top = Math.max(0, r.top - m);
    const right = Math.min(window.innerWidth, r.right + m);
    const bottom = Math.min(window.innerHeight, r.bottom + m);
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };

  /** Places the bubble where it fits entirely (right, left, below, above), using its real height. */
  const bubbleStyle = () => {
    const r = spotBox();
    const w = Math.min(330, window.innerWidth - 24);
    const h = bubbleH();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 12;
    const gap = 14;
    if (!r) return { left: `${(vw - w) / 2}px`, top: `${Math.max(pad, (vh - h) / 2)}px`, width: `${w}px` };
    const clampTop = (t: number) => Math.max(pad, Math.min(t, vh - h - pad));
    const clampLeft = (l: number) => Math.max(pad, Math.min(l, vw - w - pad));
    const midTop = clampTop(r.top + r.height / 2 - h / 2);
    const midLeft = clampLeft(r.left + r.width / 2 - w / 2);
    const candidates = [
      { left: r.left + r.width + gap, top: midTop, fits: r.left + r.width + gap + w <= vw - pad },
      { left: r.left - gap - w, top: midTop, fits: r.left - gap - w >= pad },
      { left: midLeft, top: r.top + r.height + gap, fits: r.top + r.height + gap + h <= vh - pad },
      { left: midLeft, top: r.top - gap - h, fits: r.top - gap - h >= pad },
    ];
    const chosen = candidates.find((c) => c.fits) ?? { left: clampLeft(r.left), top: clampTop(r.top) };
    return { left: `${clampLeft(chosen.left)}px`, top: `${clampTop(chosen.top)}px`, width: `${w}px` };
  };

  const mood = (): GibMood => {
    if (busy()) return "think";
    switch (step()) {
      case "welcome":
        return "wave";
      case "connect":
        return "idle";
      case "keys":
        return "idea";
      case "done":
        return "happy";
      default:
        return "idle";
    }
  };

  async function sample() {
    setBusy(true);
    try {
      const id = await createSampleDatabase(SEED);
      openQuery(id, "-- Clientes y su gasto total\nSELECT c.name, c.city, count(o.id) AS pedidos, sum(o.total) AS total\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nGROUP BY c.id\nORDER BY total DESC;", "ejemplo.sql");
      setSpot(0);
      setStep("tour");
    } catch (err) {
      notify("No se pudo crear la base de ejemplo", "error", errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // While the import assistant is open the guide steps aside; it comes back on this same step afterwards.
  return (
    <Show when={!migration.open}>
      <Show
        when={step() === "tour"}
        fallback={
          <>
            <div class="scrim onb-scrim" />
            <div class="onboarding" role="dialog" aria-label="Guía de inicio">
              <aside class="onb-stage">
                <div class="onb-glow" />
                <div class="onb-brand"><Mark size={18} /><span>Celer</span></div>
                <Show when={gibShows("overlays")}><div class="onb-gib"><Gib size={120} pose="poker" mood={mood()} /></div></Show>
                <ol class="onb-steps">
                  <For each={STEPS}>
                    {(item, i) => (
                      <li classList={{ done: i() < index(), current: i() === index() }}>
                        <span class="dot">{i() < index() ? <Check size={10} stroke-width={3} /> : i() + 1}</span>
                        {item.label}
                      </li>
                    )}
                  </For>
                </ol>
              </aside>
              <section class="onb-body">
                <button type="button" class="icon-btn onb-close" title="Saltar la guía (Esc)" onClick={() => close(false)}><X size={15} /></button>
                <div class="onb-content">
                  <Switch>
                    <Match when={step() === "welcome"}>
                      <div class="onb-screen">
                        <h1>Bienvenido a Celer.</h1>
                        <p class="onb-lead">Soy Gib. En un minuto te enseño lo esencial: cómo se ve, cómo conectar, dónde está cada cosa y los atajos que te harán volar.</p>
                        <div class="onb-cards">
                          <div class="onb-card"><Palette size={16} /><b>Tu estilo</b><small>Temas claros, oscuros y de alto contraste.</small></div>
                          <div class="onb-card"><Database size={16} /><b>Tus datos</b><small>Conecta o prueba con una base de ejemplo.</small></div>
                          <div class="onb-card"><MousePointerClick size={16} /><b>Recorrido</b><small>Te señalo cada parte de la interfaz.</small></div>
                        </div>
                      </div>
                    </Match>

                    <Match when={step() === "look"}>
                      <div class="onb-screen">
                        <h2>¿Cómo te gusta?</h2>
                        <p class="onb-lead">Se aplica al momento. Lo puedes cambiar cuando quieras en Ajustes o con el botón ☀ de arriba.</p>
                        <div class="onb-themes">
                          <For each={themeChoices.filter((t) => ["dark", "light", "darcula", "contrast", "contrast-light", "system"].includes(t.id))}>
                            {(theme) => (
                              <button type="button" class="theme-card" classList={{ on: state.settings.theme === theme.id }} onClick={() => void saveSettings({ theme: theme.id as ThemeName })}>
                                <div class="theme-preview" data-theme-preview={theme.id === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme.id}>
                                  <div class="tp-side"><i /><i /><i class="t" /><i class="t" /><i /></div>
                                  <div class="tp-main">
                                    <div class="tp-code"><span class="k">SELECT</span> <span class="n">id</span>, <span class="f">count</span>(*)<br /><span class="k">FROM</span> <span class="t">orders</span></div>
                                    <div class="tp-grid"><i /><i /><i /></div>
                                  </div>
                                </div>
                                <span>{theme.label}</span>
                              </button>
                            )}
                          </For>
                        </div>
                        <div class="onb-row">
                          <span class="onb-label">Acento</span>
                          <div class="swatches">
                            <For each={ACCENTS}>
                              {(item) => <button type="button" class="swatch big" classList={{ on: state.settings.accent.toLowerCase() === item.value.toLowerCase() }} style={{ background: item.value }} title={item.name} onClick={() => void saveSettings({ accent: item.value })} />}
                            </For>
                          </div>
                        </div>
                        <div class="onb-row">
                          <span class="onb-label">Densidad</span>
                          <div class="seg">
                            <button type="button" classList={{ on: state.settings.density === "compact" }} onClick={() => void saveSettings({ density: "compact" })}>Compacta</button>
                            <button type="button" classList={{ on: state.settings.density === "comfortable" }} onClick={() => void saveSettings({ density: "comfortable" })}>Cómoda</button>
                          </div>
                        </div>
                      </div>
                    </Match>

                    <Match when={step() === "connect"}>
                      <div class="onb-screen">
                        <h2>Tu primera conexión</h2>
                        <p class="onb-lead">Elige tu motor y rellena los datos, o empieza con una base de ejemplo que creo ahora mismo (SQLite, sin instalar nada).</p>
                        <button type="button" class="onb-sample" disabled={busy()} onClick={() => void sample()}>
                          <EngineIcon kind="sqlite" size={26} />
                          <span>
                            <b>{busy() ? "Creando la base de ejemplo…" : "Probar con datos de ejemplo"}</b>
                            <small>Clientes y pedidos listos para consultar · recomendado si es tu primera vez</small>
                          </span>
                          <ArrowRight size={16} />
                        </button>
                        <div class="onb-engines">
                          <For each={ENGINES}>
                            {(engine) => (
                              <button type="button" class="onb-engine" onClick={() => { setState("onboardingOpen", false); void saveSettings({ onboarded: true }); openConnDialog(emptyConn(engine.kind)); }}>
                                <EngineIcon kind={engine.kind} size={22} />
                                <span>{engine.label}</span>
                              </button>
                            )}
                          </For>
                        </div>
                        <button type="button" class="link small onb-import" onClick={() => void openMigration()}>
                          ¿Vienes de DBeaver o DbVisualizer? Importa tus conexiones
                        </button>
                        <Show when={state.connections.length}>
                          <p class="onb-note">Ya tienes {state.connections.length} {state.connections.length === 1 ? "conexión" : "conexiones"}: puedes pasar directamente al recorrido.</p>
                        </Show>
                      </div>
                    </Match>

                    <Match when={step() === "keys"}>
                      <div class="onb-screen">
                        <h2><Keyboard size={18} /> Los atajos que más vas a usar</h2>
                        <p class="onb-lead">Todos están también en la paleta (Mayús Mayús), con su atajo al lado.</p>
                        <div class="onb-keys">
                          <For each={KEYS}>{([keys, label]) => <div class="onb-key"><kbd>{keys}</kbd><span>{label}</span></div>}</For>
                        </div>
                      </div>
                    </Match>

                    <Match when={step() === "done"}>
                      <div class="onb-screen">
                        <h1>Ya lo tienes.</h1>
                        <p class="onb-lead">Me quedo en la esquina de abajo a la derecha. Si quieres un consejo, haz clic en mí. Puedes repetir esta guía desde la paleta: «Guía de inicio».</p>
                        <div class="onb-cards">
                          <button type="button" class="onb-card action" onClick={() => { close(true); setState({ paletteOpen: true, paletteMode: "all" }); }}><Sparkles size={16} /><b>Abrir la paleta</b><small>Mayús Mayús</small></button>
                          <button type="button" class="onb-card action" onClick={() => { close(true); openConnDialog(); }}><Database size={16} /><b>Nueva conexión</b><small>Ctrl+Alt+N</small></button>
                          <button type="button" class="onb-card action" onClick={() => { close(true); setState("settingsOpen", true); }}><Palette size={16} /><b>Ajustes</b><small>Ctrl+Alt+S</small></button>
                        </div>
                      </div>
                    </Match>
                  </Switch>
                </div>
                <footer class="onb-actions">
                  <Show when={index() > 0}>
                    <button type="button" class="btn" onClick={prev}><ArrowLeft size={14} /> Atrás</button>
                  </Show>
                  <Show when={step() === "welcome"}>
                    <button type="button" class="btn ghost-link" onClick={() => close(false)}>Saltar la guía</button>
                  </Show>
                  <span class="spacer" />
                  <span class="onb-count">{index() + 1} / {STEPS.length}</span>
                  <Show when={step() === "connect"}>
                    <button type="button" class="btn primary" onClick={() => { setSpot(0); setStep("tour"); }}>Hacer el recorrido <ArrowRight size={14} /></button>
                  </Show>
                  <Show when={step() !== "connect" && step() !== "done"}>
                    <button type="button" class="btn primary" onClick={next}>{step() === "welcome" ? "Empezar" : "Siguiente"} <ArrowRight size={14} /></button>
                  </Show>
                  <Show when={step() === "done"}>
                    <button type="button" class="btn primary" onClick={() => close(true)}>Empezar a trabajar</button>
                  </Show>
                </footer>
              </section>
            </div>
          </>
        }
      >
        {/* Interactive tour: a spotlight over the real interface plus a speech bubble from Gib. */}
        <div class="tour-blocker" onClick={tourNext} />
        <div
          class="tour-spot"
          style={
            spotBox()
              ? { left: `${spotBox()!.left}px`, top: `${spotBox()!.top}px`, width: `${spotBox()!.width}px`, height: `${spotBox()!.height}px` }
              : { left: "50%", top: "50%", width: "0px", height: "0px" }
          }
        />
        <div class="tour-bubble" ref={bubbleRef} style={bubbleStyle()}>
          <div class="tour-head">
            <Show when={gibShows("overlays")}><Gib size={34} pose="poker" mood="idle" plain /></Show>
            <div>
              <small>{spot() + 1} de {TOUR.length}</small>
              <b>{TOUR[spot()].title}</b>
            </div>
          </div>
          <p>{TOUR[spot()].body}</p>
          <div class="tour-actions">
            <button type="button" class="link small" onClick={() => setStep("keys")}>Saltar recorrido</button>
            <span class="spacer" />
            <button type="button" class="btn tiny" onClick={tourPrev}><ArrowLeft size={12} /></button>
            <button type="button" class="btn tiny primary" onClick={tourNext}>{spot() === TOUR.length - 1 ? "Terminar" : "Siguiente"} <ArrowRight size={12} /></button>
          </div>
          <div class="tour-dots"><For each={TOUR}>{(_, i) => <i classList={{ on: i() === spot() }} />}</For></div>
        </div>
      </Show>
    </Show>
  );
}

/** Applies the theme preview immediately (used by the look step). */
export function previewTheme(theme: ThemeName) {
  applyTheme(state.settings, theme);
}
