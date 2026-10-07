import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { activeTab, state } from "../state";
import { Gib, type GibMood } from "./Gib";

const TIPS = [
  "Ctrl+Enter ejecuta la sentencia bajo el cursor.",
  "Alt+X ejecuta el script completo.",
  "Las conexiones de producción piden confirmación antes de un UPDATE o DELETE sin WHERE.",
  "Doble clic en una celda edita la tabla. Guardar muestra el SQL antes de aplicarlo.",
  "El historial conserva cada consulta con su duración y su conexión.",
];

export function Companion() {
  const [asleep, setAsleep] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [tipOpen, setTipOpen] = createSignal(false);
  const [proactive, setProactive] = createSignal(false);
  const [tipIndex, setTipIndex] = createSignal(0);
  let lastInput = Date.now();
  let lastTip = 0;

  const running = () => state.tabs.some((tab) => (tab.kind === "sql" && tab.running) || (tab.kind === "table" && tab.loading));

  createEffect(() => {
    if (!running()) {
      setBusy(false);
      return;
    }
    const timer = window.setTimeout(() => setBusy(true), 2000);
    onCleanup(() => window.clearTimeout(timer));
  });

  onMount(() => {
    const mark = () => {
      lastInput = Date.now();
      if (asleep()) setAsleep(false);
    };
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    const timer = window.setInterval(() => {
      const idleFor = Date.now() - lastInput;
      if (idleFor > 10 * 60 * 1000) setAsleep(true);
      const mode = state.settings.companion;
      const active = activeTab();
      const queryRunning = active?.kind === "sql" && active.running;
      if (
        mode === "normal" &&
        !tipOpen() &&
        !queryRunning &&
        !connectionProduction() &&
        idleFor > 5000 &&
        Date.now() - lastTip > 15 * 60 * 1000
      ) {
        lastTip = Date.now();
        setProactive(true);
        setTipOpen(true);
        window.setTimeout(() => {
          if (proactive()) setTipOpen(false);
        }, 8000);
      }
    }, 4000);
    onCleanup(() => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      window.clearInterval(timer);
    });
  });

  const mood = (): GibMood => {
    if (busy()) return "busy";
    const active = activeTab();
    if (active?.kind === "sql" && active.error) return "error";
    if (asleep()) return "sleep";
    return "idle";
  };

  return (
    <Show when={state.settings.companion !== "off"}>
      <div class="companion">
        <Show when={tipOpen()}>
          <div class="tip" role="status">
            <p>{TIPS[tipIndex() % TIPS.length]}</p>
            <div class="tip-actions">
              <button type="button" class="btn tiny" onClick={() => { setProactive(false); setTipIndex((index) => index + 1); }}>Siguiente</button>
              <button type="button" class="btn tiny" onClick={() => { setProactive(false); setTipOpen(false); }}>Ocultar</button>
            </div>
          </div>
        </Show>
        <Gib
          size={40}
          pose={mood() === "busy" ? "laptop" : mood() === "sleep" ? "monday" : "icon"}
          mood={mood()}
          label="Gib, consejos"
          onClick={() => {
            setProactive(false);
            setTipOpen((open) => !open);
          }}
        />
        <Show when={mood() === "ok"}><i class="gib-badge ok">✓</i></Show>
        <Show when={mood() === "error"}><i class="gib-badge ask">?</i></Show>
        <Show when={mood() === "sleep"}><i class="gib-badge sleep">z</i></Show>
      </div>
    </Show>
  );
}

function connectionProduction() {
  const id = activeTab()?.connId;
  return Boolean(id && state.connections.find((conn) => conn.id === id)?.production);
}
