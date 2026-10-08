// Checks for src/windowModel.ts: node --experimental-strip-types dev/windows-check.ts
import assert from "node:assert/strict";
import {
  cascadeFrom,
  composeLayout,
  dropTarget,
  gibHost,
  insertAt,
  isFullWindow,
  panelOf,
  placeOnScreen,
  primaryMonitor,
  readLayout,
  riskSummary,
  riskyTabs,
  sortWindows,
  windowKind,
  windowName,
  windowNumber,
  type Monitor,
  type TabRisk,
  type WindowGeometry,
  type WindowRect,
} from "../src/windowModel.ts";

// Labels: the main window, full windows, panels.
assert.equal(windowKind("main"), "main");
assert.equal(windowKind("win-3"), "full");
assert.equal(windowKind("panel-library"), "panel");
assert.ok(isFullWindow("main") && isFullWindow("win-2") && !isFullWindow("panel-ai"));
assert.equal(panelOf("panel-library"), "library");
assert.equal(panelOf("panel-schema-compare-4"), "schema-compare", "the longer name wins");
assert.equal(panelOf("panel-compare-2"), "compare");
assert.equal(panelOf("panel-data-compare-1"), "data-compare");
assert.equal(panelOf("panel-unknown"), null);
assert.equal(panelOf("win-2"), null);
assert.equal(windowNumber("main"), 1);
assert.equal(windowNumber("win-12"), 12);
assert.equal(windowNumber("panel-ai"), 0);
assert.equal(windowName("main"), "la ventana principal");
assert.equal(windowName("win-2"), "la ventana 2");
assert.equal(windowName("panel-plan-3"), "el panel Plan de ejecución");
assert.deepEqual(
  sortWindows([{ label: "panel-ai" }, { label: "win-10" }, { label: "win-2" }, { label: "main" }]).map((w) => w.label),
  ["main", "win-2", "win-10", "panel-ai"],
  "main first, then by number (10 after 2), panels last",
);

// The layout file: version 2 round trip.
const sqlTab = (id: string) => ({ id, kind: "sql", title: id, connId: null, sql: `SELECT '${id}'`, database: "" });
const geometry: WindowGeometry = { x: 100, y: 80, width: 1280, height: 820, maximized: false, monitor: "\\\\.\\DISPLAY1", scale: 1.25 };
const file = composeLayout(
  [
    { kind: "full", title: "a", tabs: [sqlTab("a"), sqlTab("b")], activeTabId: "b", explorerOpen: false, geometry },
    { kind: "full", title: "c", tabs: [sqlTab("c")], activeTabId: "c", geometry: { ...geometry, x: 1500, maximized: true } },
    { kind: "panel", panel: "library", title: "", tabs: [], activeTabId: "", geometry: null },
  ],
  280,
);
assert.equal(file.version, 2);
assert.deepEqual(file.tabs.map((t) => t.id), ["a", "b"], "the first window's tabs at the top, for older versions");
assert.equal(file.activeTabId, "b");
assert.equal(file.sidebarWidth, 280);
const back = readLayout(JSON.parse(JSON.stringify(file)));
assert.equal(back.length, 3);
assert.deepEqual(back[0].tabs.map((t) => t.id), ["a", "b"]);
assert.equal(back[0].activeTabId, "b");
assert.equal(back[0].explorerOpen, false);
assert.deepEqual(back[0].geometry, geometry);
assert.equal(back[1].geometry?.maximized, true);
assert.equal(back[2].kind, "panel");
assert.equal(back[2].panel, "library");
assert.deepEqual(back[2].tabs, []);

// Version 1 (one window, tabs at the top level) and files that are missing or foreign.
const v1 = readLayout({ tabs: [sqlTab("x"), { id: "t", kind: "table", obj: { name: "orders" } }], activeTabId: "t", sidebarWidth: 300 });
assert.equal(v1.length, 1);
assert.deepEqual(v1[0].tabs.map((t) => t.id), ["x", "t"]);
assert.equal(v1[0].activeTabId, "t");
assert.equal(v1[0].geometry, null);
assert.deepEqual(readLayout(null), []);
assert.deepEqual(readLayout("nonsense"), []);
assert.deepEqual(readLayout({}).map((w) => w.tabs.length), [0], "an empty file is one empty window");

