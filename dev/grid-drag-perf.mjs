// Frame times while a result column is dragged (#109): a 200-column, 100k-row result in the active console, one
// header dragged across the grid and back (the columns slide live), then a drag cancelled with Esc. Reports the
// frame intervals (rAF) and the longest main-thread blocks, and writes a DevTools performance trace to
// review-out/grid-drag/trace.json (open it in the Performance panel).
// Usage: the app running with CDP (dev/run-desktop.ps1, or the browser preview with CDP_PORT), a console with a
// connection on show (PostgreSQL, MySQL 8 / MariaDB, SQLite: WITH RECURSIVE; SQL Server gets its own query; the
// grid is the same for every engine, so one is enough for the timing): node dev/grid-drag-perf.mjs [--rows N] [--cols N]
// MySQL / MariaDB need cte_max_recursion_depth raised for 100k rows (SET SESSION cte_max_recursion_depth = 200000).
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const ROWS = arg("rows", 100_000);
const COLS = arg("cols", 200);
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(30); } return null; };
  const pane = () => document.querySelector('.pane-host.active');
`;
const js = (code) => app.js(H + code);
const key = async (k, mods = 0) => {
  const vk = { Enter: 13, Escape: 27 }[k] ?? k.toUpperCase().charCodeAt(0);
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
const mouse = (type, x, y, buttons = 1) => app.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });

// The query: numbers 1..ROWS and COLS columns computed from them (text and numbers mixed).
const kind = await js(`return document.querySelector('.statusbar, .status-bar')?.textContent ?? '';`);
const exprs = Array.from({ length: COLS }, (_, i) => (i % 3 === 0 ? `i * ${i + 1} AS c${i + 1}` : i % 3 === 1 ? `'v' || i AS c${i + 1}` : `i % ${i + 7} AS c${i + 1}`));
const mssql = /SQL Server/i.test(kind);
const sql = mssql
  ? `WITH n(i) AS (SELECT TOP (${ROWS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_objects a CROSS JOIN sys.all_objects b) SELECT ${exprs.map((e) => e.replace("'v' || i", "CONCAT('v', i)")).join(", ")} FROM n`
  : `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) SELECT ${exprs.join(", ")} FROM n`;

await js(`await until(() => pane()?.querySelector('.cm-content'), 20000); pane().querySelector('.cm-content').focus();`);
await key("a", 2);
await app.send("Input.insertText", { text: sql });
await key("Enter", 2);
const loaded = await js(`
  await until(() => pane().querySelector('.grid-canvas') && /filas/.test(pane().querySelector('.results-head, .result-bar, .rbar')?.textContent ?? pane().textContent));
  await sleep(500);
  const all = [...pane().querySelectorAll('button')].find((b) => /Cargar todo/.test(b.textContent));
  if (all) { all.click(); await until(() => ![...pane().querySelectorAll('button')].some((b) => /Cargar todo/.test(b.textContent)), 300000); }
  await sleep(800);
  const r = pane().querySelector('.grid-scroll').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
`);
// A 100k x 200 result leaves the engine with a lot of garbage: major GC / heap compaction tasks of 70-170 ms fire
// seconds after the load whether or not anything is dragged. Wait until the main thread has had no long task for 8 s
// (at most 40 s) so the drag is measured on its own and not on the load's aftermath.
await js(`
  const lts = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push(performance.now()); }).observe({ type: 'longtask' });
  const t0 = performance.now();
  while (performance.now() - t0 < 40000 && performance.now() - Math.max(t0, lts.at(-1) ?? 0) < 8000) await sleep(250);
`);
console.log(`result on show: ${COLS} columns × ${ROWS.toLocaleString()} rows; grid ${Math.round(loaded.w)}×${Math.round(loaded.h)}`);

// Frame recorder: rAF intervals and long tasks.
await js(`
  window.__frames = []; window.__lt = []; window.__rec = true;
  const tick = (t) => { if (!window.__rec) return; window.__frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  if (!window.__ltObs) { window.__ltObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }); window.__ltObs.observe({ type: 'longtask' }); }
`);
const trace = [];
app.on?.("Tracing.dataCollected", (params) => trace.push(...params.value));
await app.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame,blink,cc,gpu", transferMode: "ReportEvents" }).catch(() => {});

// Drag the third header right across the grid, past the edge (auto-scroll), back left, and drop.
const y = loaded.y + 15;
const x0 = loaded.x + 260;
await mouse("mouseMoved", x0, y, 0);
await mouse("mousePressed", x0, y);
for (let i = 1; i <= 90; i++) {
  await mouse("mouseMoved", x0 + i * ((loaded.w - 280) / 90), y);
  await sleep(16);
}
for (let i = 0; i < 40; i++) {
  await mouse("mouseMoved", loaded.x + loaded.w - 6, y); // in the edge band: the grid scrolls
  await sleep(16);
}
for (let i = 1; i <= 90; i++) {
  await mouse("mouseMoved", loaded.x + loaded.w - 6 - i * ((loaded.w - 400) / 90), y);
  await sleep(16);
}
await mouse("mouseReleased", loaded.x + 400, y, 0);
await sleep(400);
// A second drag, cancelled with Esc: the column flies back.
await mouse("mousePressed", x0, y);
for (let i = 1; i <= 30; i++) {
  await mouse("mouseMoved", x0 + i * 10, y);
  await sleep(16);
}
await key("Escape");
await sleep(400);
await mouse("mouseReleased", x0 + 300, y, 0);
await sleep(200);

const done = new Promise((ok) => app.on?.("Tracing.tracingComplete", ok));
await app.send("Tracing.end").catch(() => {});
await Promise.race([done, sleep(5000)]);
const { frames, lt } = await js(`window.__rec = false; return { frames: window.__frames, lt: window.__lt };`);
const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
const pct = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : 0);
const dropped = gaps.filter((g) => g > 25).length;
console.log(`frames ${gaps.length}  p50 ${pct(0.5).toFixed(1)} ms  p95 ${pct(0.95).toFixed(1)} ms  max ${(gaps.at(-1) ?? 0).toFixed(1)} ms  over 25 ms: ${dropped}`);
console.log(`long tasks: ${lt.length}${lt.length ? ` (longest ${Math.round(Math.max(...lt))} ms)` : ""}`);
if (trace.length) {
  const dir = resolve(import.meta.dirname, "..", "review-out", "grid-drag");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "trace.json"), JSON.stringify({ traceEvents: trace }));
  console.log(`trace: ${resolve(dir, "trace.json")}`);
}
const ok = pct(0.95) <= 20 && !lt.some((d) => d > 50);
console.log(ok ? "PASS  smooth (p95 ≤ 20 ms, no task over 50 ms)" : "FAIL  frames dropped while dragging");
app.close();
process.exit(ok ? 0 : 1);
