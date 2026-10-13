// The sections of Ajustes: what each one is called, the settings it shows (for the search box) and the keys
// «Restablecer sección» puts back. The dialog (src/components/settings/) draws each section with its own component,
// looked up by id: a new section is one entry here and one component there.
import { defaultSettings, type Settings } from "./types.ts";
import { normalizeGibPrefs } from "./gib/prefs.ts";
import { BUILTIN_THEMES, CUSTOM_PREFIX, readCustomThemes } from "./themes.ts";

/** The groups of the dialog's navigation, in order (#111). */
export const SETTINGS_GROUPS = ["General", "Editor", "Conexiones", "IA y MCP"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface SettingsSectionInfo {
  id: string;
  label: string;
  group: SettingsGroup;
  /** The labels of its settings, as the section shows them: the search box finds them. */
  items: string[];
  /** Settings «Restablecer sección» puts back to their defaults (none: the section has no such button). */
  keys: (keyof Settings)[];
  /** What a reset does not touch, told under the button. */
  resetNote?: string;
}

export const SETTINGS_SECTIONS: SettingsSectionInfo[] = [
  {
    id: "appearance",
    label: "Apariencia",
    group: "General",
    items: [
      "Tema",
      "Con el sistema en modo claro",
      "Con el sistema en modo oscuro",
      "Color de acento",
      "Densidad",
      "Tamaño de la interfaz",
      "Animaciones",
      "Gib",
      "Compañero (Gib)",
      "Nombre de Gib",
      "Accesorios de Gib",
      "Color de Gib",
    ],
    keys: ["theme", "systemLight", "systemDark", "accent", "density", "fontSize", "motion", "gib"],
    resetNote: "Tus temas propios no se borran.",
  },
  {
    id: "theme",
    label: "Editor de tema",
    group: "General",
    items: ["Editor de tema", "Temas propios", "Importar un tema", "Exportar un tema", "Contraste", "Fuente de la interfaz", "Radio de las esquinas", "Sombras", "Velocidad de las animaciones"],
    keys: [],
  },
  {
    id: "editor",
    label: "Editor",
    group: "Editor",
    items: [
      "Tamaño del editor",
      "Tipo de letra del editor",
      "Tamaño del tabulador",
      "Sangrar con espacios",
      "Ajuste de línea",
      "Números de línea",
      "Autocompletar al escribir",
      "Retardo del autocompletado",
      "Mayúsculas en palabras clave",
      "Pedir el valor de los parámetros",
    ],
    keys: ["editorFontSize", "editorFont", "tabSize", "indentSpaces", "wordWrap", "lineNumbers", "autocomplete", "autocompleteDelay", "keywordCase", "askParams"],
  },
  {
    id: "results",
    label: "Resultados",
    group: "Editor",
    items: ["Filas por página", "Filas alternas", "Texto de NULL", "Formato de fecha", "Formato de número", "Caracteres por celda", "Formato al copiar (Ctrl+C)"],
    keys: ["pageSize", "zebra", "nullText", "dateFormat", "numberFormat", "maxCellChars", "copyFormat"],
  },
  {
    id: "execution",
    label: "Ejecución",
    group: "Editor",
    items: ["Tiempo máximo de una consulta", "Tiempo de espera", "Timeout", "Modo de transacción de las consolas nuevas", "Auto-commit", "Commit automático"],
    keys: ["queryTimeout", "autocommitDefault"],
  },
  {
    id: "window",
    label: "Ventana y pestañas",
    group: "General",
    items: ["Restaurar la sesión al iniciar", "Abrir una tabla ya abierta", "Pestañas de tabla"],
    keys: ["restoreSession", "tableTabs"],
  },
  {
    id: "history",
    label: "Historial",
    group: "Editor",
    items: ["Consultas que se guardan", "Días que se guardan", "Vaciar historial"],
    keys: ["historyMax", "historyDays"],
  },
  {
    id: "notifications",
    label: "Avisos",
    group: "General",
    items: ["Duración de los avisos", "Notificación de escritorio", "Consultas largas"],
    keys: ["toastSeconds", "notifyAfter"],
  },
  { id: "templates", label: "Plantillas", group: "Editor", items: ["Plantillas de SQL", "Snippets"], keys: ["snippets"], resetNote: "Quita tus plantillas y deja las de serie." },
  { id: "keys", label: "Atajos de teclado", group: "Editor", items: ["Atajos de teclado", "Teclas"], keys: ["keymap"], resetNote: "Todos los atajos vuelven a los de serie." },
  {
    id: "safety",
    label: "Seguridad",
    group: "Conexiones",
    items: ["Confirmar UPDATE y DELETE sin WHERE", "Confirmar en producción", "Solo lectura", "Transacciones manuales", "Ámbar a partir de", "Rojo a partir de", "Producción: ámbar", "Producción: rojo", "Recordármelo al pasar a rojo"],
    keys: ["confirmNoWhere", "confirmMutations", "txWarnSecs", "txAlertSecs", "txProdWarnSecs", "txProdAlertSecs", "txRemind"],
  },
  { id: "ai", label: "IA y MCP", group: "IA y MCP", items: ["Clave de API", "Modelo", "Servidor MCP"], keys: ["aiModel"], resetNote: "Solo el modelo: la clave y el servidor MCP no cambian." },
  {
    id: "drivers",
    label: "Drivers",
    group: "Conexiones",
    items: ["Informix", "Java", "JDBC", "IBM CLI", "ODBC"],
    keys: ["ibmDriverPath", "javaPath", "informixJdbcPath"],
    resetNote: "Las rutas vuelven a buscarse solas; no se borra nada descargado.",
  },
];

/**
 * Settings no section resets: layout, explorer state and bookkeeping kept by the app itself, and the custom themes
 * (the theme editor saves and deletes them one by one; «Restablecer sección» never wipes them).
 */
export const INTERNAL_SETTINGS: (keyof Settings)[] = [
  "customThemes",
  "sidebarWidth",
  "inspectorWidth",
  "editorRatio",
  "onboarded",
  "checkUpdates",
  "skippedVersion",
  "connFolders",
  "collapsedFolders",
  "connSort",
  "favoriteConns",
  "recentConns",
];

/** Lower case without accents, for the search box. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface SettingsMatch {
  section: string;
  sectionLabel: string;
  label: string;
}

/** Settings whose label (or section name) holds every word typed, accents and case aside. */
export function searchSettings(query: string, sections: SettingsSectionInfo[] = SETTINGS_SECTIONS): SettingsMatch[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: SettingsMatch[] = [];
  for (const section of sections) {
    for (const label of section.items) {
      const hay = fold(`${label} ${section.label}`);
      if (words.every((word) => hay.includes(word))) out.push({ section: section.id, sectionLabel: section.label, label });
    }
  }
  return out;
}

/** The defaults of a section's settings, ready for saveSettings. */
export function resetPatch(section: SettingsSectionInfo): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const key of section.keys) patch[key] = JSON.parse(JSON.stringify(defaultSettings[key]));
  return patch as Partial<Settings>;
}

