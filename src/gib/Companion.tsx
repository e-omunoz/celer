import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { activeTab, formatMs, gibEvent, openPalette, runActive, splashDone, state } from "../state";
import { Gib, type GibActivity, type GibMood } from "./Gib";

const TIPS = [
  "Ctrl+Intro ejecuta la sentencia bajo el cursor, o la selección si la hay.",
  "Pulsa Mayús dos veces para buscar tablas, pestañas y acciones.",
  "Ctrl+N salta a cualquier tabla de las conexiones abiertas.",
  "Selecciona varias celdas: la barra de estado muestra suma, media, mínimo y máximo.",
  "En una tabla, «+ Filtro» crea filtros por columna sin escribir SQL.",
  "Clic derecho en una celda: «Filtrar por este valor» añade el filtro por ti.",
  "Ctrl+F busca dentro de los resultados; F3 salta a la siguiente coincidencia.",
  "Ctrl+Mayús+E muestra el plan de ejecución de la sentencia.",
  "Arrastra una tabla del explorador al editor para escribir su nombre.",
  "Las conexiones de producción piden confirmación antes de un UPDATE o DELETE sin WHERE.",
  "Al guardar cambios en una tabla verás el SQL; se aplica en una sola transacción.",
  "Alt+7 abre el panel de valor: JSON formateado y la fila como formulario.",
  "Doble clic en el borde de una cabecera ajusta el ancho de la columna.",
  "Copia una selección como JSON, Markdown, INSERT o lista IN desde el clic derecho.",
  "Ctrl+clic en el nombre de una tabla dentro del SQL la abre; en una clave foránea, va a la fila.",
];

/** What Gib grumbles when you insist on clicking him. */
const GRUMBLES = ["¡Eh! Que no soy un botón.", "Fuera, mosca…", "Estoy esperando tu consulta, ¿eh?", "Vale, vale. ¿Quieres un consejo?"];

interface Bubble {
  text: string;
  kind: "tip" | "info" | "warn" | "ok";
  action?: { label: string; run: () => void };
  sticky?: boolean;
  /** A grumble after a click: further clicks keep grumbling instead of closing it. */
  grumble?: boolean;
}

/**
 * Idle activities. Each one is a script of steps (activity + duration in ms); the durations match the CSS in
 * activities.css, so every step ends on the rest pose.
 */
const ROUTINES: Record<string, { step: GibActivity; ms: number }[]> = {
  yawn: [{ step: "yawn", ms: 3400 }],
  coffee: [
    { step: "coffee-out", ms: 1600 },
    { step: "coffee-away", ms: 5000 },
    { step: "coffee-in", ms: 1600 },
    { step: "coffee-sip", ms: 6400 },
    { step: "coffee-done", ms: 1200 },
  ],
  laptop: [{ step: "laptop", ms: 8000 }],
  doze: [{ step: "doze", ms: 5500 }],
  juggle: [{ step: "juggle", ms: 5600 }],
  read: [{ step: "read", ms: 8000 }],
  dance: [{ step: "dance", ms: 4800 }],
  scratch: [{ step: "scratch", ms: 3600 }],
  bug: [{ step: "bug", ms: 6000 }],
};
const ROUTINE_NAMES = Object.keys(ROUTINES);
/** Quiet before the first activity, and the gap between two (random in between). */
const IDLE_BEFORE_MS = 40_000;
const GAP_MIN_MS = 25_000;
const GAP_MAX_MS = 70_000;

