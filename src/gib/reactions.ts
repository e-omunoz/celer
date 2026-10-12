// What Gib does when something happens (a long query finishes, an error, an empty result, a big export, the connection
// drops or comes back, the first query of the day, a long session, Friday afternoon, late at night), and how often he
// may speak up. Pure, so dev/gib-advice-check.ts can test it without the app; the companion (Companion.tsx) feeds it
// the events and the clock, and shows what it returns.
import type { GibActivity, GibMood } from "./Gib";
import type { GibFrequency } from "./prefs.ts";

/** At most this many reactions with a bubble per hour (a passing face does not count). */
export const REACTIONS_PER_HOUR: Record<GibFrequency, number> = { rare: 3, normal: 8, often: 16 };
/** Quiet before the first idle activity, and the gap between two (random in between), in ms. */
export const IDLE_GAP_MS: Record<GibFrequency, [number, number]> = {
  rare: [6 * 60_000, 12 * 60_000],
  normal: [2.5 * 60_000, 6 * 60_000],
  often: [60_000, 2.5 * 60_000],
};
/** How long without input (keys, clicks) before he may start an activity: you are reading, not working. */
export const IDLE_AFTER_MS: Record<GibFrequency, number> = { rare: 90_000, normal: 60_000, often: 40_000 };

/** A query is "long" from here on: finishing it deserves a word. */
export const LONG_RUN_MS = 20_000;
/** An export is "big" from here on (rows, or time). */
export const BIG_EXPORT_ROWS = 50_000;
export const BIG_EXPORT_MS = 15_000;
/** A session is "long" after this much time with you working in it, and the hint is not repeated before as long again. */
export const LONG_SESSION_MS = 2 * 60 * 60_000;
/** The same kind of reaction is not repeated within this time (a dropped connection is noticed by many tabs at once). */
export const SAME_REACTION_MS = 15_000;

/** The moments in the last hour when he spoke up: can he do it again now? */
export function budgetAllows(spent: readonly number[], now: number, frequency: GibFrequency): boolean {
  return spent.filter((at) => now - at < 60 * 60_000).length < REACTIONS_PER_HOUR[frequency];
}

/** The spent list with `now` added and what is older than an hour dropped. */
export function spend(spent: readonly number[], now: number): number[] {
  return [...spent.filter((at) => now - at < 60 * 60_000), now];
}

/** The next idle activity: none of the last few, and the long ones (the coffee break) less often. */
export function pickRoutine(names: readonly string[], recent: readonly string[], random = Math.random): string {
  const fresh = names.filter((name) => !recent.includes(name));
  const pool = fresh.length ? fresh : [...names];
  const weight = (name: string) => (name === "coffee" ? 0.5 : 1);
  const total = pool.reduce((sum, name) => sum + weight(name), 0);
  let at = random() * total;
  for (const name of pool) {
    at -= weight(name);
    if (at < 0) return name;
  }
  return pool[pool.length - 1] ?? "yawn";
}

export type ReactionEvent =
  | { type: "query-ok"; ms: number; rows: number | null; empty: boolean; production?: boolean }
  | { type: "query-error"; streak: number }
  | { type: "export-done"; rows: number; ms: number }
  | { type: "conn-lost"; name: string }
  | { type: "conn-back"; name: string };

export interface ReactionContext {
  now: Date;
  /** His name (Settings › Apariencia › Gib). */
  name: string;
  /** Things said once a day / night / session already ("first:2026-10-09", "friday:…", "late:…", "session:3"). */
  said: ReadonlySet<string>;
  /** The day of the last query, from his memory ("" never). */
  lastQueryDay: string;
  /** How long you have been working in this session (ms; pauses of more than half an hour start it again). */
  sessionMs: number;
  formatMs: (ms: number) => string;
}

