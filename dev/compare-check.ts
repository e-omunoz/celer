// Checks for src/compare.ts: node --experimental-strip-types dev/compare-check.ts
import assert from "node:assert/strict";
import { compareResults, guessKey } from "../src/compare.ts";

const cols = (...names: string[]) => names.map((name) => ({ name, typeName: "", kind: "text" as const }));
const rs = (columns: string[], rows: unknown[][]) => ({ columns: cols(...columns), rows: rows as never, hasMore: false, rowsAffected: null });

const before = rs(["id", "name", "total"], [[1, "Ana", 10], [2, "Luis", 20], [3, "Mia", 30], [4, "Hugo", null]]);
const after = rs(["id", "name", "total"], [[1, "Ana", 10], [2, "Luis", 25], [4, "Hugo", 5], [5, "Nora", 50]]);
assert.deepEqual(guessKey(before, after), ["id"]);
const c = compareResults(before, after);
assert.deepEqual(c.counts, { equal: 1, changed: 2, gone: 1, added: 1 });
assert.deepEqual(c.key, ["id"]);
// Changed cells point at the new value's position and keep the old value.
const luis = c.rows.findIndex((r) => r[0] === 2);
assert.equal(c.changed[`${luis}:2`], "20");
const hugo = c.rows.findIndex((r) => r[0] === 4);
assert.equal(c.changed[`${hugo}:2`], null, "NULL → 5 is a change from NULL");
// Order: matched rows, then gone, then new.
assert.equal(c.rows[c.gone[0]][0], 3);
assert.equal(c.newFrom, 4);
assert.equal(c.rows[c.newFrom][0], 5);

// No unique column: whole rows are compared (a change shows as gone + new); duplicates match one to one.
const dupA = rs(["kind"], [["a"], ["a"], ["b"]]);
const dupB = rs(["kind"], [["a"], ["b"], ["b"]]);
assert.deepEqual(guessKey(dupA, dupB), []);
assert.deepEqual(compareResults(dupA, dupB).counts, { equal: 2, changed: 0, gone: 1, added: 1 });

// Different columns: only the shared ones are compared, the rest are listed.
const wideA = rs(["id", "x", "old"], [[1, "a", "z"]]);
const wideB = rs(["id", "x", "new"], [[1, "a", "q"]]);
const w = compareResults(wideA, wideB);
assert.deepEqual(w.counts, { equal: 1, changed: 0, gone: 0, added: 0 });
assert.deepEqual(w.onlyOld, ["old"]);
assert.deepEqual(w.onlyNew, ["new"]);
// Numbers and their text form are the same value (pages arrive as numbers or strings depending on the driver).
assert.deepEqual(compareResults(rs(["id", "v"], [[1, 2]]), rs(["id", "v"], [[1, "2"]])).counts.equal, 1);
console.log("compare-check: all good");
