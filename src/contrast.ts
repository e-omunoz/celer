// WCAG contrast between colours, for picking a readable label colour on a user-chosen fill (the accent) and for
// the theme editor's checker (src/components/ThemeEditor.tsx), which reads the colours the browser computed.

/** Relative luminance of a `#rgb` / `#rrggbb` colour (0 black to 1 white), or null if it is not one. */
export function luminance(hex: string): number | null {
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two hex colours (1 to 21); 1 when either is not a hex colour. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  if (x === null || y === null) return 1;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** White or black, whichever reads better on `fill`: white while it reaches 4.5:1, as most accents are drawn. */
export function labelColorOn(fill: string): "#fff" | "#000" {
  if (luminance(fill) === null) return "#fff";
  return contrastRatio(fill, "#fff") >= 4.5 || contrastRatio(fill, "#fff") >= contrastRatio(fill, "#000") ? "#fff" : "#000";
}

/** An sRGB colour with alpha: r, g, b from 0 to 255, a from 0 to 1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A colour as written in CSS or as a browser reports it once computed: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()` / `rgba()` (commas or spaces, `/ alpha`, percentages) and `color(srgb r g b / a)` (what color-mix()
 * computes to). null for anything else (named colours, hsl(): the browser resolves those first).
 */
export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|color)\((.*)\)$/.exec(text);
  if (!fn) return null;
  let body = fn[2].trim();
  let srgb = false;
  if (fn[1] === "color") {
    if (!body.startsWith("srgb ")) return null;
    body = body.slice(5);
    srgb = true;
  }
  const [channels, alphaPart] = body.split("/").map((part) => part.trim());
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  let alpha: string | undefined = alphaPart;
  if (!srgb && parts.length === 4 && alpha === undefined) alpha = parts.pop();
  if (parts.length !== 3) return null;
  const channel = (part: string) => {
    if (part === "none") return 0;
    const num = Number.parseFloat(part);
    if (!Number.isFinite(num)) return Number.NaN;
    if (part.endsWith("%")) return (num / 100) * 255;
    return srgb ? num * 255 : num;
  };
  const [r, g, b] = parts.map(channel);
  let a = 1;
  if (alpha !== undefined) {
    const num = Number.parseFloat(alpha);
    a = alpha.endsWith("%") ? num / 100 : num;
  }
  if (![r, g, b, a].every(Number.isFinite)) return null;
  const clamp = (x: number, max: number) => Math.min(max, Math.max(0, x));
  return { r: clamp(r, 255), g: clamp(g, 255), b: clamp(b, 255), a: clamp(a, 1) };
}

/** `top` painted over an opaque `bottom` (what the eye sees of a translucent colour). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (x: number, y: number) => x * top.a + y * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** `#rrggbb` of a colour (alpha dropped). */
export function toHex(color: Rgba): string {
  const two = (x: number) => Math.round(x).toString(16).padStart(2, "0");
  return `#${two(color.r)}${two(color.g)}${two(color.b)}`;
}

/**
 * Contrast of a text colour on a background, both as CSS colours: a translucent background is laid over `under`
 * (the surface below it, white when not given) and the text over the result. null when either is unreadable.
 */
export function contrastOf(fg: string, bg: string, under = "#ffffff"): number | null {
  const base = parseColor(under);
  const back = parseColor(bg);
  const text = parseColor(fg);
  if (!base || !back || !text) return null;
  const solid = composite(back, { ...base, a: 1 });
  return contrastRatio(toHex(composite(text, solid)), toHex(solid));
}

/** The WCAG level a ratio reaches: "AAA" (7), "AA" (4.5), "AA grande" (3, large text and icons only) or "". */
export function wcagLevel(ratio: number): "AAA" | "AA" | "AA grande" | "" {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA grande";
  return "";
}