export interface Reaction {
  /** Kind (for SAME_REACTION_MS) and, for once-only ones, the key to remember in `said`. */
  id: string;
  once?: string;
  mood: GibMood;
  /** How long the face lasts. */
  ms: number;
  /** What he says, if anything (a bubble: it counts against the budget). */
  text?: string;
  kind?: "ok" | "info" | "warn";
  /** An idle-style flourish to play instead of a face (only when he is free). */
  activity?: GibActivity;
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The night a late hour belongs to: after midnight it is still the previous evening's. */
function nightKey(date: Date): string {
  const d = new Date(date);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return dayKey(d);
}

export const isLate = (date: Date) => date.getHours() >= 22 || date.getHours() < 6;
export const isFridayAfternoon = (date: Date) => date.getDay() === 5 && date.getHours() >= 15;

function greeting(date: Date): string {
  const h = date.getHours();
  if (h >= 6 && h < 13) return "¡Buenos días!";
  if (h >= 13 && h < 21) return "¡Buenas tardes!";
  return "¡Buenas noches!";
}

/**
 * The reaction to an event, or null. Several things may be true at once (the first query of the day was also slow
 * and on a Friday): the first that applies wins, the rest wait for another query. Everything that is said is short,
 * never takes the focus and closes on its own.
 */
export function reactionFor(event: ReactionEvent, ctx: ReactionContext): Reaction | null {
  const now = ctx.now;
  switch (event.type) {
    case "query-ok": {
      const today = dayKey(now);
      if (ctx.lastQueryDay !== today && !ctx.said.has(`first:${today}`)) {
        return { id: "first-today", once: `first:${today}`, mood: "wave", ms: 1800, kind: "ok", text: `${greeting(now)} Primera consulta del día: a por ello.` };
      }
      if (event.ms >= LONG_RUN_MS) {
        return { id: "long-success", mood: "happy", ms: 2200, kind: "ok", text: `¡Por fin! ${ctx.formatMs(event.ms)}, pero ha salido bien.` };
      }
      if (event.empty) {
        return { id: "empty", mood: "think", ms: 2200, kind: "info", text: "Ni una fila. ¿Algún filtro demasiado estricto?", activity: "scratch" };
      }
      if (isFridayAfternoon(now) && !ctx.said.has(`friday:${today}`)) {
        return event.production
          ? { id: "friday", once: `friday:${today}`, mood: "think", ms: 2000, kind: "warn", text: "Viernes por la tarde y en producción: los cambios, mejor el lunes." }
          : { id: "friday", once: `friday:${today}`, mood: "happy", ms: 1800, kind: "ok", text: "¡Viernes por la tarde! Ya queda menos." };
      }
      if (isLate(now) && !ctx.said.has(`late:${nightKey(now)}`)) {
        return { id: "late", once: `late:${nightKey(now)}`, mood: "sleep", ms: 2400, kind: "info", text: "Es tarde. Lo que hagas ahora, revísalo mañana con calma." };
      }
      if (ctx.sessionMs >= LONG_SESSION_MS) {
        const block = Math.floor(ctx.sessionMs / LONG_SESSION_MS);
        if (!ctx.said.has(`session:${block}`)) {
          return { id: "long-session", once: `session:${block}`, mood: "wave", ms: 1800, kind: "info", text: `Llevas ${block * 2} horas seguidas. ¿Estiramos las piernas y un café?`, activity: "yawn" };
        }
      }
      return null;
    }
    case "query-error":
      if (event.streak >= 3) return { id: "error-streak", mood: "sad", ms: 2600, kind: "info", text: `${event.streak} errores seguidos. Respira: el mensaje completo está en «Salida».` };
      return { id: "error", mood: "error", ms: 2600 };
    case "export-done":
      if (event.rows >= BIG_EXPORT_ROWS || event.ms >= BIG_EXPORT_MS) {
        return { id: "export-done", mood: "happy", ms: 2200, kind: "ok", text: `Exportación lista: ${event.rows.toLocaleString("es-ES")} filas. ¡Menudo trabajo!` };
      }
      return { id: "export-done", mood: "ok", ms: 1600 };
    case "conn-lost":
      return { id: "conn-lost", mood: "sad", ms: 3000, kind: "warn", text: `Se ha cortado la conexión con «${event.name}».` };
    case "conn-back":
      return { id: "conn-back", mood: "wave", ms: 1800, kind: "ok", text: `«${event.name}» ha vuelto. ${ctx.name} respira tranquilo.` };
  }
}
