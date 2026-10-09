// Checks for src/columnOrder.ts (the result grid's column order): node --experimental-strip-types dev/columnorder-check.ts
import assert from "node:assert/strict";
import { dropGap, identityOrder, inOrder, inverseOrder, isIdentity, isPermutation, moveColumn } from "../src/columnOrder.ts";

assert.deepEqual(identityOrder(4), [0, 1, 2, 3]);
assert.deepEqual(identityOrder(0), []);
assert.ok(isIdentity([0, 1, 2]));
assert.ok(isIdentity([]));
assert.ok(!isIdentity([1, 0, 2]));

// Moving: the gap is between screen columns (0 before the first, length after the last).
const start = identityOrder(5);
assert.deepEqual(moveColumn(start, 0, 5), [1, 2, 3, 4, 0], "first to the end");
assert.deepEqual(moveColumn(start, 4, 0), [4, 0, 1, 2, 3], "last to the front");
assert.deepEqual(moveColumn(start, 1, 3), [0, 2, 1, 3, 4], "one step right");
assert.deepEqual(moveColumn(start, 3, 1), [0, 3, 1, 2, 4], "two steps left");
// Next to itself, or out of range: nothing changes, and the same array comes back (no needless update).
assert.equal(moveColumn(start, 2, 2), start);
assert.equal(moveColumn(start, 2, 3), start);
assert.equal(moveColumn(start, -1, 3), start);
assert.equal(moveColumn(start, 2, 6), start);
assert.deepEqual(start, [0, 1, 2, 3, 4], "the order moved from is not changed");
// Moves compose on an order that is already moved.
const moved = moveColumn(moveColumn(start, 0, 5), 4, 0);
assert.deepEqual(moved, start, "moving the first to the end and back gives the query's order");
assert.deepEqual(moveColumn([2, 0, 1], 0, 3), [0, 1, 2]);

// Screen position of each query column.
assert.deepEqual(inverseOrder([2, 0, 1]), [1, 2, 0]);
assert.deepEqual(inverseOrder(inverseOrder([3, 1, 0, 2])), [3, 1, 0, 2]);
for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
  const at = inverseOrder(order);
  order.forEach((source, visual) => assert.equal(at[source], visual));
}

// Permutations (what the export accepts).
assert.ok(isPermutation([2, 0, 1], 3));
assert.ok(isPermutation([], 0));
assert.ok(!isPermutation([0, 1], 3), "too short");
assert.ok(!isPermutation([0, 0, 1], 3), "repeated");
assert.ok(!isPermutation([0, 1, 3], 3), "out of range");
assert.ok(!isPermutation([0, 1.5, 2], 3), "not an index");

// Drop gap: left half of a column drops before it, right half after it.
const xs = [44, 144, 204, 404]; // three columns, 100, 60 and 200 wide, after a 44 px gutter
assert.equal(dropGap(xs, 0), 0);
assert.equal(dropGap(xs, 90), 0);
assert.equal(dropGap(xs, 95), 1);
assert.equal(dropGap(xs, 173), 1);
assert.equal(dropGap(xs, 175), 2);
assert.equal(dropGap(xs, 303), 2);
assert.equal(dropGap(xs, 305), 3);
assert.equal(dropGap(xs, 10_000), 3, "past the last column: after it");
assert.equal(dropGap([44], 100), 0, "no columns");

// Rows and column lists in screen order.
assert.deepEqual(inOrder(["a", "b", "c"], [2, 0, 1]), ["c", "a", "b"]);
assert.deepEqual(inOrder([1, null, "x"], identityOrder(3)), [1, null, "x"]);

console.log("columnorder-check: ok");
