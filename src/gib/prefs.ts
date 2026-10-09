// Gib as the user made him (Settings › Apariencia › Gib): colour, accessories, name and the companion's pose. Pure, so
// dev/gib-advice-check.ts can test it without the app; the app puts the look on the document root (state.ts,
// applyTheme) and every Gib picks it up from there through CSS (App.css, "Gib: personalisation").

export type GibPose = "poker" | "laptop" | "monday" | "icon";
export const GIB_ACCESSORIES = ["cap", "glasses", "headphones", "scarf"] as const;
export type GibAccessory = (typeof GIB_ACCESSORIES)[number];
/** Poses the companion can wear while idle (in the order the settings offer them). */
export const COMPANION_POSES: GibPose[] = ["poker", "monday", "icon", "laptop"];
export const DEFAULT_GIB_NAME = "Gib";
export const GIB_NAME_MAX = 20;

export interface GibLook {
  /** "classic" (black tie, accessories in the accent colour), "accent" (all in the accent colour) or a #rrggbb colour. */
  color: string;
  accessories: GibAccessory[];
  /** How he is called in his messages. */
  name: string;
  /** The companion's pose while nothing is going on. */
  pose: GibPose;
}

export const defaultGibLook: GibLook = { color: "classic", accessories: [], name: DEFAULT_GIB_NAME, pose: "poker" };

const HEX = /^#[0-9a-f]{6}$/i;

/** Whatever was stored (missing, old, edited by hand) as a valid look. */
export function normalizeGibLook(raw: unknown): GibLook {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const color = typeof value.color === "string" && (value.color === "classic" || value.color === "accent" || HEX.test(value.color)) ? value.color.toLowerCase() : defaultGibLook.color;
  const accessories = Array.isArray(value.accessories)
    ? GIB_ACCESSORIES.filter((name) => (value.accessories as unknown[]).includes(name))
    : [];
  const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim().slice(0, GIB_NAME_MAX) : "";
  const pose = COMPANION_POSES.includes(value.pose as GibPose) ? (value.pose as GibPose) : defaultGibLook.pose;
  return { color, accessories, name: name || DEFAULT_GIB_NAME, pose };
}

/** His name for messages: what the user typed, or «Gib». */
export function gibDisplayName(look: Pick<GibLook, "name"> | undefined): string {
  const name = (look?.name ?? "").replace(/\s+/g, " ").trim().slice(0, GIB_NAME_MAX);
  return name || DEFAULT_GIB_NAME;
}

/** The CSS colour of his tie and accessories, or null for the classic look (black tie). */
export function gibTint(color: string): string | null {
  if (color === "accent") return "var(--accent)";
  return HEX.test(color) ? color : null;
}
