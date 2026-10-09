// Custom themes (Ajustes › Apariencia › Editor de tema): a built-in theme as the base plus the tokens the user
// changed, fonts, radius, row height, shadows and animation speed. A theme is applied as inline custom properties
// on <html> over its base's `data-theme` (state.ts, applyTheme), so every component that reads the tokens follows
// it, tear-off windows included (the settings are shared). Pure logic: no DOM here (dev/themes-check.ts).

export type BuiltinTheme = "dark" | "light" | "darcula" | "fjord" | "sand" | "contrast" | "contrast-light";

export const BUILTIN_THEMES: { id: BuiltinTheme; label: string; light: boolean }[] = [
  { id: "dark", label: "Celer Oscuro", light: false },
  { id: "light", label: "Celer Claro", light: true },
  { id: "darcula", label: "Darcula", light: false },
  { id: "fjord", label: "Fjord", light: false },
  { id: "sand", label: "Sand", light: true },
  { id: "contrast", label: "Alto contraste oscuro", light: false },
  { id: "contrast-light", label: "Alto contraste claro", light: true },
];

/** A custom theme's id in `settings.theme` (and in the system light/dark choices): "custom:<id>". */
export const CUSTOM_PREFIX = "custom:";

export type ShadowLevel = "base" | "none" | "soft" | "strong";

export interface CustomTheme {
  id: string;
  name: string;
  base: BuiltinTheme;
  /** Token → CSS colour, only the ones that differ from the base. */
  colors: Record<string, string>;
  /** Interface font family ("" keeps the base's). */
  uiFont: string;
  /** Editor and grid font family ("" keeps the base's). */
  editorFont: string;
  /** Corner radius of panels and controls in px (--radius-md; the others follow), null keeps the base's. */
  radius: number | null;
  /** Height of rows (explorer, grid) in px, null follows Ajustes › Densidad. */
  rowHeight: number | null;
  shadow: ShadowLevel;
  /** Animation durations are multiplied by this (0.5 quicker … 2 slower). */
  motionScale: number;
}

export interface TokenInfo {
  name: string;
  label: string;
}

export interface TokenGroup {
  id: string;
  label: string;
  tokens: TokenInfo[];
}