// Damaged entries: bad tabs and geometry dropped, a tab twice stays in the first window, a missing active tab
// falls back to the first, panels that cannot be restored are left out, and a full window always comes first.
const messy = readLayout({
  version: 2,
  windows: [
    { kind: "panel", panel: "ai", geometry: { x: 0, y: 0, width: 400, height: 700 } },
    { kind: "panel", panel: "plan" },
    { kind: "full", tabs: [sqlTab("a"), { id: "", kind: "sql" }, { id: "z", kind: "chart" }, null], activeTabId: "gone", geometry: { x: "1", y: 0, width: 10, height: 10 } },
    { kind: "full", tabs: [sqlTab("a"), sqlTab("d")], activeTabId: "a" },
  ],
});
assert.deepEqual(messy.map((w) => w.kind), ["full", "panel", "full"]);
assert.deepEqual(messy[0].tabs.map((t) => t.id), ["a"]);
assert.equal(messy[0].activeTabId, "a");
assert.equal(messy[0].geometry, null);
assert.equal(messy[1].panel, "ai");
assert.deepEqual(messy[2].tabs.map((t) => t.id), ["d"], "the copy of a tab in a second window is dropped");
assert.equal(messy[2].activeTabId, "d");
assert.deepEqual(readLayout({ version: 2, windows: [{ kind: "panel", panel: "library" }] }).map((w) => w.kind), ["full", "panel"], "an empty main window before a lone panel");

