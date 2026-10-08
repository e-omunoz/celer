// Keyboard shortcuts: the defaults (DataGrip-like), the user's changes (settings.keymap) and the helpers to match
// a key event, show a shortcut and hand the editor's ones to CodeMirror. A chord is written "Ctrl+Shift+Enter":
// modifiers in the order Ctrl, Alt, Shift, then one key (a letter or digit in upper case, "Enter", "F5", "+"…).
// Ctrl stands for Cmd on macOS.

/** Default shortcuts per command id (commands.ts). Several chords per command are allowed. */
export const DEFAULT_KEYS: Record<string, string[]> = {
  run: ["Ctrl+Enter"],
  "run-script": ["Ctrl+Shift+Enter", "Alt+X"],
  explain: ["Ctrl+Shift+E"],
  stop: ["Ctrl+F2"],
  format: ["Ctrl+Alt+L"],
  commit: ["Ctrl+Alt+Shift+C"],
  rollback: ["Ctrl+Alt+Shift+R"],
  "new-console": ["Ctrl+Shift+L"],
  "new-conn": ["Ctrl+Alt+N"],
  open: ["Ctrl+O"],
  save: ["Ctrl+S"],
  "save-as": ["Ctrl+Shift+S"],
  "save-library": ["Ctrl+Alt+B"],
  library: ["Alt+8"],
  "close-tab": ["Ctrl+W"],
  "next-tab": ["Ctrl+Tab"],
  "prev-tab": ["Ctrl+Shift+Tab"],
  "toggle-explorer": ["Alt+1"],
  "toggle-inspector": ["Alt+7"],
  palette: ["Ctrl+K"],
  "palette-actions": ["Ctrl+Shift+A"],
  "go-table": ["Ctrl+N"],
  history: ["Ctrl+Alt+E"],
  ai: ["Ctrl+Alt+I"],
  "reload-table": ["F5"],
  settings: ["Ctrl+Alt+S"],
  "font-up": ["Ctrl++", "Ctrl+="],
  "font-down": ["Ctrl+-"],
};

/** Commands bound inside the SQL editor (CodeMirror), not by the window: they act on the editor's text. */
export const EDITOR_COMMANDS = ["run", "run-script", "explain", "format"] as const;

/** Keys the editor keeps for itself (shown as taken when choosing a shortcut). */
export const EDITOR_RESERVED: Record<string, string> = {
  "Ctrl+Z": "Deshacer",
  "Ctrl+Y": "Borrar la línea",
  "Ctrl+Shift+Z": "Rehacer",
  "Ctrl+A": "Seleccionar todo",
  "Ctrl+C": "Copiar",
  "Ctrl+V": "Pegar",
  "Ctrl+X": "Cortar",
  "Ctrl+F": "Buscar",
  "Ctrl+G": "Siguiente coincidencia",
  "Ctrl+Shift+G": "Coincidencia anterior",
  "Ctrl+Alt+G": "Ir a la línea",
  F3: "Siguiente coincidencia",
  "Ctrl+H": "Reemplazar",
  "Ctrl+D": "Duplicar la línea",
  "Ctrl+B": "Ir a la tabla bajo el cursor",
  "Ctrl+/": "Comentar",
  "Ctrl+I": "Seleccionar el bloque",
  "Ctrl+U": "Deshacer la selección",
  "Ctrl+[": "Quitar sangría",
  "Ctrl+]": "Sangrar",
  "Ctrl+Shift+K": "Borrar la línea",
  "Alt+ArrowUp": "Subir la línea",
  "Alt+ArrowDown": "Bajar la línea",
  "Ctrl+Shift+ArrowUp": "Subir la línea",
  "Ctrl+Shift+ArrowDown": "Bajar la línea",
  "Ctrl+Space": "Autocompletar",
  F4: "Ir a la tabla bajo el cursor",
};

/** Keys the editor keeps even over the user's shortcuts (the completion list is above everything). */
export const EDITOR_ALWAYS = new Set(["Ctrl+Space"]);

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock", "OS", "Dead", "Unidentified", "Process"]);

/**
 * Whether the AltGr key (right Alt) is held: on Windows it reports Ctrl+Alt, so Ctrl+Alt+E typed with the left
 * keys is a shortcut but AltGr+E is "€". null until trackAltGr() runs (then the event alone decides).
 */
let altGrDown: boolean | null = null;

export function setAltGrDown(down: boolean | null) {
  altGrDown = down;
}

/** Follows the right Alt key on `target`; returns the function that stops it. */
export function trackAltGr(target: Window): () => void {
  altGrDown = false;
  const isRightAlt = (event: KeyboardEvent) => event.key === "AltGraph" || (event.key === "Alt" && event.location === 2);
  const down = (event: KeyboardEvent) => {
    if (isRightAlt(event)) altGrDown = true;
  };
  const up = (event: KeyboardEvent) => {
    if (isRightAlt(event)) altGrDown = false;
  };
  const reset = () => (altGrDown = false);
  target.addEventListener("keydown", down, true);
  target.addEventListener("keyup", up, true);
  target.addEventListener("blur", reset);
  return () => {
    target.removeEventListener("keydown", down, true);
    target.removeEventListener("keyup", up, true);
    target.removeEventListener("blur", reset);
    altGrDown = null;
  };
}