/** Every token the editor offers, grouped as the editor shows them. */
export const TOKEN_GROUPS: TokenGroup[] = [
  {
    id: "surfaces",
    label: "Superficies",
    tokens: [
      { name: "--bg", label: "Fondo de la ventana" },
      { name: "--panel", label: "Paneles (explorador, pestañas)" },
      { name: "--surface", label: "Superficie (editor, resultados)" },
      { name: "--surface-alt", label: "Superficie alterna (barras)" },
      { name: "--popover", label: "Menús, diálogos y avisos" },
      { name: "--hover", label: "Al pasar el ratón" },
      { name: "--active", label: "Elemento activo" },
      { name: "--scrim", label: "Velo detrás de los diálogos" },
    ],
  },
  {
    id: "text",
    label: "Texto",
    tokens: [
      { name: "--text", label: "Texto" },
      { name: "--text-muted", label: "Texto secundario" },
      { name: "--text-faint", label: "Texto tenue (pistas, contadores)" },
    ],
  },
  {
    id: "borders",
    label: "Bordes",
    tokens: [
      { name: "--border", label: "Borde" },
      { name: "--border-strong", label: "Borde marcado (campos, botones)" },
      { name: "--focus-ring", label: "Anillo de foco" },
    ],
  },
  {
    id: "accent",
    label: "Acento",
    tokens: [
      { name: "--accent", label: "Acento" },
      { name: "--accent-fg", label: "Texto sobre el acento" },
      { name: "--accent-soft", label: "Acento suave (fondos)" },
      { name: "--accent-text", label: "Texto en color de acento" },
      { name: "--selection", label: "Selección" },
    ],
  },
  {
    id: "states",
    label: "Estados",
    tokens: [
      { name: "--success", label: "Correcto" },
      { name: "--warning", label: "Aviso" },
      { name: "--danger", label: "Peligro / error" },
      { name: "--danger-fg", label: "Texto sobre peligro" },
      { name: "--info", label: "Información" },
      { name: "--run", label: "Botón Ejecutar" },
      { name: "--run-fg", label: "Texto del botón Ejecutar" },
    ],
  },
  {
    id: "grid",
    label: "Tabla de resultados",
    tokens: [
      { name: "--grid-head", label: "Cabecera" },
      { name: "--grid-line", label: "Líneas" },
      { name: "--grid-alt", label: "Filas alternas" },
      { name: "--grid-sel", label: "Selección" },
      { name: "--grid-number", label: "Números" },
      { name: "--grid-modified", label: "Celda cambiada" },
      { name: "--grid-inserted", label: "Fila nueva" },
      { name: "--grid-deleted", label: "Fila borrada" },
      { name: "--grid-match", label: "Coincidencia de búsqueda" },
    ],
  },
  {
    id: "syntax",
    label: "Editor y sintaxis",
    tokens: [
      { name: "--editor-bg", label: "Fondo del editor" },
      { name: "--editor-selection", label: "Selección en el editor" },
      { name: "--editor-stmt", label: "Sentencia actual" },
      { name: "--syntax-keyword", label: "Palabras clave" },
      { name: "--syntax-function", label: "Funciones" },
      { name: "--syntax-type", label: "Tipos" },
      { name: "--syntax-string", label: "Cadenas" },
      { name: "--syntax-number", label: "Números" },
      { name: "--syntax-comment", label: "Comentarios" },
      { name: "--syntax-table", label: "Tablas" },
      { name: "--syntax-param", label: "Parámetros" },
      { name: "--syntax-punct", label: "Puntuación" },
    ],
  },
  {
    id: "objects",
    label: "Explorador",
    tokens: [
      { name: "--obj-db", label: "Bases de datos" },
      { name: "--obj-schema", label: "Esquemas" },
      { name: "--obj-table", label: "Tablas" },
      { name: "--obj-view", label: "Vistas" },
      { name: "--obj-column", label: "Columnas" },
      { name: "--obj-routine", label: "Rutinas" },
      { name: "--obj-key", label: "Claves" },
      { name: "--obj-index", label: "Índices" },
      { name: "--obj-trigger", label: "Disparadores" },
      { name: "--obj-sequence", label: "Secuencias" },
    ],
  },
  {
    id: "gib",
    label: "Gib",
    tokens: [
      { name: "--gib-fur", label: "Pelo" },
      { name: "--gib-fur-shade", label: "Sombra del pelo y cejas" },
      { name: "--gib-blush", label: "Mejillas" },
      { name: "--gib-tie", label: "Corbata" },
    ],
  },
];

export const ALL_TOKENS = new Set(TOKEN_GROUPS.flatMap((group) => group.tokens.map((token) => token.name)));

/**
 * Text/background pairs the contrast checker measures: `min` is what WCAG AA asks (4.5 text, 3 large text and
 * shapes). `under` is the opaque surface a translucent background sits on.
 */
export const CONTRAST_PAIRS: { fg: string; bg: string; label: string; min: number; under?: string }[] = [
  { fg: "--text", bg: "--bg", label: "Texto sobre el fondo", min: 4.5 },
  { fg: "--text", bg: "--surface", label: "Texto sobre la superficie", min: 4.5 },
  { fg: "--text", bg: "--popover", label: "Texto en menús y diálogos", min: 4.5 },
  { fg: "--text-muted", bg: "--panel", label: "Texto secundario en paneles", min: 4.5 },
  { fg: "--text-muted", bg: "--surface", label: "Texto secundario en la superficie", min: 4.5 },
  { fg: "--text-faint", bg: "--panel", label: "Texto tenue en paneles", min: 4.5 },
  { fg: "--text-faint", bg: "--surface", label: "Texto tenue en la superficie", min: 4.5 },
  { fg: "--accent-fg", bg: "--accent", label: "Botón principal", min: 4.5 },
  { fg: "--accent-text", bg: "--surface", label: "Enlaces y texto de acento", min: 4.5 },
  { fg: "--run-fg", bg: "--run", label: "Botón Ejecutar", min: 4.5 },
  { fg: "--danger-fg", bg: "--danger", label: "Botón de peligro", min: 4.5 },
  { fg: "--danger", bg: "--surface", label: "Errores", min: 4.5 },
  { fg: "--success", bg: "--surface", label: "Mensajes correctos", min: 3 },
  { fg: "--warning", bg: "--surface", label: "Avisos", min: 3 },
  { fg: "--text", bg: "--grid-sel", label: "Texto en la selección de la tabla", min: 4.5, under: "--surface" },
  { fg: "--grid-number", bg: "--surface", label: "Números en la tabla", min: 4.5 },
  { fg: "--syntax-keyword", bg: "--editor-bg", label: "Palabras clave", min: 4.5 },
  { fg: "--syntax-string", bg: "--editor-bg", label: "Cadenas", min: 4.5 },
  { fg: "--syntax-comment", bg: "--editor-bg", label: "Comentarios", min: 3 },
  { fg: "--border-strong", bg: "--surface", label: "Borde de los campos", min: 1.5 },
];

