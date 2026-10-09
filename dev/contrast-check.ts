// Checks for src/contrast.ts and the theme colours in src/App.css: node --experimental-strip-types dev/contrast-check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrastRatio, labelColorOn, luminance } from "../src/contrast.ts";
import { ACCENTS } from "../src/types.ts";

assert.equal(luminance("#000"), 0);
assert.equal(luminance("#ffffff"), 1);
assert.equal(luminance("red-ish"), null);
assert.equal(contrastRatio("#000", "#fff"), 21);
assert.equal(labelColorOn("#00418a"), "#fff");
assert.equal(labelColorOn("#3ff36d"), "#000");
for (const accent of ACCENTS) {
  const ratio = contrastRatio(accent.value, labelColorOn(accent.value));
  assert.ok(ratio >= 4.5, `${accent.name}: label at ${ratio.toFixed(2)}:1`);
}

// Theme tokens: every theme starts from the dark one (`:root`) and redefines some.
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const block = (selector: string) => {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `no ${selector} in App.css`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map((m) => [m[1], m[2]]));
};
const dark = block(":root,\n[data-theme-preview=\"dark\"]");
const themes: Record<string, Record<string, string>> = { dark };
for (const name of ["light", "darcula", "fjord", "sand", "contrast", "contrast-light"]) {
  themes[name] = { ...dark, ...block(`:root[data-theme="${name}"]`) };
}
const atLeast = (theme: string, fg: string, bg: string, min: number) => {
  const tokens = themes[theme];
  const ratio = contrastRatio(tokens[fg], tokens[bg]);
  assert.ok(ratio >= min, `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (want ${min})`);
};

for (const theme of Object.keys(themes)) {
  atLeast(theme, "--run-fg", "--run", 4.5);
  atLeast(theme, "--danger-fg", "--danger", 4.5);
}
for (const theme of ["contrast", "contrast-light"]) {
  for (const token of Object.keys(themes[theme]).filter((t) => t.startsWith("--syntax-") || t.startsWith("--obj-"))) {
    atLeast(theme, token, "--surface", 4.5);
  }
}
for (const token of Object.keys(themes.sand).filter((t) => t.startsWith("--obj-"))) atLeast("sand", token, "--panel", 3);
// Secondary and faint text carry information (hints, counts, headings): AA on the surfaces they sit on.
for (const theme of ["sand"]) {
  for (const bg of ["--bg", "--panel", "--surface"]) {
    atLeast(theme, "--text-muted", bg, 4.5);
    atLeast(theme, "--text-faint", bg, 4.5);
  }
}

console.log("contrast-check: ok");
