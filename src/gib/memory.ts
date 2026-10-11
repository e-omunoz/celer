// What Gib remembers between sessions (tips already shown, advice already given), in this computer's storage. Apart
// from the companion so that the palette ("Gib: volver a contar los consejos") can reset it.
const MEMORY_KEY = "celer.gib";
interface Memory {
  /** General tips already shown. */
  seen: string[];
  /** How many times each piece of advice was given. */
  advice: Record<string, number>;
  /** The day of the last query ("2026-10-09"), for "first query of the day". */
  lastQueryDay: string;
  /** Reactions said once a day / night (reactions.ts, `once`), newest last. */
  said: string[];
}
export const memory: Memory = loadMemory();
/** Advice given in this session (warnings are not repeated within a session). */
export const sessionAdvice = new Set<string>();

function loadMemory(): Memory {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null") as { seen?: unknown; advice?: unknown; lastQueryDay?: unknown; said?: unknown } | null;
    const seen = raw?.seen;
    const advice = raw?.advice;
    return {
      seen: Array.isArray(seen) ? seen.filter((id): id is string => typeof id === "string") : [],
      advice: advice && typeof advice === "object" && !Array.isArray(advice) ? { ...(advice as Record<string, number>) } : {},
      lastQueryDay: typeof raw?.lastQueryDay === "string" ? raw.lastQueryDay : "",
      said: Array.isArray(raw?.said) ? raw.said.filter((id): id is string => typeof id === "string").slice(-40) : [],
    };
  } catch {
    return { seen: [], advice: {}, lastQueryDay: "", said: [] };
  }
}

// Gib lives in one window at a time and that window writes his memory; when he moves to another window, or the
// palette of another window resets it, the others read it again (the storage is the same for every window).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== MEMORY_KEY) return;
    const fresh = loadMemory();
    memory.seen = fresh.seen;
    memory.advice = fresh.advice;
    memory.lastQueryDay = fresh.lastQueryDay;
    memory.said = fresh.said;
  });
}

export function saveMemory() {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Storage unavailable: he just forgets.
  }
}

/** "Gib: volver a contar los consejos": every tip and piece of advice counts as new again. */
export function resetGibTips() {
  memory.seen = [];
  memory.advice = {};
  sessionAdvice.clear();
  saveMemory();
}