/**
 * The chord of a key event, or null for a lone modifier or a character typed with AltGr (Ctrl+Alt on Windows:
 * AltGr+E is "€", not a shortcut).
 */
export function chordOf(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { getModifierState?: (key: string) => boolean }): string | null {
  const { key, code } = event;
  if (!key || MODIFIER_KEYS.has(key)) return null;
  // AltGr held: a character is being typed (€, @, #…), not a shortcut.
  if (altGrDown === true) return null;
  if (altGrDown === null && event.getModifierState?.("AltGraph")) return null;
  const ctrl = event.ctrlKey || event.metaKey;
  let name: string;
  let shiftCounts = true;
  if (/^[a-z]$/i.test(key)) name = key.toUpperCase();
  else if (/^[0-9]$/.test(key)) name = key;
  else if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)) {
    // A letter or digit key giving something else: Shift+1 is "!" (still "1"), another alphabet uses its
    // position, and Ctrl+Alt+E is "€" on a Spanish keyboard (a shortcut when AltGr is known not to be held).
    if (altGrDown === null && ctrl && event.altKey && key.length === 1 && !/\p{L}/u.test(key)) return null;
    name = code.slice(-1);
  } else if (key === " ") name = "Space";
  else if (key.length === 1 && /\p{L}/u.test(key)) {
    // A letter of its own key (ñ, ç): always in lower case, Shift is a modifier like for a–z.
    name = key.toLowerCase();
  } else if (key.length === 1) {
    // Symbols: the Shift that produces them is part of the character ("+" on a US keyboard is Shift+=).
    name = key;
    shiftCounts = false;
  } else name = key === "Esc" ? "Escape" : key;
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey && shiftCounts) parts.push("Shift");
  parts.push(name);
  return parts.join("+");
}

/** Normalizes a chord written by hand or stored by an older version ("ctrl+shift+e" → "Ctrl+Shift+E"). */
export function normalizeChord(chord: string): string {
  const raw = chord.trim();
  // The key may itself be "+" ("Ctrl++").
  const plusKey = raw.endsWith("++") || raw === "+";
  const pieces = (plusKey ? raw.slice(0, -1) : raw).split("+").filter(Boolean);
  const key = plusKey ? "+" : (pieces.pop() ?? "");
  const mods = new Set(pieces.map((m) => m.toLowerCase()));
  const parts: string[] = [];
  if (mods.has("ctrl") || mods.has("cmd") || mods.has("mod") || mods.has("meta")) parts.push("Ctrl");
  if (mods.has("alt") || mods.has("option")) parts.push("Alt");
  if (mods.has("shift") || mods.has("mayús") || mods.has("mayus")) parts.push("Shift");
  // a–z in upper case; other letters (ñ, ç) in lower case, as chordOf writes them; symbols as they are.
  const k = key.length === 1 ? (/^[a-z]$/i.test(key) ? key.toUpperCase() : key.toLowerCase()) : key.replace(/^(intro|return)$/i, "Enter").replace(/^esc$/i, "Escape").replace(/^(space|espacio)$/i, "Space").replace(/^f(\d+)$/i, "F$1");
  parts.push(k.length > 1 ? k[0].toUpperCase() + k.slice(1) : k);
  return parts.join("+");
}

/** "Ctrl+ñ" as shown: letters in upper case ("Ctrl+Ñ"). */
function keyLabel(part: string): string {
  return part.length === 1 && part.toUpperCase().length === 1 ? part.toUpperCase() : part;
}

/** The shortcuts of a command: the user's choice (an empty list removes them) or the default. */
export function chordsFor(id: string, user: Record<string, string[]> | undefined): string[] {
  const own = user?.[id];
  return own ? own.map(normalizeChord) : (DEFAULT_KEYS[id] ?? []);
}

const KEY_LABELS: Record<string, string> = {
  Enter: "Intro",
  Shift: "Mayús",
  Space: "Espacio",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Delete: "Supr",
  Insert: "Insert",
  Backspace: "Retroceso",
  PageUp: "RePág",
  PageDown: "AvPág",
  Home: "Inicio",
  End: "Fin",
  Tab: "Tab",
};

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The keys of a chord as shown to the user: ["Ctrl", "Mayús", "Intro"] (⌘ for Ctrl on macOS). */
export function chordParts(chord: string): string[] {
  const plusKey = chord.endsWith("++") || chord === "+";
  const pieces = (plusKey ? chord.slice(0, -1) : chord).split("+").filter(Boolean);
  if (plusKey) pieces.push("+");
  return pieces.map((p) => (p === "Ctrl" && MAC ? "⌘" : KEY_LABELS[p] ?? keyLabel(p)));
}

export function chordLabel(chord: string): string {
  return chordParts(chord).join("+");
}

/** "Ctrl+Shift+Enter" → "Mod-Shift-Enter" (CodeMirror's notation; letters in lower case). */
export function codeMirrorKey(chord: string): string {
  const plusKey = chord.endsWith("++") || chord === "+";
  const pieces = (plusKey ? chord.slice(0, -1) : chord).split("+").filter(Boolean);
  const key = plusKey ? "+" : pieces.pop()!;
  const mods = pieces.map((m) => (m === "Ctrl" ? "Mod" : m));
  const cmKey = key.length === 1 ? key.toLowerCase() : key;
  return [...mods, cmKey].join("-");
}
