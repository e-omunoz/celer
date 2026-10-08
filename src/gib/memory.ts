// What Gib remembers between sessions (tips already shown, advice already given), in this computer's storage. Apart
// from the companion so that the palette ("Gib: volver a contar los consejos") can reset it.
const MEMORY_KEY = "celer.gib";
interface Memory {
  /** General tips already shown. */
  seen: string[];
  /** How many times each piece of advice was given. */
  advice: Record<string, number>;
}
export const memory: Memory = loadMemory();
/** Advice given in this session (warnings are not repeated within a session). */
export const sessionAdvice = new Set<string>();

function loadMemory(): Memory {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null") as { seen?: unknown; advice?: unknown } | null;
    const seen = raw?.seen;
    const advice = raw?.advice;
    return {
      seen: Array.isArray(seen) ? seen.filter((id): id is string => typeof id === "string") : [],
      advice: advice && typeof advice === "object" && !Array.isArray(advice) ? { ...(advice as Record<string, number>) } : {},
    };
  } catch {
    return { seen: [], advice: {} };
  }
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