// ---------------------------------------------------------------- export / import

export const SETTINGS_FILE_FORMAT = "celer-settings";

/** Settings tied to this machine's connections or to this copy: not exported, and ignored on import. */
const NOT_PORTABLE = new Set<keyof Settings>(["favoriteConns", "recentConns", "collapsedFolders", "onboarded", "skippedVersion"]);

/** The settings as a JSON file another Celer can import. */
export function exportSettings(settings: Settings, appVersion: string, now = new Date()): string {
  const portable: Record<string, unknown> = {};
  for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
    if (!NOT_PORTABLE.has(key) && key in settings) portable[key] = settings[key];
  }
  return `${JSON.stringify({ format: SETTINGS_FILE_FORMAT, version: 1, app: appVersion, exportedAt: now.toISOString(), settings: portable }, null, 2)}\n`;
}

const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  density: ["compact", "comfortable"],
  motion: ["system", "reduce", "full"],
  connSort: ["manual", "alpha"],
  keywordCase: ["upper", "lower"],
  dateFormat: ["iso", "dmy"],
  numberFormat: ["plain", "grouped"],
  copyFormat: ["tsv", "tsv-head", "csv", "markdown", "json"],
  tableTabs: ["reuse", "new"],
};

/** Allowed range of the numeric settings (an imported value outside is brought inside). */
export const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  fontSize: [11, 18],
  editorFontSize: [10, 24],
  pageSize: [10, 100_000],
  tabSize: [1, 8],
  autocompleteDelay: [0, 2000],
  maxCellChars: [20, 10_000],
  queryTimeout: [0, 86_400],
  historyMax: [100, 100_000],
  historyDays: [0, 3650],
  toastSeconds: [2, 30],
  notifyAfter: [0, 3600],
  sidebarWidth: [200, 640],
  inspectorWidth: [200, 640],
  editorRatio: [0.1, 0.9],
};

