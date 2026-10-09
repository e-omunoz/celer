import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { shortcutLabel } from "../commands";
import { saveToLibrary } from "../library";
import { activeSql, activeTab, formatMs, gibEvent, gibName, notify, openPalette, reducedMotion, runActive, saveSettings, splashDone, state, type GibEvent } from "../state";
import { nextTip, queryAdvice, statementKey, type Advice } from "./advice";
import { memory, saveMemory, sessionAdvice } from "./memory";
import { Gib, type GibActivity, type GibMood } from "./Gib";

/** What Gib grumbles when you keep clicking him (one click is a tip; four in a row is pestering). */
const GRUMBLES = ["¡Eh! Que no soy un botón.", "Fuera, mosca…", "Ya van unos cuantos clics, ¿eh?"];
/** Clicks within this window count as pestering from the fourth on. */
const PESTER_MS = 5000;
const PESTER_CLICKS = 4;

interface Bubble {
  text: string;
  kind: "tip" | "info" | "warn" | "ok";
  action?: { label: string; run: () => void };
  sticky?: boolean;
  /** A grumble after a click: further clicks keep grumbling instead of closing it. */
  grumble?: boolean;
  /** One of the general tips (offers "Otro consejo"). */
  tipId?: string;
  /** Gib spoke on his own: typing elsewhere closes it, and it offers "No más consejos". */
  proactive?: boolean;
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
/**
 * Tips he volunteers: the first a few minutes into the session, then at most one every 15 minutes, only while you
 * pause (no input for 5 s, but back within a minute: nobody reads a bubble in an empty room) and only tips you have
 * not seen yet. When every tip has been seen he stops volunteering them; a click on him still gives one.
 */
const TIP_FIRST_MS = 3 * 60_000;
const TIP_EVERY_MS = 15 * 60_000;
const TIP_PAUSE_MIN_MS = 5000;
const TIP_PAUSE_MAX_MS = 60_000;
/** Performance and habit advice is repeated at most this many times, ever; warnings once per session. */
const ADVICE_REPEAT = 2;
/** The same statement run this many times in a session (and not from the library): suggest saving it. */
const REPEAT_RUNS = 3;

export function Companion() {
  const [asleep, setAsleep] = createSignal(false);
  const [thinking, setThinking] = createSignal(false);
  const [reaction, setReaction] = createSignal<GibMood | null>(null);
  const [hover, setHover] = createSignal(false);
  const [bubble, setBubble] = createSignal<Bubble | null>(null);
  const [activity, setActivity] = createSignal<GibActivity | null>(null);
  let tipCursor = 0;
  let lastInput = Date.now();
  let lastTip = Date.now() - TIP_EVERY_MS + TIP_FIRST_MS;
  let lastBubbleAt = 0;
  let nextActivityAt = Date.now() + IDLE_BEFORE_MS;
  let recent: string[] = [];
  let routineToken = 0;
  let routineTimer = 0;
  let reactionTimer = 0;
  let bubbleTimer = 0;
  let mouseRuns = 0;
  let clicks: number[] = [];
  const runs = new Map<string, number>();

  const mode = () => state.settings.companion;
  const running = () => state.tabs.some((tab) => (tab.kind === "sql" && tab.running) || (tab.kind === "table" && tab.loading));

  function react(mood: GibMood, ms = 1600) {
    window.clearTimeout(reactionTimer);
    setReaction(mood);
    reactionTimer = window.setTimeout(() => setReaction(null), ms);
  }

  /** Shows a bubble (closing itself after `ms` unless sticky). Hovering it keeps it open (see the markup). */
  function show(next: Bubble, ms = 6500) {
    window.clearTimeout(bubbleTimer);
    setBubble(next);
    lastBubbleAt = Date.now();
    if (!next.sticky) bubbleTimer = window.setTimeout(() => setBubble(null), ms);
  }

  /** Gib speaking on his own: nothing when he is off, and only warnings and news (no tips) when he is quiet. */
  function say(next: Bubble, ms = 6500): boolean {
    if (mode() === "off") return false;
    if (mode() !== "normal" && next.kind === "tip") return false;
    show(next, ms);
    return true;
  }

  /** Advice with a memory: warnings once per session, the rest at most ADVICE_REPEAT times ever. */
  function advise(id: string, kind: Advice["kind"], next: Bubble, ms = 9000): boolean {
    if (sessionAdvice.has(id)) return false;
    if (kind === "tip" && (memory.advice[id] ?? 0) >= ADVICE_REPEAT) return false;
    if (!say(next, ms)) return false;
    sessionAdvice.add(id);
    memory.advice[id] = (memory.advice[id] ?? 0) + 1;
    saveMemory();
    return true;
  }

  /**
   * One of the general tips: on demand any (unseen first, then they come round again); volunteered, only unseen
   * ones. False when there was nothing to say.
   */
  function showTip(proactive: boolean): boolean {
    if (mode() === "off") return false;
    const picked = nextTip(tipCursor, new Set(memory.seen), proactive);
    if (!picked) return false;
    const next: Bubble = { text: picked.tip.text(shortcutLabel), kind: "tip", tipId: picked.tip.id, proactive };
    if (!proactive) show(next, 9000);
    else if (!say(next, 8000)) return false;
    tipCursor = picked.index + 1;
    if (!memory.seen.includes(picked.tip.id)) {
      memory.seen.push(picked.tip.id);
      saveMemory();
    }
    return true;
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

  /** Nothing in front of him: no dialog, guide or palette open. */
  const unobstructed = () => !document.querySelector(".onboarding, .tour-spot, .modal-backdrop, .scrim");

  /** Activities only while Gib would otherwise just stand there (and someone may be looking). */
  const free = () =>
    mode() === "normal" &&
    splashDone() &&
    !reducedMotion() &&
    !document.hidden &&
    document.hasFocus() &&
    !running() &&
    !reaction() &&
    !bubble() &&
    !asleep() &&
    !hover() &&
    unobstructed();

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

  /** What to say after a statement ran fine: a likely mistake, a faster way, or a habit worth having. */
  function afterQuery(event: GibEvent) {
    const ms = event.ms ?? 0;
    const sql = event.detail ?? "";
    const plan = { label: "Ver plan", run: () => void runActive("explain") };
    const advice = queryAdvice({ sql, kind: event.kind, ms, columns: event.columns ?? 0, hasMore: Boolean(event.hasMore) });
    if (advice && advise(advice.id, advice.kind, { text: advice.text, kind: advice.kind === "warn" ? "warn" : "tip", action: advice.plan ? plan : undefined })) return;
    if (ms > 5000) {
      const keys = shortcutLabel("explain");
      if (advise("slow", "tip", { text: `Esta consulta tarda. El plan de ejecución${keys ? ` (${keys})` : ""} te enseña dónde se va el tiempo.`, kind: "tip", action: plan })) return;
    } else if (event.hasMore) {
      if (advise("paging", "tip", { text: "Hay más filas en el servidor: desplázate hacia abajo o pulsa «Cargar todo». Solo se traen las que ves.", kind: "tip" })) return;
    }
    // The same statement again and again, typed each time: the library keeps it.
    const key = statementKey(sql);
    if (key.length < 12) return;
    const count = (runs.get(key) ?? 0) + 1;
    runs.set(key, count);
    if (count >= REPEAT_RUNS && !activeSql()?.libraryId) {
      const keys = shortcutLabel("save-library");
      advise("repeat-library", "tip", {
        text: `Ya has lanzado esta consulta ${count} veces. Guárdala en la biblioteca${keys ? ` (${keys})` : ""} y la tendrás a mano.`,
        kind: "tip",
        action: { label: "Guardar", run: () => void saveToLibrary() },
      });
    }
  }

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
          afterQuery(event);
          break;
        }
        case "query-error": {
          react("error", 2600);
          const msg = (event.detail ?? "").toLowerCase();
          const tables = shortcutLabel("go-table");
          if (/does not exist|doesn't exist|no such table|invalid object name|unknown table/.test(msg) && !/column/.test(msg)) {
            advise("err-name", "warn", { text: `¿Un nombre mal escrito? ${tables ? `${tables} busca` : "La paleta busca"} tablas y vistas por nombre.`, kind: "info", action: { label: "Buscar tabla", run: () => openPalette("tables") } });
          } else if (/unknown column|column .* does not exist|no such column|invalid column/.test(msg)) {
            advise("err-column", "warn", { text: "Esa columna no existe. Escribe el alias y un punto para ver las columnas disponibles.", kind: "info" });
          } else if (/syntax|sintaxis/.test(msg)) {
            advise("err-syntax", "warn", { text: "Error de sintaxis: en «Salida» tienes la línea y la columna exactas.", kind: "info" });
          } else if (/permission denied|access denied|read only|solo lectura/.test(msg)) {
            advise("err-permission", "warn", { text: "Sin permiso para esa operación con este usuario o conexión.", kind: "warn" });
          }
          break;
        }
        case "connected":
          react("wave", 1800);
          if (event.production) advise(`production:${event.detail}`, "warn", { text: `«${event.detail}» es de producción: te pediré confirmación antes de cambios peligrosos.`, kind: "warn" }, 7000);
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
        case "mouse-run": {
          mouseRuns++;
          const keys = shortcutLabel("run");
          if (mouseRuns >= 3 && keys) advise("mouse", "tip", { text: `Truco: ${keys} ejecuta sin soltar el teclado.`, kind: "tip" });
          break;
        }
        case "tip":
          setAsleep(false);
          showTip(false);
          break;
        case "show-off": {
          setAsleep(false);
          setBubble(null);
          if (reducedMotion()) {
            say({ text: "Con las animaciones reducidas me quedo quieto. ¡Pero sigo aquí!", kind: "ok" }, 3500);
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

  // Reduced motion switched on while he was in the middle of something: back to the rest pose.
  createEffect(() => {
    if (reducedMotion()) stopRoutine();
  });

  onMount(() => {
    const mark = (event: Event) => {
      lastInput = Date.now();
      if (asleep()) {
        setAsleep(false);
        react("wave", 1600);
      }
      const onGib = event.target instanceof Element && event.target.closest(".companion");
      // Typing or clicking elsewhere ends an activity: Gib pays attention again. Clicks on Gib are his own business.
      if (activity() && !onGib) stopRoutine();
      // A tip he volunteered gets out of the way as soon as you type.
      if (event.type === "keydown" && !onGib && bubble()?.proactive) setBubble(null);
    };
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    const timer = window.setInterval(() => {
      const now = Date.now();
      const idleFor = now - lastInput;
      if (idleFor > 10 * 60 * 1000 && !running() && !activity()) setAsleep(true);
      const pause = idleFor > TIP_PAUSE_MIN_MS && idleFor < TIP_PAUSE_MAX_MS;
      if (
        mode() === "normal" &&
        pause &&
        now - lastTip > TIP_EVERY_MS &&
        now - lastBubbleAt > 60_000 &&
        !bubble() &&
        !running() &&
        !activity() &&
        !productionActive() &&
        !document.hidden &&
        document.hasFocus() &&
        unobstructed()
      ) {
        lastTip = now;
        showTip(true);
      }
      if (!activity() && idleFor > IDLE_BEFORE_MS && now > nextActivityAt && free()) play(pickRoutine());
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

  /** Waiting for a query and nothing else going on: the cursor is a fly. */
  const waiting = () => !running() && !thinking() && !asleep() && (!reaction() || reaction() === "grumpy");

  /** A double click is love, not two clicks: single clicks wait a moment to see whether a second one comes. */
  let clickTimer = 0;
  function onClick() {
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(handleClick, 230);
  }

  /** A click is a tip (or closes the bubble); clicking on and on is pestering, and he grumbles. */
  function handleClick() {
    const at = Date.now();
    clicks = [...clicks.filter((t) => at - t < PESTER_MS), at];
    if (clicks.length >= PESTER_CLICKS && !running() && !thinking()) {
      stopRoutine();
      react("grumpy", 1400);
      const step = clicks.length - PESTER_CLICKS;
      if (step >= GRUMBLES.length - 1) clicks = [];
      if (mode() !== "off") show({ text: GRUMBLES[Math.min(step, GRUMBLES.length - 1)], kind: "ok", grumble: true }, 2200);
      return;
    }
    if (bubble() && !bubble()!.grumble) {
      setBubble(null);
      return;
    }
    stopRoutine();
    setAsleep(false);
    if (showTip(false)) react("wave", 1200);
  }

  const mood = (): GibMood => {
    const r = reaction();
    if (r) return r;
    if (thinking()) return "think";
    if (asleep()) return "sleep";
    // Talking to you, he does not swat at you.
    if (hover() && waiting() && !bubble() && activity() !== "coffee-away") return "annoyed";
    return "idle";
  };

  const closeBubble = () => {
    window.clearTimeout(bubbleTimer);
    setBubble(null);
  };

  return (
    <Show when={mode() !== "off"}>
      <div class="companion" classList={{ landed: splashDone() }}>
        <Show when={bubble()}>
          {(b) => (
            <div
              class={`tip ${b().kind}`}
              role="status"
              // Reading it: it stays while the pointer is on it, and gives a moment after.
              onPointerEnter={() => window.clearTimeout(bubbleTimer)}
              onPointerLeave={() => {
                if (b().sticky) return;
                window.clearTimeout(bubbleTimer);
                bubbleTimer = window.setTimeout(() => setBubble(null), 2500);
              }}
            >
              <p>{b().text}</p>
              <div class="tip-actions">
                <Show when={b().proactive}>
                  <button
                    type="button"
                    class="link small tip-mute"
                    title={`${gibName()} deja de ofrecer consejos por su cuenta (Ajustes › Apariencia › Gib)`}
                    onClick={() => {
                      closeBubble();
                      void saveSettings({ companion: "quiet" });
                      notify(`${gibName()} ya no dará consejos por su cuenta`, "info", "Haz clic en él para pedir uno, o vuelve a «Normal» en Ajustes › Apariencia › Gib.");
                    }}
                  >
                    No más consejos
                  </button>
                  <span class="spacer" />
                </Show>
                <Show when={b().action}>
                  <button type="button" class="btn tiny primary" onClick={() => { const action = b().action!; closeBubble(); action.run(); }}>{b().action!.label}</button>
                </Show>
                <Show when={b().tipId}>
                  <button type="button" class="btn tiny" onClick={() => showTip(false)}>Otro consejo</button>
                </Show>
                <button type="button" class="btn tiny" onClick={closeBubble}>Cerrar</button>
              </div>
            </div>
          )}
        </Show>
        <Gib
          size={46}
          pose={mood() === "sleep" ? "monday" : state.settings.gib.pose}
          mood={mood()}
          activity={activity()}
          label={`${gibName()}: haz clic para un consejo`}
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
            closeBubble();
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