export function Companion() {
  const [asleep, setAsleep] = createSignal(false);
  const [thinking, setThinking] = createSignal(false);
  const [reaction, setReaction] = createSignal<GibMood | null>(null);
  const [hover, setHover] = createSignal(false);
  const [bubble, setBubble] = createSignal<Bubble | null>(null);
  const [activity, setActivity] = createSignal<GibActivity | null>(null);
  const [tipIndex, setTipIndex] = createSignal(Math.floor(Math.random() * TIPS.length));
  let lastInput = Date.now();
  let lastTip = Date.now();
  let nextActivityAt = Date.now() + IDLE_BEFORE_MS;
  let recent: string[] = [];
  let routineToken = 0;
  let routineTimer = 0;
  let reactionTimer = 0;
  let bubbleTimer = 0;
  let mouseRuns = 0;
  let clicks: number[] = [];
  const shown = new Set<string>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const mode = () => state.settings.companion;
  const running = () => state.tabs.some((tab) => (tab.kind === "sql" && tab.running) || (tab.kind === "table" && tab.loading));

  function react(mood: GibMood, ms = 1600) {
    window.clearTimeout(reactionTimer);
    setReaction(mood);
    reactionTimer = window.setTimeout(() => setReaction(null), ms);
  }

  function say(next: Bubble, ms = 6500) {
    if (mode() !== "normal" && next.kind === "tip") return;
    if (mode() === "off") return;
    window.clearTimeout(bubbleTimer);
    setBubble(next);
    if (!next.sticky) bubbleTimer = window.setTimeout(() => setBubble(null), ms);
  }

  function once(key: string, bubbleValue: Bubble) {
    if (shown.has(key)) return;
    shown.add(key);
    say(bubbleValue);
  }

  // ------------------------------------------------------------ idle activities
  /** Plays a routine step by step; a newer routine or stopRoutine() cancels it. */
  function play(name: string) {
    const steps = ROUTINES[name];
    if (!steps) return;
    const token = ++routineToken;
    recent = [name, ...recent].slice(0, 3);
    let index = 0;
    const next = () => {
      if (token !== routineToken) return;
      if (index >= steps.length) {
        setActivity(null);
        nextActivityAt = Date.now() + GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
        return;
      }
      const { step, ms } = steps[index++];
      setActivity(step);
      routineTimer = window.setTimeout(next, ms);
    };
    next();
  }

  function stopRoutine() {
    routineToken++;
    window.clearTimeout(routineTimer);
    if (activity()) {
      setActivity(null);
      nextActivityAt = Date.now() + GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
    }
  }

  function pickRoutine() {
    const options = ROUTINE_NAMES.filter((name) => !recent.includes(name));
    return options[Math.floor(Math.random() * options.length)] ?? "yawn";
  }

  /** Activities only while Gib would otherwise just stand there. */
  const free = () =>
    mode() === "normal" &&
    splashDone() &&
    !reducedMotion.matches &&
    !document.hidden &&
    !running() &&
    !reaction() &&
    !bubble() &&
    !asleep() &&
    !hover() &&
    !document.querySelector(".onboarding, .tour-spot, .modal-backdrop, .scrim");

  // Thinking while something runs for more than a moment; anything running interrupts an activity.
  createEffect(() => {
    if (!running()) {
      setThinking(false);
      return;
    }
    stopRoutine();
    const timer = window.setTimeout(() => setThinking(true), 500);
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(
    on(gibEvent, (event) => {
      if (!event || !splashDone()) return;
      if (event.type !== "mouse-run") stopRoutine();
      switch (event.type) {
        case "query-ok": {
          const ms = event.ms ?? 0;
          if (ms > 1500) {
            react("idea", 2200);
            say({ text: `Listo en ${formatMs(ms)}.`, kind: "ok" }, 3500);
          } else react("happy", 1300);
          if (ms > 5000) once("slow", { text: "Esta consulta tarda. Ctrl+Mayús+E muestra su plan de ejecución.", kind: "tip", action: { label: "Ver plan", run: () => void runActive("explain") } });
          else if (event.hasMore) once("paging", { text: "Hay más filas en el servidor: desplázate hacia abajo o pulsa «Cargar todo». Solo se traen las que ves.", kind: "tip" });
          break;
        }
        case "query-error": {
          react("error", 2600);
          const msg = (event.detail ?? "").toLowerCase();
          if (/does not exist|doesn't exist|no such table|invalid object name|unknown table/.test(msg)) {
            say({ text: "¿Un nombre mal escrito? Ctrl+N busca tablas y vistas por nombre.", kind: "info", action: { label: "Buscar tabla", run: () => openPalette("tables") } });
          } else if (/unknown column|column .* does not exist|no such column|invalid column/.test(msg)) {
            say({ text: "Esa columna no existe. Escribe el alias y un punto para ver las columnas disponibles.", kind: "info" });
          } else if (/syntax|sintaxis/.test(msg)) {
            say({ text: "Error de sintaxis: en «Salida» tienes la línea y la columna exactas.", kind: "info" });
          } else if (/permission denied|access denied|read only|solo lectura/.test(msg)) {
            say({ text: "Sin permiso para esa operación con este usuario o conexión.", kind: "warn" });
          }
          break;
        }
        case "connected":
          react("wave", 1800);
          if (event.production) say({ text: `«${event.detail}» es de producción: te pediré confirmación antes de cambios peligrosos.`, kind: "warn" }, 7000);
          break;
        case "connect-failed":
          react("error", 2400);
          break;
        case "commit":
        case "saved":
          react("ok", 1600);
          break;
        case "rollback":
          react("wave", 1200);
          break;
        case "mouse-run":
          mouseRuns++;
          if (mouseRuns === 3) once("mouse", { text: "Truco: Ctrl+Intro ejecuta sin soltar el teclado.", kind: "tip" });
          break;
        case "tip":
          setAsleep(false);
          nextTip(true);
          break;
        case "show-off": {
          setAsleep(false);
          setBubble(null);
          if (reducedMotion.matches) {
            say({ text: "Con «reducir movimiento» activado en el sistema me quedo quieto. ¡Pero sigo aquí!", kind: "ok" }, 3500);
            break;
          }
          const name = event.detail && ROUTINES[event.detail] ? event.detail : pickRoutine();
          // Next tick: the Enter that picked the command in the palette still has to reach the window listener,
          // which would otherwise stop the routine straight away.
          window.setTimeout(() => play(name), 0);
          break;
        }
      }
    }),
  );

  // The cursor arriving while an activity runs (also when he comes back from the coffee break under it).
  createEffect(() => {
    const current = activity();
    if (current && current !== "coffee-away" && hover() && waiting()) stopRoutine();
  });

  // Contextual hint for SELECT * on a production console, once.
  createEffect(() => {
    const tab = activeTab();
    if (tab?.kind !== "sql" || !splashDone()) return;
    if (/select\s+\*\s+from/i.test(tab.sql) && tab.sql.length < 400 && tab.results.some((result) => result.columns.length > 12)) {
      once("star", { text: "Muchas columnas: nombra solo las que necesitas y la consulta irá más rápida.", kind: "tip" });
    }
  });

  onMount(() => {
    const mark = (event: Event) => {
      lastInput = Date.now();
      if (asleep()) {
        setAsleep(false);
        react("wave", 1600);
      }
      // Typing or clicking elsewhere ends an activity: Gib pays attention again. Clicks on Gib are his own business.
      if (activity() && !(event.target instanceof Element && event.target.closest(".companion"))) stopRoutine();
    };
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    const timer = window.setInterval(() => {
      const idleFor = Date.now() - lastInput;
      if (idleFor > 10 * 60 * 1000 && !running() && !activity()) setAsleep(true);
      if (mode() === "normal" && !bubble() && !running() && !activity() && !productionActive() && idleFor > 5000 && Date.now() - lastTip > 15 * 60 * 1000) {
        lastTip = Date.now();
        nextTip();
      }
      if (!activity() && idleFor > IDLE_BEFORE_MS && Date.now() > nextActivityAt && free()) play(pickRoutine());
    }, 2000);
    onCleanup(() => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      window.clearInterval(timer);
      window.clearTimeout(reactionTimer);
      window.clearTimeout(bubbleTimer);
      window.clearTimeout(routineTimer);
      window.clearTimeout(clickTimer);
    });
  });

  function nextTip(force = false) {
    const index = tipIndex();
    setTipIndex(index + 1);
    const tip = { text: TIPS[index % TIPS.length], kind: "tip" as const };
    if (force && mode() !== "off") {
      window.clearTimeout(bubbleTimer);
      setBubble(tip);
      bubbleTimer = window.setTimeout(() => setBubble(null), 9000);
    } else say(tip, 9000);
  }

  /** Waiting for a query and nothing else going on: the cursor is a fly, and a click is worse. */
  const waiting = () => !running() && !thinking() && !asleep() && (!reaction() || reaction() === "grumpy");

  /** A double click is love, not two grumbles: single clicks wait a moment to see whether a second one comes. */
  let clickTimer = 0;
  function onClick() {
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(handleClick, 230);
  }

  function handleClick() {
    if (bubble() && !bubble()!.grumble) {
      setBubble(null);
      return;
    }
    if (!waiting()) return;
    stopRoutine();
    react("grumpy", 1400);
    // Insisting gets grumbles; the fifth click in a row softens into the offer of a tip.
    const at = Date.now();
    clicks = [...clicks.filter((t) => at - t < 6000), at];
    if (clicks.length >= 2) {
      const line = GRUMBLES[Math.min(clicks.length - 2, GRUMBLES.length - 1)];
      if (line === GRUMBLES[GRUMBLES.length - 1]) {
        clicks = [];
        if (mode() !== "off") {
          window.clearTimeout(bubbleTimer);
          setBubble({ text: line, kind: "info", action: { label: "Sí, uno", run: () => window.setTimeout(() => nextTip(true), 0) } });
          bubbleTimer = window.setTimeout(() => setBubble(null), 6000);
        }
      } else if (mode() !== "off") {
        window.clearTimeout(bubbleTimer);
        setBubble({ text: line, kind: "ok", grumble: true });
        bubbleTimer = window.setTimeout(() => setBubble(null), 2200);
      }
    }
  }

  const mood = (): GibMood => {
    const r = reaction();
    if (r) return r;
    if (thinking()) return "think";
    if (asleep()) return "sleep";
    if (hover() && waiting() && activity() !== "coffee-away") return "annoyed";
    return "idle";
  };

  return (
    <Show when={mode() !== "off"}>
      <div class="companion" classList={{ landed: splashDone() }}>
        <Show when={bubble()}>
          {(b) => (
            <div class={`tip ${b().kind}`} role="status">
              <p>{b().text}</p>
              <div class="tip-actions">
                <Show when={b().action}>
                  <button type="button" class="btn tiny primary" onClick={() => { const action = b().action!; setBubble(null); action.run(); }}>{b().action!.label}</button>
                </Show>
                <Show when={b().kind === "tip"}>
                  <button type="button" class="btn tiny" onClick={() => nextTip(true)}>Otro consejo</button>
                </Show>
                <button type="button" class="btn tiny" onClick={() => setBubble(null)}>Cerrar</button>
              </div>
            </div>
          )}
        </Show>
        <Gib
          size={46}
          pose={mood() === "sleep" ? "monday" : "poker"}
          mood={mood()}
          activity={activity()}
          label="Gib"
          onHover={(inside) => {
            setHover(inside);
            // The cursor interrupts whatever he was doing (except while he is away for coffee).
            if (inside && activity() && activity() !== "coffee-away" && waiting()) stopRoutine();
          }}
          onClick={onClick}
          onDblClick={() => {
            window.clearTimeout(clickTimer);
            clicks = [];
            stopRoutine();
            setBubble(null);
            react("love", 1800);
          }}
        />
      </div>
    </Show>
  );
}

function productionActive() {
  const id = activeTab()?.connId;
  return Boolean(id && state.connections.find((conn) => conn.id === id)?.production);
}
