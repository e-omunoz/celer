// Checks for src/themes.ts (custom themes) and the theme tokens in src/App.css:
// node --experimental-strip-types dev/themes-check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALL_TOKENS,
  BUILTIN_THEMES,
  CONTRAST_PAIRS,
  CUSTOM_PREFIX,
  blankTheme,
  duplicateTheme,
  exportThemeJson,
  importThemeJson,
  isSafeColor,
  isSafeFont,
  newThemeId,
  radiusVars,
  readCustomThemes,
  resolveTheme,
  sanitizeTheme,
  themeVars,
  uniqueThemeName,
} from "../src/themes.ts";
import { contrastOf, parseColor, wcagLevel } from "../src/contrast.ts";

// ---- colours a theme may hold
for (const ok of ["#fff", "#1a1918", "#1a191880", "rgb(1 2 3)", "rgb(1, 2, 3, 0.5)", "rgb(236 234 228 / 0.06)", "hsl(20 50% 40%)", "color-mix(in srgb, var(--accent) 14%, transparent)", "transparent", "rebeccapurple"]) {
  assert.ok(isSafeColor(ok), `${ok} should be accepted`);
}
for (const bad of ["", "url(http://x/y.png)", "red; background: url(x)", "image-set('a.png' 1x)", "var(evil)", "rgb(1 2 3", "expression(alert(1))", "attr(data-x)", "x".repeat(200), "env(safe-area-inset-top)", "red}body{display:none"]) {
  assert.ok(!isSafeColor(bad), `${bad} should be refused`);
}
assert.ok(isSafeFont("JetBrains Mono"));
assert.ok(isSafeFont("Segoe UI Variable"));
assert.ok(!isSafeFont('Inter", url(x)'));
assert.ok(!isSafeFont(""));

// ---- names and ids
assert.equal(uniqueThemeName("Mi tema", []), "Mi tema");
assert.equal(uniqueThemeName("Mi tema", ["mi tema"]), "Mi tema (2)");
assert.equal(uniqueThemeName("Mi tema (2)", ["Mi tema", "Mi tema (2)"]), "Mi tema (3)");
assert.equal(uniqueThemeName("  ", []), "Tema");
assert.notEqual(newThemeId(1, 0.1), newThemeId(1, 0.2));
assert.match(newThemeId(), /^[\w-]{1,40}$/);

const base = blankTheme("a1", "Noche", "fjord");
const edited = { ...base, colors: { "--bg": "#101010", "--accent": "#3b82f6" }, uiFont: "Segoe UI", editorFont: "Cascadia Code", radius: 4, rowHeight: 28, shadow: "none" as const, motionScale: 1.5 };
const copy = duplicateTheme(edited, "b2", ["Noche"]);
assert.equal(copy.name, "Noche (copia)");
assert.equal(copy.id, "b2");
copy.colors["--bg"] = "#000";
assert.equal(edited.colors["--bg"], "#101010", "a duplicate does not share its colours with the original");

// ---- what a theme sets on <html>
const vars = themeVars(edited);
assert.equal(vars["--bg"], "#101010");
assert.equal(vars["--accent"], "#3b82f6");
assert.match(vars["--sans"], /^"Segoe UI", "Inter"/);
assert.match(vars["--mono"], /^"Cascadia Code", "JetBrains Mono"/);
assert.equal(vars["--radius-md"], "4px");
assert.equal(vars["--row-h"], "28px");
assert.equal(vars["--bar-h"], "42px");
assert.equal(vars["--shadow-md"], "none");
assert.equal(vars["--motion-scale"], "1.5");
assert.deepEqual(themeVars(base), {}, "an untouched theme sets nothing: it is its base");
assert.deepEqual(radiusVars(8), { "--radius-xs": "4px", "--radius-sm": "5px", "--radius-md": "8px", "--radius-lg": "12px", "--radius-xl": "14px" });

// ---- export → import on a fresh data folder gives the same theme (new id, same look)
const file = exportThemeJson(edited);
assert.ok(!file.includes('"id"'), "the file carries no id");
const back = importThemeJson(file, "fresh1", []);
assert.deepEqual(themeVars(back), themeVars(edited), "an imported theme looks the same");
assert.equal(back.name, "Noche");
assert.equal(back.base, "fjord");
assert.equal(importThemeJson(file, "fresh2", ["Noche"]).name, "Noche (2)");
assert.throws(() => importThemeJson("{", "x", []), /JSON/);
assert.throws(() => importThemeJson('{"kind":"other"}', "x", []), /no es un tema/);
assert.throws(() => importThemeJson('{"kind":"celer-theme","version":9,"base":"dark"}', "x", []), /más nueva/);
assert.throws(() => importThemeJson('{"kind":"celer-theme","version":1,"base":"neon"}', "x", []), /base/);
// A file can only set known tokens with safe values, and numbers within range.
const hostile = importThemeJson(
  JSON.stringify({ kind: "celer-theme", version: 1, name: "x", base: "dark", colors: { "--bg": "url(http://x)", "--text": "#eee", "--unknown": "#fff", "--sans": "#000" }, fonts: { ui: 'A", url(x)' }, radius: 999, rowHeight: -4, motionScale: 40, shadow: "huge" }),
  "h1",
  [],
);
assert.deepEqual(hostile.colors, { "--text": "#eee" });
assert.equal(hostile.uiFont, "");
assert.equal(hostile.radius, 16);
assert.equal(hostile.rowHeight, 20);
assert.equal(hostile.motionScale, 2);
assert.equal(hostile.shadow, "base");

