// Checks for src/gridSelection.ts (the result grid's multiple selection, #218): node --experimental-strip-types dev/gridselection-check.ts
import assert from "node:assert/strict";
import { addRows, clickRows, hasRow, normalizeRows, rowCount, rowList, rowRange, toggleRow, type RowRanges } from "../src/gridSelection.ts";

// Normalised: sorted, merged when overlapping or touching, reversed ranges turned round.
assert.deepEqual(normalizeRows([[5, 5], [1, 2], [3, 3], [9, 7]]), [[1, 3], [5, 5], [7, 9]]);
assert.deepEqual(normalizeRows([[0, 10], [2, 4]]), [[0, 10]]);
assert.deepEqual(normalizeRows([]), []);
assert.deepEqual(rowRange(8, 3), [[3, 8]]);

// Rows 2, 5 and 9 together (Ctrl+click on each, starting from a plain click on 2).
let rows: RowRanges = rowRange(2, 2);
rows = clickRows(rows, 2, 5, { toggle: true, range: false })!;
rows = clickRows(rows, 5, 9, { toggle: true, range: false })!;
assert.deepEqual(rows, [[2, 2], [5, 5], [9, 9]]);
assert.ok(hasRow(rows, 2) && hasRow(rows, 5) && hasRow(rows, 9));
assert.ok(!hasRow(rows, 3) && !hasRow(rows, 8) && !hasRow(rows, 10) && !hasRow(rows, 0));
assert.equal(rowCount(rows), 3);
assert.deepEqual(rowList(rows), [2, 5, 9], "screen order");

// Ctrl+click again takes the row out and keeps the rest; taking every row out leaves nothing.
assert.deepEqual(toggleRow(rows, 5), [[2, 2], [9, 9]]);
assert.deepEqual(toggleRow(toggleRow(toggleRow(rows, 5), 2), 9), []);
// Out of the middle of a range: it splits; added next to one: they merge.
assert.deepEqual(toggleRow(rowRange(0, 9), 4), [[0, 3], [5, 9]]);
assert.deepEqual(toggleRow(rowRange(0, 9), 0), [[1, 9]]);
assert.deepEqual(toggleRow(rowRange(0, 9), 9), [[0, 8]]);
assert.deepEqual(toggleRow([[0, 3], [5, 9]], 4), [[0, 9]]);
// The ranges moved from are not changed.
const before: RowRanges = [[0, 3], [5, 9]];
toggleRow(before, 4);
toggleRow(before, 6);
assert.deepEqual(before, [[0, 3], [5, 9]]);

// Shift+click: from the last clicked row, alone; Ctrl+Shift+click: added to what is selected.
assert.deepEqual(clickRows(rows, 9, 12, { toggle: false, range: true }), [[9, 12]]);
assert.deepEqual(clickRows(rows, 9, 6, { toggle: false, range: true }), [[6, 9]], "upwards");
assert.deepEqual(clickRows(rows, 9, 12, { toggle: true, range: true }), [[2, 2], [5, 5], [9, 12]]);
assert.deepEqual(clickRows([[2, 2]], 2, 20, { toggle: true, range: true }), [[2, 20]]);
assert.deepEqual(addRows([[2, 2], [9, 9]], 4, 7), [[2, 2], [4, 7], [9, 9]]);
assert.deepEqual(addRows([[2, 2], [9, 9]], 3, 8), [[2, 9]], "touching on both sides");
// No anchor yet: the clicked row is the start.
assert.deepEqual(clickRows([], null, 4, { toggle: false, range: true }), [[4, 4]]);
assert.deepEqual(clickRows([], null, 4, { toggle: true, range: true }), [[4, 4]]);
// A plain click: back to the single selection.
assert.equal(clickRows(rows, 9, 3, { toggle: false, range: false }), null);

// Far-apart rows (5 and 5000), and every row but one of a million: a handful of numbers.
const far = clickRows(rowRange(5, 5), 5, 5000, { toggle: true, range: false })!;
assert.deepEqual(far, [[5, 5], [5000, 5000]]);
assert.ok(hasRow(far, 5000) && !hasRow(far, 4999));
const allButOne = toggleRow(rowRange(0, 999_999), 500_000);
assert.equal(allButOne.length, 2);
assert.equal(rowCount(allButOne), 999_999);
assert.ok(!hasRow(allButOne, 500_000) && hasRow(allButOne, 499_999) && hasRow(allButOne, 999_999));

console.log("gridselection-check: ok");