// Monitors: a window stays where it was while its monitor is there; when the monitor is gone it moves to one that
// is, centred, fitted and scaled.
const left: Monitor = { name: "\\\\.\\DISPLAY1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
const right: Monitor = { name: "\\\\.\\DISPLAY2", x: 1920, y: 0, width: 2560, height: 1440, scale: 1.5 };
assert.equal(primaryMonitor([right, left])?.name, left.name, "the one at (0, 0)");
assert.equal(primaryMonitor([{ ...right, x: 100 }])?.name, right.name, "or the first");
const onRight: WindowGeometry = { x: 2100, y: 100, width: 1800, height: 1100, maximized: true, monitor: right.name, scale: 1.5 };
assert.deepEqual(placeOnScreen(onRight, [left, right]), onRight, "its monitor is still there");
assert.deepEqual(placeOnScreen(onRight, []), onRight, "no monitor list: left as it was");
const moved = placeOnScreen(onRight, [left]);
assert.equal(moved.monitor, left.name);
assert.equal(moved.maximized, true, "still maximized, on the monitor it moved to");
assert.equal(moved.width, 1200, "1800 px at 150 % are 1200 px at 100 %");
assert.ok(moved.height <= 1080 * 0.95);
assert.equal(moved.x, Math.round((1920 - moved.width) / 2));
assert.ok(moved.x >= 0 && moved.y >= 0 && moved.x + moved.width <= 1920 && moved.y + moved.height <= 1080, "all of it on screen");
const halfOff: WindowGeometry = { x: 1800, y: 200, width: 900, height: 700, maximized: false, monitor: left.name, scale: 1 };
assert.equal(placeOnScreen(halfOff, [left]).x, 1800, "its title bar can still be grabbed: it stays");
const titleOff: WindowGeometry = { ...halfOff, x: 400, y: -600 };
assert.equal(placeOnScreen(titleOff, [left]).y, Math.round((1080 - 700) / 2), "the title bar above the screen: moved back");
const tooBig: WindowGeometry = { ...halfOff, x: 10, y: 10, width: 4000, height: 3000 };
assert.deepEqual([placeOnScreen(tooBig, [left]).width, placeOnScreen(tooBig, [left]).height], [1920, 1080], "made to fit its monitor");
const renamed = placeOnScreen({ ...onRight, x: 9000 }, [left, { ...right, x: -2560 }]);
assert.equal(renamed.monitor, right.name, "the monitor with its name, moved elsewhere in the desktop");
assert.equal(renamed.x, -2560 + Math.round((2560 - renamed.width) / 2));

// New windows cascade from the one that opened them, past the ones already there.
assert.deepEqual(cascadeFrom({ x: 100, y: 100 }, []), { x: 132, y: 132 });
assert.deepEqual(cascadeFrom({ x: 100, y: 100 }, [{ x: 132, y: 132 }, { x: 164, y: 164 }]), { x: 196, y: 196 });

// Where a dragged tab goes.
const rects: WindowRect[] = [
  { label: "main", x: 0, y: 0, width: 1000, height: 800, minimized: false },
  { label: "win-2", x: 1100, y: 0, width: 800, height: 600, minimized: false },
  { label: "panel-library", x: 1100, y: 650, width: 400, height: 400, minimized: false },
  { label: "win-3", x: 0, y: 900, width: 500, height: 300, minimized: true },
];
assert.deepEqual(dropTarget("main", [1200, 100], rects, { label: "win-2", index: 1 }), { kind: "window", label: "win-2", index: 1 }, "the tab bar that took the drop");
assert.deepEqual(dropTarget("main", [500, 500], rects, { label: "main", index: 0 }), { kind: "none" }, "its own window's claim is not a move");
assert.deepEqual(dropTarget("main", [1200, 100], rects, { label: "panel-library", index: 0 }), { kind: "window", label: "win-2", index: null }, "a panel cannot take tabs");
assert.deepEqual(dropTarget("main", [1200, 100], rects, null), { kind: "window", label: "win-2", index: null }, "dropped anywhere on another window");
assert.deepEqual(dropTarget("main", [500, 500], rects, null), { kind: "none" }, "let go on its own window");
assert.deepEqual(dropTarget("main", [1200, 700], rects, null), { kind: "new", x: 1080, y: 682 }, "over a panel: a new window");
assert.deepEqual(dropTarget("main", [100, 1000], rects, null), { kind: "new", x: -20, y: 982 }, "a minimized window does not count");
assert.deepEqual(dropTarget("main", [3000, 300], rects, null), { kind: "new", x: 2880, y: 282 });
assert.deepEqual(dropTarget("main", null, rects, null), { kind: "none" }, "pointer unknown");
assert.deepEqual(dropTarget("win-2", [100, 100], rects, null), { kind: "window", label: "main", index: null }, "back to the main window");

assert.deepEqual(insertAt(["a", "b", "c"], ["x"], 1), ["a", "x", "b", "c"]);
assert.deepEqual(insertAt(["a"], ["x", "y"], null), ["a", "x", "y"]);
assert.deepEqual(insertAt(["a"], ["x"], 9), ["a", "x"]);
assert.deepEqual(insertAt([], ["x"], -1), ["x"]);

// Closing a window: what would be lost, in words.
const risk = (id: string, extra: Partial<TabRisk> = {}): TabRisk => ({ id, kind: "sql", transaction: false, edits: false, text: false, ...extra });
const tabs = [risk("a"), risk("b", { transaction: true, text: true }), risk("c", { kind: "table", edits: true }), risk("d", { text: true }), risk("e", { text: true })];
assert.deepEqual(riskyTabs(tabs).map((t) => t.id), ["b", "c", "d", "e"]);
assert.equal(riskSummary(tabs), "1 consola con una transacción abierta, 1 tabla con cambios sin guardar y 2 consolas sin guardar");
assert.equal(riskSummary([risk("x", { transaction: true }), risk("y", { transaction: true })]), "2 consolas con transacciones abiertas");
assert.equal(riskSummary([risk("x", { text: true }), risk("y", { kind: "table", edits: true })]), "1 tabla con cambios sin guardar y 1 consola sin guardar");
assert.equal(riskSummary([risk("x")]), "");

// Gib lives in one window: the focused full window, else the main one, else the first full window.
assert.equal(gibHost("win-2", ["main", "win-2"]), "win-2");
assert.equal(gibHost("panel-ai", ["main", "panel-ai"]), "main", "never a panel");
assert.equal(gibHost("win-5", ["main", "win-2"]), "main", "a window that is gone");
assert.equal(gibHost("", ["panel-ai", "win-3", "win-2"]), "win-2", "the main window was closed");
assert.equal(gibHost("", ["panel-ai"]), "");

console.log("windows-check: all good");