// ---- settings.json: damaged entries are left out, duplicates once
const kept = readCustomThemes([edited, { ...edited }, { id: "z", base: "nope" }, null, "x", { ...base, id: "../evil" }]);
assert.deepEqual(kept.map((theme) => theme.id), ["a1"]);
assert.equal(sanitizeTheme({ id: "a", base: "dark" })?.name, "Tema sin nombre");
assert.deepEqual(readCustomThemes(undefined), []);

// ---- choosing: built-in, custom, system light/dark, a deleted custom theme
const themes = [edited];
const pick = (choice: string, systemDark: boolean, lightChoice = "light", darkChoice = "dark") => resolveTheme(choice, { systemDark, lightChoice, darkChoice, themes });
assert.equal(pick("sand", true).base, "sand");
assert.equal(pick(`${CUSTOM_PREFIX}a1`, false).base, "fjord");
assert.equal(pick(`${CUSTOM_PREFIX}a1`, false).custom?.id, "a1");
assert.equal(pick("system", false).base, "light");
assert.equal(pick("system", true).base, "dark");
assert.equal(pick("system", true, "light", `${CUSTOM_PREFIX}a1`).custom?.id, "a1", "a custom theme follows the system's dark mode");
assert.equal(pick("system", false, "contrast-light", `${CUSTOM_PREFIX}a1`).base, "contrast-light");
assert.equal(pick(`${CUSTOM_PREFIX}gone`, true).base, "dark", "a deleted theme falls back");
assert.equal(pick(`${CUSTOM_PREFIX}gone`, false).custom, null);
assert.equal(pick("system", true, "light", "system").base, "dark");

// ---- every editable token exists in App.css, every contrast pair names editable tokens
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
for (const token of ALL_TOKENS) assert.ok(css.includes(`${token}:`), `${token} is not defined in App.css`);
for (const pair of CONTRAST_PAIRS) {
  assert.ok(ALL_TOKENS.has(pair.fg) && ALL_TOKENS.has(pair.bg), `${pair.fg} / ${pair.bg} are not editable tokens`);
}
for (const theme of BUILTIN_THEMES) {
  if (theme.id !== "dark") assert.ok(css.includes(`:root[data-theme="${theme.id}"]`), `${theme.id} has no block in App.css`);
}
// The radius tokens a theme sets are the ones components read (no hard-coded radius beyond hairlines and pills).
for (const m of css.matchAll(/border-radius:\s*([^;}]*)/g)) {
  for (const px of m[1].matchAll(/(\d+)px/g)) assert.ok(Number(px[1]) <= 2 || Number(px[1]) >= 18, `border-radius: ${m[1]} is not a token`);
}

// ---- colour parsing as the browser reports computed colours
assert.deepEqual(parseColor("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30, a: 1 });
assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
assert.deepEqual(parseColor("rgb(10 20 30 / 50%)"), { r: 10, g: 20, b: 30, a: 0.5 });
assert.deepEqual(parseColor("color(srgb 1 0 0.5 / 0.25)"), { r: 255, g: 0, b: 127.5, a: 0.25 });
assert.deepEqual(parseColor("#ff000080"), { r: 255, g: 0, b: 0, a: 128 / 255 });
assert.equal(parseColor("hsl(0 0% 0%)"), null);
assert.equal(parseColor("color(display-p3 1 0 0)"), null);
assert.equal(contrastOf("#000", "#fff"), 21);
assert.equal(contrastOf("rgb(0 0 0 / 0)", "#fff"), 1, "invisible text has no contrast");
// Translucent background over a dark surface: what the eye sees is the mix.
const onDark = contrastOf("#ffffff", "rgb(255 255 255 / 0.1)", "#000000")!;
assert.ok(onDark > 10 && onDark < 21, `got ${onDark}`);
assert.equal(contrastOf("nope", "#fff"), null);
assert.equal(wcagLevel(7.2), "AAA");
assert.equal(wcagLevel(4.6), "AA");
assert.equal(wcagLevel(3.1), "AA grande");
assert.equal(wcagLevel(2), "");

console.log("themes-check: ok");