/** A number brought into a setting's range (non-numbers give the default). */
export function clampSetting(key: keyof Settings, value: unknown): number {
  const range = RANGES[key];
  const fallback = defaultSettings[key] as number;
  const n = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  if (Number.isNaN(n)) return fallback;
  return range ? Math.min(range[1], Math.max(range[0], n)) : n;
}

/**
 * The settings of an exported file (or of a bare settings object), checked one by one: only known keys with the
 * right type and an allowed value; the rest is listed in `ignored`. Throws when the text is not a settings file.
 */
export function parseSettingsFile(text: string): { patch: Partial<Settings>; ignored: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("El fichero no es JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("El fichero no tiene ajustes de Celer");
  const wrapper = raw as Record<string, unknown>;
  const body = wrapper.format === SETTINGS_FILE_FORMAT ? wrapper.settings : raw;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("El fichero no tiene ajustes de Celer");
  return sanitizeSettings(body as Record<string, unknown>);
}

/**
 * A theme choice a settings file may carry: a built-in theme ("system" only for the theme itself) or one of the
 * custom themes it brings (null: any custom theme id, checked again when applied).
 */
function isThemeChoice(value: unknown, themes: { id: string }[] | undefined, builtinOnly: boolean): boolean {
  if (typeof value !== "string") return false;
  if (value === "system") return !builtinOnly;
  if (BUILTIN_THEMES.some((theme) => theme.id === value)) return true;
  if (!value.startsWith(CUSTOM_PREFIX)) return false;
  const id = value.slice(CUSTOM_PREFIX.length);
  return /^[\w-]{1,40}$/.test(id) && (!themes || themes.some((theme) => theme.id === id));
}

/** Known keys with a value of the right shape; everything else is reported, never applied. */
export function sanitizeSettings(body: Record<string, unknown>): { patch: Partial<Settings>; ignored: string[] } {
  const patch: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const k = key as keyof Settings;
    if (!(key in defaultSettings) || NOT_PORTABLE.has(k)) {
      ignored.push(key);
      continue;
    }
    const want = defaultSettings[k];
    const ok =
      Array.isArray(want) ? Array.isArray(value) : typeof want === "object" ? Boolean(value) && typeof value === "object" && !Array.isArray(value) : typeof value === typeof want;
    if (!ok || (ENUMS[k] && !ENUMS[k]!.includes(value as string))) {
      ignored.push(key);
      continue;
    }
    patch[key] = typeof want === "number" ? clampSetting(k, value) : value;
  }
  // Themes: a built-in one, "system", or a custom theme ("custom:<id>"). The custom themes are checked one by one;
  // when the file carries them, a choice of a custom theme that is not among them is dropped (one that no longer
  // exists falls back to Celer Oscuro / Claro when applied: themes.ts, resolveTheme).
  if (patch.customThemes) patch.customThemes = readCustomThemes(patch.customThemes);
  for (const key of ["theme", "systemLight", "systemDark"] as const) {
    if (!(key in patch)) continue;
    if (!isThemeChoice(patch[key], patch.customThemes as { id: string }[] | undefined, key !== "theme")) {
      delete patch[key];
      ignored.push(key);
    }
  }
  if (Array.isArray(patch.snippets)) {
    patch.snippets = (patch.snippets as unknown[]).filter(
      (s): s is { name: string; description: string; body: string } =>
        Boolean(s) && typeof s === "object" && typeof (s as { name?: unknown }).name === "string" && typeof (s as { body?: unknown }).body === "string",
    ).map((s) => ({ name: s.name, description: typeof s.description === "string" ? s.description : "", body: s.body }));
  }
  // Gib's preferences made valid; a file from before them may carry the old «Compañero» setting instead.
  if (patch.gib || "companion" in body) {
    patch.gib = normalizeGibPrefs(patch.gib, body.companion);
    const at = ignored.indexOf("companion");
    if (at >= 0) ignored.splice(at, 1);
  }
  if (patch.keymap) {
    const clean: Record<string, string[]> = {};
    for (const [id, chords] of Object.entries(patch.keymap as Record<string, unknown>)) {
      if (Array.isArray(chords) && chords.every((c) => typeof c === "string")) clean[id] = chords as string[];
    }
    patch.keymap = clean;
  }
  return { patch: patch as Partial<Settings>, ignored };
}