export const FONT_STACK_UI = '"Inter", "Segoe UI Variable", system-ui, sans-serif';
export const FONT_STACK_MONO = '"JetBrains Mono", ui-monospace, Consolas, monospace';

/** Fonts offered in the editor's lists (any installed font can be typed in). */
export const UI_FONTS = ["Inter", "Segoe UI Variable", "Segoe UI", "Source Serif 4", "Arial", "Verdana", "Tahoma", "Georgia"];
export const EDITOR_FONTS = ["JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Consolas", "Fira Code", "Source Code Pro", "Courier New"];

export const SHADOWS: { id: ShadowLevel; label: string }[] = [
  { id: "base", label: "Las del tema base" },
  { id: "none", label: "Sin sombras" },
  { id: "soft", label: "Suaves" },
  { id: "strong", label: "Marcadas" },
];

export const MOTION_SPEEDS: { value: number; label: string }[] = [
  { value: 0.5, label: "Muy rápidas" },
  { value: 0.75, label: "Rápidas" },
  { value: 1, label: "Normales" },
  { value: 1.5, label: "Pausadas" },
  { value: 2, label: "Lentas" },
];

export const RADIUS_RANGE = { min: 0, max: 16 } as const;
export const ROW_RANGE = { min: 20, max: 34 } as const;

/** A theme like `base`, nothing changed yet. */
export function blankTheme(id: string, name: string, base: BuiltinTheme): CustomTheme {
  return { id, name, base, colors: {}, uiFont: "", editorFont: "", radius: null, rowHeight: null, shadow: "base", motionScale: 1 };
}

