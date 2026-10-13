// Motion, focus and drag-and-drop checks (#110): node --experimental-strip-types dev/motion-check.ts
// - every transition/animation in the stylesheets takes a motion token (or a one-off time scaled by
//   --motion-scale, or Gib's --motion-gib): no stray hard-coded durations, and reduced motion is honoured;
// - scripts animate with motionMs()/gibMs(), never a bare number;
// - F6 moves between panels in order; the drag ghost's preview.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { nextRegion } from "../src/focus.ts";
import { countLabel, previewLines } from "../src/dnd.ts";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

const sheets = ["src/App.css", "src/gib/activities.css"];
const app = read("src/App.css");
const defined = new Set([...app.matchAll(/(--motion-[\w-]+)\s*:/g)].map((m) => m[1]));
for (const token of ["--motion-fast", "--motion-normal", "--motion-slow", "--motion-scale", "--motion-reduced", "--ease-out", "--ease-in", "--ease-in-out"]) {
  assert.ok(defined.has(token) || app.includes(`${token}:`), `${token} is not defined`);
}

const TIME = /(?<![\w.(-])-?\d*\.?\d+m?s\b/g;
for (const sheet of sheets) {
  const css = read(sheet);
  css.split("\n").forEach((line, i) => {
    if (/^\s*--motion-[\w-]+\s*:/.test(line)) return; // a token's own definition
    for (const decl of line.matchAll(/(?<![\w-])(transition|animation)(-duration|-delay)?\s*:\s*([^;}]+)/g)) {
      const value = decl[3];
      for (const used of value.matchAll(/var\((--motion-[\w-]+)\)/g)) assert.ok(defined.has(used[1]), `${sheet}:${i + 1}: ${used[1]} is not a motion token`);
      // Times left once the scaled ones are taken out must be none.
      const stray = value.replace(/calc\(\s*-?\d*\.?\d+m?s\s*\*\s*var\(--motion-(scale|gib)\)\s*\)/g, "").match(TIME);
      assert.equal(stray, null, `${sheet}:${i + 1}: hard-coded duration ${stray?.join(", ")} in «${decl[0].trim()}»`);
    }
  });
  assert.ok(!css.includes("--dur-"), `${sheet}: the old --dur-* tokens are gone`);
}
assert.match(app, /:root\[data-motion="reduce"\] \*[^{]*\{[^}]*animation-duration: var\(--motion-reduced\) !important/, "reduced motion cuts every animation");
assert.match(app, /@media \(prefers-reduced-motion: reduce\)/, "the system's reduced motion counts before the settings load");

// Scripts: durations through motionMs()/gibMs() and the CSS tokens.
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
};
walk("src");
for (const file of files) {
  const text = read(file);
  assert.ok(!text.includes("--dur-"), `${file} still uses --dur-*`);
  for (const m of text.matchAll(/duration:\s*(\d[\d_]*)/g)) assert.fail(`${file}: duration ${m[1]} without motionMs()/gibMs()`);
  for (const m of text.matchAll(/transition:\s*["'`][^"'`]*\d+m?s\b/g)) assert.fail(`${file}: hard-coded transition «${m[0]}»`);
}

// The missing transitions are there: panels, tabs, toasts, dialogs, menus, hover/press.
for (const rule of [".explorer { animation: panel-in-left", ".inspector { animation: panel-in-right", '[data-leave="dialog"]', '[data-leave="toast"]', '[data-leave="tab"]', '[data-leave="menu"]', "@keyframes tab-in", ":active:not(:disabled) { transform: scale(0.92); }"]) {
  assert.ok(app.includes(rule), `missing: ${rule}`);
}

// Drag and drop shares its tokens.
for (const token of ["--dnd-line", "--dnd-source-opacity", "--dnd-target"]) assert.ok(app.includes(`${token}:`), `${token} is not defined`);
assert.ok(!/\.(tree-row|lib-row|tab)[\w.-]*\.dragging \{ opacity: 0\.\d+/.test(app), "a dragged item dims with --dnd-source-opacity");

// ---- F6: the next panel in screen order, wrapping; from nowhere, the first (or last).
const fake = (name: string, inside: string[] = []) => ({ name, contains: (el: unknown) => el === name || inside.includes(el as string) }) as unknown as HTMLElement;
const regions = [fake("explorer", ["tree"]), fake("editor", ["cm"]), fake("results", ["grid"]), fake("inspector")];
const name = (el: HTMLElement | null) => (el as unknown as { name: string } | null)?.name;
assert.equal(name(nextRegion(regions, "tree" as unknown as Element, 1)), "editor");
assert.equal(name(nextRegion(regions, "grid" as unknown as Element, 1)), "inspector");
assert.equal(name(nextRegion(regions, "inspector" as unknown as Element, 1)), "explorer");
assert.equal(name(nextRegion(regions, "cm" as unknown as Element, -1)), "explorer");
assert.equal(name(nextRegion(regions, "tree" as unknown as Element, -1)), "inspector");
assert.equal(name(nextRegion(regions, null, 1)), "explorer");
assert.equal(name(nextRegion(regions, null, -1)), "inspector");
assert.equal(nextRegion([], null, 1), null);

// ---- the drag ghost
assert.equal(previewLines("\n  SELECT *\n\n  FROM t   \nWHERE x\nAND y\nAND z"), "  SELECT *\n  FROM t\nWHERE x\nAND y");
assert.equal(previewLines("x".repeat(60), 4, 10), `${"x".repeat(9)}…`);
assert.equal(countLabel(1, "elemento", "elementos"), "1 elemento");
assert.equal(countLabel(3, "elemento", "elementos"), "3 elementos");

console.log("motion-check: ok");
