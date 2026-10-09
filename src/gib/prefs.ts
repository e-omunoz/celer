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

// ---------------------------------------------------------------- presence (#104)

export type GibFrequency = "rare" | "normal" | "often";
/** Where Gib may appear: the status bar companion, empty states (and the AI panel), the start-up splash, overlays and dialogs. */
export const GIB_PLACES = ["companion", "empty", "splash", "overlays"] as const;
export type GibPlace = (typeof GIB_PLACES)[number];

export interface GibPrefs extends GibLook {
  /** Gib at all: off, he appears nowhere and reacts to nothing. */
  on: boolean;
  /** How often he speaks up and plays (reactions per hour, gap between idle activities: reactions.ts). */
  frequency: GibFrequency;
  /** Reacts to what happens (queries, errors, exports, connections, the time of day). */
  reactions: boolean;
  /** Plays on his own when you are idle. */
  idle: boolean;
  /** Volunteers tips (a click on him still gives one; warnings about a statement are always given). */
  tips: boolean;
  /** His eyes follow the cursor. */
  eyes: boolean;
  places: Record<GibPlace, boolean>;
}

export const defaultGibPrefs: GibPrefs = {
  ...defaultGibLook,
  on: true,
  frequency: "normal",
  reactions: true,
  idle: true,
  tips: true,
  eyes: true,
  places: { companion: true, empty: true, splash: true, overlays: true },
};

/**
 * Whatever was stored as valid preferences. `legacyCompanion` is the old "Compañero" setting (normal / quiet / off):
 * when there are no preferences yet, quiet means no volunteered tips and off means no companion.
 */
export function normalizeGibPrefs(raw: unknown, legacyCompanion?: unknown): GibPrefs {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const fresh = !value || !("on" in value);
  const flag = (key: string, fallback: boolean) => (value && typeof value[key] === "boolean" ? (value[key] as boolean) : fallback);
  const stored = value?.places && typeof value.places === "object" ? (value.places as Record<string, unknown>) : null;
  const places = Object.fromEntries(
    GIB_PLACES.map((place) => {
      const fallback = place === "companion" && fresh ? legacyCompanion !== "off" : true;
      return [place, typeof stored?.[place] === "boolean" ? (stored[place] as boolean) : fallback];
    }),
  ) as Record<GibPlace, boolean>;
  const frequency = value && ["rare", "normal", "often"].includes(value.frequency as string) ? (value.frequency as GibFrequency) : "normal";
  return {
    ...normalizeGibLook(raw),
    on: flag("on", true),
    frequency,
    reactions: flag("reactions", true),
    idle: flag("idle", true),
    tips: flag("tips", fresh ? legacyCompanion !== "quiet" : true),
    eyes: flag("eyes", true),
    places,
  };
}

/** Gib shown in that place: on, and the place not switched off. */
export function gibShownIn(prefs: Pick<GibPrefs, "on" | "places"> | undefined, place: GibPlace): boolean {
  return Boolean(prefs?.on && prefs.places?.[place]);
}