export function newThemeId(now = Date.now(), random = Math.random()): string {
  return `t${now.toString(36)}${Math.floor(random * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** `name`, or `name (2)`, `name (3)`… so that no two themes share a name (case aside). */
export function uniqueThemeName(name: string, taken: string[]): string {
  const used = new Set(taken.map((item) => item.trim().toLowerCase()));
  const clean = name.trim() || "Tema";
  if (!used.has(clean.toLowerCase())) return clean;
  const stem = clean.replace(/\s\(\d+\)$/, "");
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** A copy of `theme` with a new id and a free name ("… (copia)"). */
export function duplicateTheme(theme: CustomTheme, id: string, taken: string[]): CustomTheme {
  return { ...theme, id, colors: { ...theme.colors }, name: uniqueThemeName(`${theme.name} (copia)`, taken) };
}

/**
 * A colour a theme may set: hex, rgb()/rgba(), hsl()/hsla(), color-mix() of those and var(), or a CSS colour name.
 * Never anything that loads something (url(), image-set()…) or breaks out of the declaration.
 */
export function isSafeColor(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 160) return false;
  if (!/^[#a-zA-Z0-9\s(),.%/+-]+$/.test(text)) return false;
  if (/url|image|expression|attr|env\(/i.test(text)) return false;
  const fns = [...text.matchAll(/([a-zA-Z-]+)\(/g)].map((m) => m[1].toLowerCase());
  const allowed = new Set(["rgb", "rgba", "hsl", "hsla", "color-mix", "var", "color", "oklch", "oklab", "lab", "lch", "hwb"]);
  if (fns.some((fn) => !allowed.has(fn))) return false;
  if (/var\(/i.test(text) && ![...text.matchAll(/var\(\s*([^)\s,]+)/gi)].every((m) => /^--[\w-]+$/.test(m[1]))) return false;
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** A font family name a theme may set (letters, digits, spaces and a few signs; quotes are added when applied). */
export function isSafeFont(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && text.length <= 80 && /^[\p{L}\p{N} _.-]+$/u.test(text);
}

const clampNumber = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null;

/** A theme read from settings.json or from a file, with every field checked; null when it is not one. */
export function sanitizeTheme(value: unknown, id?: string): CustomTheme | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const base = BUILTIN_THEMES.some((item) => item.id === raw.base) ? (raw.base as BuiltinTheme) : null;
  if (!base) return null;
  const colors: Record<string, string> = {};
  if (raw.colors && typeof raw.colors === "object") {
    for (const [name, color] of Object.entries(raw.colors as Record<string, unknown>)) {
      if (ALL_TOKENS.has(name) && typeof color === "string" && isSafeColor(color)) colors[name] = color.trim();
    }
  }
  const fonts = (raw.fonts && typeof raw.fonts === "object" ? raw.fonts : raw) as Record<string, unknown>;
  const font = (v: unknown) => (typeof v === "string" && isSafeFont(v) ? v.trim() : "");
  const shadow = SHADOWS.some((item) => item.id === raw.shadow) ? (raw.shadow as ShadowLevel) : "base";
  const speed = typeof raw.motionScale === "number" && Number.isFinite(raw.motionScale) ? Math.min(2, Math.max(0.5, raw.motionScale)) : 1;
  const themeId = id ?? (typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : "");
  if (!themeId) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : "Tema sin nombre";
  return {
    id: themeId,
    name,
    base,
    colors,
    uiFont: font(fonts.uiFont ?? fonts.ui),
    editorFont: font(fonts.editorFont ?? fonts.editor),
    radius: clampNumber(raw.radius, RADIUS_RANGE.min, RADIUS_RANGE.max),
    rowHeight: clampNumber(raw.rowHeight, ROW_RANGE.min, ROW_RANGE.max),
    shadow,
    motionScale: speed,
  };
}

/** The themes kept in settings.json, the damaged ones left out. */
export function readCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CustomTheme[] = [];
  for (const item of value) {
    const theme = sanitizeTheme(item);
    if (theme && !seen.has(theme.id)) {
      seen.add(theme.id);
      out.push(theme);
    }
  }
  return out;
}

const FILE_KIND = "celer-theme";

/** The JSON file a theme is exported as (shareable: no id, the importer gives it a new one). */
export function exportThemeJson(theme: CustomTheme): string {
  const file = {
    kind: FILE_KIND,
    version: 1,
    name: theme.name,
    base: theme.base,
    colors: Object.fromEntries(Object.entries(theme.colors).sort(([a], [b]) => a.localeCompare(b))),
    fonts: { ui: theme.uiFont, editor: theme.editorFont },
    radius: theme.radius,
    rowHeight: theme.rowHeight,
    shadow: theme.shadow,
    motionScale: theme.motionScale,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A theme from an exported file, with a new id and a name no other theme has. Throws with the reason. */
export function importThemeJson(text: string, id: string, taken: string[]): CustomTheme {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("El fichero no es JSON válido");
  }
  if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== FILE_KIND) throw new Error("El fichero no es un tema de Celer");
  const version = (raw as { version?: unknown }).version;
  if (typeof version === "number" && version > 1) throw new Error("El tema se hizo con una versión más nueva de Celer");
  const theme = sanitizeTheme(raw, id);
  if (!theme) throw new Error("El tema no indica un tema base válido");
  return { ...theme, name: uniqueThemeName(theme.name, taken) };
}

const SHADOW_VALUES: Record<Exclude<ShadowLevel, "base">, { md: string; lg: string }> = {
  none: { md: "none", lg: "none" },
  soft: { md: "0 4px 12px rgb(0 0 0 / 0.14)", lg: "0 10px 28px rgb(0 0 0 / 0.2), 0 1px 3px rgb(0 0 0 / 0.12)" },
  strong: { md: "0 10px 30px rgb(0 0 0 / 0.5)", lg: "0 24px 64px rgb(0 0 0 / 0.6), 0 2px 8px rgb(0 0 0 / 0.4)" },
};

const quoted = (font: string) => `"${font.replace(/["\\]/g, "")}"`;

