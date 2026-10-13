// Context menus and submenus (#111): node --experimental-strip-types --no-warnings dev/menu-check.ts
// - a menu and its submenus stay inside the window near its edges;
// - the keys skip separators and disabled rows, and wrap.
import assert from "node:assert/strict";
import { nextMenuItem, placeMenu } from "../src/menu.ts";

const view = { width: 1280, height: 800 };
const size = { width: 220, height: 300 };

// ---- the root menu: at the pointer, moved left or flipped up near the edges
assert.deepEqual(placeMenu({ x: 100, y: 100 }, size, view), { x: 100, y: 100 });
assert.deepEqual(placeMenu({ x: 1200, y: 100 }, size, view), { x: 1280 - 220 - 6, y: 100 }, "moved left at the right edge");
assert.deepEqual(placeMenu({ x: 100, y: 700 }, size, view), { x: 100, y: 400 }, "opens upwards at the bottom");
assert.deepEqual(placeMenu({ x: 100, y: 200 }, { width: 220, height: 900 }, view), { x: 100, y: 6 }, "taller than the window: from the top");

// ---- a submenu: beside its row, on the left when the right has no room, never off the bottom
const row = { left: 300, right: 520, top: 200 };
assert.deepEqual(placeMenu({ x: 520, y: 200, row }, size, view), { x: 518, y: 195 });
const nearRight = { left: 1000, right: 1220, top: 200 };
assert.deepEqual(placeMenu({ x: 1220, y: 200, row: nearRight }, size, view), { x: 1000 - 220 + 2, y: 195 }, "flips to the left");
const nearBottom = { left: 300, right: 520, top: 700 };
assert.deepEqual(placeMenu({ x: 520, y: 700, row: nearBottom }, size, view), { x: 518, y: 800 - 300 - 6 }, "moved up at the bottom");
const narrow = { width: 400, height: 800 };
assert.equal(placeMenu({ x: 380, y: 10, row: { left: 10, right: 380, top: 10 } }, size, narrow).x, 6, "no room on either side: at the margin");

// ---- keyboard: separators and disabled rows are skipped, and the keys wrap
const items = [{ label: "a" }, { separator: true }, { label: "b", disabled: true }, { label: "c" }, { label: "d" }];
assert.equal(nextMenuItem(items, -1, 1), 0, "first row");
assert.equal(nextMenuItem(items, 0, 1), 3, "over the separator and the disabled row");
assert.equal(nextMenuItem(items, 4, 1), 0, "wraps to the top");
assert.equal(nextMenuItem(items, 0, -1), 4, "wraps to the bottom");
assert.equal(nextMenuItem(items, items.length, -1), 4, "End");
assert.equal(nextMenuItem([{ separator: true }, { disabled: true }], -1, 1), -1, "nothing to choose");

console.log("menu-check: ok");
