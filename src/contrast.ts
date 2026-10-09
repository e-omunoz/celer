// WCAG contrast between colours, for picking a readable label colour on a user-chosen fill (the accent).

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
