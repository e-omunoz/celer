import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { activeTab, formatMs, gibEvent, openPalette, runActive, splashDone, state } from "../state";
import { Gib, type GibMood } from "./Gib";

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
];

interface Bubble {
  text: string;
  kind: "tip" | "info" | "warn" | "ok";
  action?: { label: string; run: () => void };
  sticky?: boolean;
}

export function Companion() {
  const [asleep, setAsleep] = createSignal(false);
  const [thinking, setThinking] = createSignal(false);
  const [reaction, setReaction] = createSignal<GibMood | null>(null);
  const [hover, setHover] = createSignal(false);
  const [bubble, setBubble] = createSignal<Bubble | null>(null);
  const [tipIndex, setTipIndex] = createSignal(Math.floor(Math.random() * TIPS.length));
  let lastInput = Date.now();
  let lastTip = Date.now();
  let reactionTimer = 0;
  let bubbleTimer = 0;
  let mouseRuns = 0;
  const shown = new Set<string>();

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

  // Thinking while something runs for more than a moment.
  createEffect(() => {
    if (!running()) {
      setThinking(false);
      return;
    }
    const timer = window.setTimeout(() => setThinking(true), 500);
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(
    on(gibEvent, (event) => {
      if (!event || !splashDone()) return;
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
      }
    }),
  );

  // Contextual hint for SELECT * on a production console, once.
  createEffect(() => {
    const tab = activeTab();
    if (tab?.kind !== "sql" || !splashDone()) return;
    if (/select\s+\*\s+from/i.test(tab.sql) && tab.sql.length < 400 && tab.results.some((result) => result.columns.length > 12)) {
      once("star", { text: "Muchas columnas: nombra solo las que necesitas y la consulta irá más rápida.", kind: "tip" });
    }
  });

  onMount(() => {
    const mark = () => {
      lastInput = Date.now();
      if (asleep()) {
        setAsleep(false);
        react("wave", 1600);
      }
    };
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    const timer = window.setInterval(() => {
      const idleFor = Date.now() - lastInput;
      if (idleFor > 10 * 60 * 1000 && !running()) setAsleep(true);
      if (mode() === "normal" && !bubble() && !running() && !productionActive() && idleFor > 5000 && Date.now() - lastTip > 15 * 60 * 1000) {
        lastTip = Date.now();
        nextTip();
      }
    }, 4000);
    onCleanup(() => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      window.clearInterval(timer);
      window.clearTimeout(reactionTimer);
      window.clearTimeout(bubbleTimer);
    });
  });

  function nextTip() {
    const index = tipIndex();
    setTipIndex(index + 1);
    say({ text: TIPS[index % TIPS.length], kind: "tip" }, 9000);
  }

  const mood = (): GibMood => {
    const r = reaction();
    if (r) return r;
    if (thinking()) return "think";
    if (asleep()) return "sleep";
    if (hover()) return "wave";
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
                  <button type="button" class="btn tiny primary" onClick={() => { b().action!.run(); setBubble(null); }}>{b().action!.label}</button>
                </Show>
                <Show when={b().kind === "tip"}>
                  <button type="button" class="btn tiny" onClick={() => nextTip()}>Otro consejo</button>
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
          label="Gib: consejos"
          onHover={setHover}
          onClick={() => {
            if (bubble()) setBubble(null);
            else nextTip();
          }}
          onDblClick={() => {
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
