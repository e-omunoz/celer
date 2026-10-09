// Checks for the error log's scrubber (src/scrub.ts) against the samples the core's (errlog.rs) is tested with:
// node --experimental-strip-types dev/errorlog-check.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scrubPaths, scrubStack, scrubText } from "../src/scrub.ts";
import { entriesText, type ErrorEntry } from "../src/errorLogText.ts";

const samples: { engine: string; text: string; gone: string[]; kept: string[] }[] = JSON.parse(readFileSync(new URL("./fixtures/scrub-samples.json", import.meta.url), "utf8"));
assert.ok(samples.length >= 15);
for (const s of samples) {
  const out = scrubText(s.text);
  for (const g of s.gone) assert.ok(!out.includes(g), `${s.engine}: «${g}» sigue en\n${out}`);
  for (const k of s.kept) assert.ok(out.includes(k), `${s.engine}: «${k}» se perdió en\n${out}`);
}

// The user's name, anywhere, in any case.
assert.equal(scrubText("C:\\Temp\\Oscar-backup failed", "oscar"), "C:\\Temp\\‹usuario›-backup failed");
assert.equal(scrubText("x", "ab"), "x", "too short a name would scrub ordinary words");

// Text the user wrote keeps its words; only their folders go.
assert.equal(scrubPaths("Abrí C:\\Users\\ana\\Desktop\\q.sql y falló 'x'"), "Abrí C:\\Users\\…\\Desktop\\q.sql y falló 'x'");
assert.equal(scrubPaths("/home/ana/celer y /Users/ana/x"), "/home/…/celer y /Users/…/x");

// Stacks keep their frames.
const stack = scrubStack("Error: x\n    at run (http://tauri.localhost/assets/index-AbC.js:12:34)\n    at C:\\Users\\ana\\x.js:1:2");
assert.ok(stack.includes("at run (http://tauri.localhost/assets/index-AbC.js:12:34)"), stack);
assert.ok(!stack.includes("ana"), stack);

// The text «Copiar» puts on the clipboard (and the report attaches).
const entries: ErrorEntry[] = [
  { at: Date.UTC(2026, 9, 9, 8, 30, 0), version: "2.3.0", area: "driver:postgres", message: "db error: ERROR: invalid input syntax", stack: "" },
  { at: Date.UTC(2026, 9, 9, 8, 31, 0), version: "2.3.0", area: "ui", message: "TypeError: x is undefined", stack: "at a (index.js:1:2)" },
];
const text = entriesText(entries);
assert.ok(text.includes("2026-10-09T08:30:00Z · 2.3.0 · driver:postgres\ndb error: ERROR: invalid input syntax"), text);
assert.ok(text.includes("    at a (index.js:1:2)"), text);
assert.equal(entriesText([]), "");

console.log("errorlog-check: ok");
