// Checks for src/contrast.ts and the theme colours in src/App.css: node --experimental-strip-types dev/contrast-check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrastOf, contrastRatio, labelColorOn, luminance } from "../src/contrast.ts";
import { CONTRAST_PAIRS } from "../src/themes.ts";
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
// Connection environments (src/environment.ts): the chip's label reads on its fill, and the window strip, tab strip
// and explorer dot stand out from the surfaces they sit on (3:1, non-text). Every theme defines its own.
for (const theme of Object.keys(themes)) {
  for (const env of ["dev", "test", "staging", "prod"]) {
    if (theme !== "dark") assert.ok(block(`:root[data-theme="${theme}"]`)[`--env-${env}`], `${theme}: no --env-${env}`);
    atLeast(theme, `--env-${env}-fg`, `--env-${env}`, 4.5);
    for (const bg of ["--bg", "--panel", "--surface"]) atLeast(theme, `--env-${env}`, bg, 3);
  }
}
for (const theme of ["contrast", "contrast-light"]) {
  for (const token of Object.keys(themes[theme]).filter((t) => t.startsWith("--syntax-") || t.startsWith("--obj-"))) {
    atLeast(theme, token, "--surface", 4.5);
  }
}
for (const token of Object.keys(themes.sand).filter((t) => t.startsWith("--obj-"))) atLeast("sand", token, "--panel", 3);
// Secondary and faint text carry information (hints, counts, headings): AA on the surfaces they sit on.
for (const theme of Object.keys(themes)) {
  for (const bg of ["--bg", "--panel", "--surface"]) {
    atLeast(theme, "--text-muted", bg, 4.5);
    atLeast(theme, "--text-faint", bg, 4.5);
  }
}

// The comparison chips (cambiadas, solo en B, solo en A): half the state colour, half the text colour (#153).
const mix = (a: string, b: string, share: number) => {
  const rgb = (hex: string) => {
    const h = hex.slice(1).length === 3 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
};
assert.equal(mix("#000", "#ffffff", 0.5), "#808080");
for (const theme of Object.keys(themes)) {
  const tokens = themes[theme];
  for (const state of ["--warning", "--success", "--danger"]) {
    for (const bg of ["--panel", "--surface"]) {
      const ratio = contrastRatio(mix(tokens[state], tokens["--text"], 0.5), tokens[bg]);
      assert.ok(ratio >= 4.5, `${theme}: ${state} chip label on ${bg} is ${ratio.toFixed(2)}:1`);
    }
    // On their own tint too: the row history's operation chips (.rh-op, 12 % over the panel) and the theme editor's
    // level chips (.te-level, 13 % over the panel; .te-level.low, 40 % warning in its label, 8 % over the 9 %
    // warning tint of a low row), #188.
    const chips = [["--panel", 0.12, 0.5], ["--surface", 0.12, 0.5], ["--panel", 0.13, 0.5], ["--panel", 1 - 0.92 * 0.91, 0.4]] as const;
    for (const [bg, tint, share] of chips) {
      const ratio = contrastRatio(mix(tokens[state], tokens["--text"], share), mix(tokens[state], tokens[bg], tint));
      assert.ok(ratio >= 4.5, `${theme}: ${state} chip label on a ${Math.round(tint * 100)} % tint over ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
}

// Every built-in theme passes the theme editor's own checks (#176), so an untouched copy says «Todo cumple AA».
// Tokens here are any CSS value; var() is followed. Pairs on the user's accent are measured over ACCENTS above.
const fullBlock = (selector: string) => {
  const at = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const accentPairs = new Set(["--accent", "--accent-fg", "--accent-text", "--grid-sel"]);
const fullDark = fullBlock(":root,\n[data-theme-preview=\"dark\"]");
for (const theme of Object.keys(themes)) {
  const raw = theme === "dark" ? fullDark : { ...fullDark, ...fullBlock(`:root[data-theme="${theme}"]`) };
  const value = (token: string) => {
    let text = raw[token];
    for (let hops = 0; text?.startsWith("var(") && hops < 5; hops++) text = raw[text.slice(4, -1).trim()];
    return text;
  };
  for (const pair of CONTRAST_PAIRS) {
    if (accentPairs.has(pair.fg) || accentPairs.has(pair.bg)) continue;
    const ratio = contrastOf(value(pair.fg), value(pair.bg), value(pair.under ?? "--bg"));
    assert.ok(ratio !== null, `${theme}: ${pair.fg} on ${pair.bg} cannot be measured`);
    assert.ok(ratio >= pair.min, `${theme}: ${pair.label} (${pair.fg} on ${pair.bg}) is ${ratio.toFixed(2)}:1 (want ${pair.min})`);
  }
  // Error text in dialogs (the test data generator's blocking problem) and in the row history's .rh-box.bad.
  const tokens = themes[theme];
  atLeast(theme, "--danger", "--popover", 4.5);
  const badBox = mix(tokens["--danger"], tokens["--panel"], 0.07);
  const ratio = contrastRatio(tokens["--danger"], badBox);
  assert.ok(ratio >= 4.5, `${theme}: --danger in .rh-box.bad is ${ratio.toFixed(2)}:1`);
}

console.log("contrast-check: ok");
