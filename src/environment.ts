// A connection's environment (Desarrollo, Pruebas, Preproducción, Producción or one of the user's own): the colour
// and the label every console, tab, explorer node and window on that connection wears, so that a production
// session never looks like a development one. Pure functions (dev/environment-check.ts).
//
// The production flag predates environments and still drives the confirmations, the MCP's write cap and the
// stricter transaction warnings: "prod" always sets it, the other built-in environments clear it, and a custom
// environment keeps the user's choice. Connections saved before environments existed keep their file as it was;
// on load the flag maps to "prod" (here and in src-tauri/src/model.rs, `normalize_environment`).
import { labelColorOn } from "./contrast.ts";

export type BuiltInEnv = "dev" | "test" | "staging" | "prod";
export type EnvId = "" | BuiltInEnv | "custom";

/** The built-in environments, safest first. Their colours are theme tokens (App.css: --env-*, --env-*-fg). */
export const ENVIRONMENTS: { id: BuiltInEnv; label: string; short: string; hint: string }[] = [
  { id: "dev", label: "Desarrollo", short: "DEV", hint: "Tu entorno de trabajo" },
  { id: "test", label: "Pruebas", short: "TEST", hint: "Datos de prueba compartidos" },
  { id: "staging", label: "Preproducción", short: "PRE", hint: "Copia de producción: ámbar" },
  { id: "prod", label: "Producción", short: "PROD", hint: "Rojo, confirma cambios peligrosos y avisa antes con las transacciones" },
];

/** A custom environment's colour when none was picked. */
export const CUSTOM_ENV_COLOR = "#8B949E";

/** Colours offered for a custom environment. */
export const ENV_SWATCHES = ["#E5534B", "#E8833A", "#D4A72C", "#57AB5A", "#2BA3A3", "#4A9BD9", "#986EE2", "#8B949E"];

export interface EnvConn {
  production: boolean;
  environment?: string;
  envLabel?: string;
  envColor?: string;
}

/** What a connection's environment looks like: label, short label, colour and label colour (CSS values). */
export interface EnvLook {
  id: Exclude<EnvId, "">;
  label: string;
  short: string;
  /** Fill of the strip, chip and dots: a theme token for the built-in environments, the user's hex for a custom one. */
  color: string;
  /** Text on that fill (4.5:1 at least). */
  fg: string;
  /** Production rules apply (confirmations, stricter transaction warnings). */
  production: boolean;
}

const isHex = (value: string | undefined): value is string => /^#[0-9a-f]{6}$/i.test(value ?? "");

/** The environment a connection is in, read the way the core reads it (an old production flag is "prod"). */
export function envIdOf(conn: EnvConn): EnvId {
  const id = conn.environment ?? "";
  if (id === "custom" || ENVIRONMENTS.some((env) => env.id === id)) return id as EnvId;
  return conn.production ? "prod" : "";
}

/** How a connection's environment is shown; null when it has none (the connection's own colour then). */
export function envOf(conn: EnvConn | undefined | null): EnvLook | null {
  if (!conn) return null;
  const id = envIdOf(conn);
  if (!id) return null;
  if (id === "custom") {
    const label = (conn.envLabel ?? "").trim() || "Personalizado";
    const color = isHex(conn.envColor) ? conn.envColor : CUSTOM_ENV_COLOR;
    return { id, label, short: shortLabel(label), color, fg: labelColorOn(color), production: conn.production };
  }
  const env = ENVIRONMENTS.find((item) => item.id === id)!;
  return { id, label: env.label, short: env.short, color: `var(--env-${id})`, fg: `var(--env-${id}-fg)`, production: id === "prod" };
}

/** A custom name as a chip label: up to 12 characters, in capitals like the built-in ones. */
export function shortLabel(label: string): string {
  const text = label.trim().toUpperCase();
  return text.length > 12 ? `${text.slice(0, 11)}…` : text;
}

/** The fields to set when the user picks an environment in the connection form. */
export function envPatch(id: EnvId, current: EnvConn): Required<Pick<EnvConn, "environment" | "production">> {
  if (id === "prod") return { environment: id, production: true };
  if (id === "custom") return { environment: id, production: current.environment === "custom" ? current.production : false };
  return { environment: id, production: false };
}

/** The environment and the production flag made to agree (as `ConnConfig::normalize_environment` in the core). */
export function normalizeEnvironment<T extends EnvConn>(conn: T): T {
  const id = conn.environment ?? "";
  if (!id && conn.production) return { ...conn, environment: "prod" };
  if (id === "prod" && !conn.production) return { ...conn, production: true };
  if ((id === "dev" || id === "test" || id === "staging") && conn.production) return { ...conn, production: false };
  return conn;
}

/** What the environment suggests in the connection form: read-only for production, the stricter warnings. */
export function envSuggestions(conn: EnvConn & { readOnly: boolean }): string[] {
  const look = envOf(conn);
  if (!look) return [];
  const out: string[] = [];
  if (look.production) out.push("Pide confirmación antes de UPDATE/DELETE sin WHERE, DROP, TRUNCATE y ALTER, y avisa antes de una transacción abierta mucho rato.");
  if ((look.production || look.id === "staging") && !conn.readOnly) out.push("¿Solo vas a consultar? Márcala de solo lectura: el núcleo rechaza cualquier sentencia que modifique datos.");
  return out;
}
