// Checks for src/columnOrder.ts (the result grid's column order): node --experimental-strip-types dev/columnorder-check.ts
import assert from "node:assert/strict";
import { dropGap, easeTowards, identityOrder, inOrder, inverseOrder, isIdentity, isPermutation, layoutByColumn, moveColumn, slideGap } from "../src/columnOrder.ts";

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

// Sliding gap while a column is dragged: the slot among the others (packed without it) nearest to the ghost.
const ws = [100, 60, 200, 80]; // from 44: 44, 144, 204, 404, ends 484
// Column 0 (100 wide) dragged: the others pack from 44 as 60 (passed at 44 + 30), 200 (104 + 100), 80 (304 + 40).
assert.equal(slideGap(ws, 0, 44, 44), 0, "where it is: nothing moves");
assert.equal(slideGap(ws, 0, 74, 44), 0, "half of the 60 px neighbour covered: not past it yet");
assert.equal(slideGap(ws, 0, 75, 44), 2, "past half of it: it slides left, the column drops after it");
assert.equal(slideGap(ws, 0, 205, 44), 3, "past half of the 200 px one too");
assert.equal(slideGap(ws, 0, 2_000, 44), 4, "past everything: after the last");
// Column 2 (200 wide) dragged left: the others 100 (passed at 44 + 50), 60 (144 + 30), 80 (204 + 40).
assert.equal(slideGap(ws, 2, 204, 44), 2, "in its own place");
assert.equal(slideGap(ws, 2, 175, 44), 2, "still past half of the 60 px one");
assert.equal(slideGap(ws, 2, 174, 44), 1, "back over half of it: before it");
assert.equal(slideGap(ws, 2, -500, 44), 0, "far left: first");
// Every gap it gives is one moveColumn understands.
for (let from = 0; from < ws.length; from++) {
  for (let left = -200; left < 800; left += 7) {
    const gap = slideGap(ws, from, left, 44);
    assert.ok(gap >= 0 && gap <= ws.length, `gap ${gap} in range`);
    assert.ok(isPermutation(moveColumn(identityOrder(4), from, gap), 4));
  }
}
assert.equal(slideGap([], 0, 0), 0, "no columns");

// Preview layout by query column: the order [2, 0, 1] with widths 100, 60, 200 (by query column).
const wq = [100, 60, 200];
assert.deepEqual([...layoutByColumn([2, 0, 1], (c) => wq[c], 44)], [244, 344, 44]);
assert.deepEqual([...layoutByColumn(identityOrder(3), (c) => wq[c], 0)], [0, 100, 160]);

// Easing: moves part of the way, snaps when close, jumps at once with reduced motion.
{
  const cur = new Float64Array([0, 100]);
  const target = new Float64Array([100, 100]);
  assert.ok(easeTowards(cur, target, 16), "still moving after one frame");
  assert.ok(cur[0] > 0 && cur[0] < 100, "part of the way");
  assert.equal(cur[1], 100, "what is already there stays");
  for (let i = 0; i < 60 && easeTowards(cur, target, 16); i++);
  assert.equal(cur[0], 100, "settles exactly on the target");
  const jump = new Float64Array([0]);
  assert.ok(!easeTowards(jump, new Float64Array([300]), 16, 45, true), "reduced motion: no frames in between");
  assert.equal(jump[0], 300);
}

// Rows and column lists in screen order.
assert.deepEqual(inOrder(["a", "b", "c"], [2, 0, 1]), ["c", "a", "b"]);
assert.deepEqual(inOrder([1, null, "x"], identityOrder(3)), [1, null, "x"]);

console.log("columnorder-check: ok");