/**
 * The custom properties a theme sets on <html>, over its base theme: its colours, then what its fonts, radius,
 * row height, shadows and speed come to. `accent` is the user's accent (Ajustes) when the theme sets none.
 */
export function themeVars(theme: CustomTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, color] of Object.entries(theme.colors)) if (ALL_TOKENS.has(name) && isSafeColor(color)) vars[name] = color;
  if (theme.uiFont && isSafeFont(theme.uiFont)) vars["--sans"] = `${quoted(theme.uiFont)}, ${FONT_STACK_UI}`;
  if (theme.editorFont && isSafeFont(theme.editorFont)) vars["--mono"] = `${quoted(theme.editorFont)}, ${FONT_STACK_MONO}`;
  if (theme.radius !== null) Object.assign(vars, radiusVars(theme.radius));
  if (theme.rowHeight !== null) {
    vars["--row-h"] = `${theme.rowHeight}px`;
    vars["--bar-h"] = `${theme.rowHeight + 14}px`;
  }
  if (theme.shadow !== "base") {
    vars["--shadow-md"] = SHADOW_VALUES[theme.shadow].md;
    vars["--shadow-lg"] = SHADOW_VALUES[theme.shadow].lg;
  }
  if (theme.motionScale !== 1) vars["--motion-scale"] = String(theme.motionScale);
  return vars;
}

/** The radius tokens for a main radius (--radius-md): the small and large ones keep their proportion. */
export function radiusVars(md: number): Record<string, string> {
  const px = (n: number) => `${Math.round(n)}px`;
  return { "--radius-xs": px(md * 0.5), "--radius-sm": px(md * 0.65), "--radius-md": px(md), "--radius-lg": px(md * 1.5), "--radius-xl": px(md * 1.75) };
}

/** Every property themeVars() may set: they are cleared before another theme is applied. */
export const THEME_PROPERTIES = [...ALL_TOKENS, "--sans", "--mono", "--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--row-h", "--bar-h", "--shadow-md", "--shadow-lg", "--motion-scale"];

/**
 * What a theme choice comes to: "system" takes the theme chosen for the system's light or dark mode, a custom
 * theme brings its base, and one that no longer exists falls back to Celer Oscuro / Claro.
 */
export function resolveTheme(
  choice: string,
  options: { systemDark: boolean; lightChoice: string; darkChoice: string; themes: CustomTheme[] },
): { base: BuiltinTheme; custom: CustomTheme | null; id: string } {
  let id = choice;
  if (id === "system") id = options.systemDark ? options.darkChoice : options.lightChoice;
  if (id === "system") id = options.systemDark ? "dark" : "light";
  if (id.startsWith(CUSTOM_PREFIX)) {
    const custom = options.themes.find((theme) => `${CUSTOM_PREFIX}${theme.id}` === id);
    if (custom) return { base: custom.base, custom, id };
    id = options.systemDark ? "dark" : "light";
  }
  const builtin = BUILTIN_THEMES.find((theme) => theme.id === id);
  return { base: builtin?.id ?? "dark", custom: null, id: builtin?.id ?? "dark" };
}

export function isLightBase(base: BuiltinTheme): boolean {
  return BUILTIN_THEMES.find((theme) => theme.id === base)?.light ?? false;
}

/** The colours of a theme that changed against what the editor read for its base (to keep only the overrides). */
export function changedColors(edited: Record<string, string>, base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(edited)) {
    if (ALL_TOKENS.has(name) && value.trim() && value.trim().toLowerCase() !== (base[name] ?? "").trim().toLowerCase()) out[name] = value.trim();
  }
  return out;
}
