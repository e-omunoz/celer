// Interaction profile with a big table: loads every row of `events` (200k) and times what freezes the UI.
// For each step it reports wall time and the longest main-thread block (Long Tasks API).
// Usage (app running with CDP, see dev/run-desktop.ps1): node dev/perf-check.mjs
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(30); } return null; };
  const rowByText = (t) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === t);
  const pane = () => document.querySelector('.pane-host.active');
  const grid = () => pane().querySelector('.grid-scroll');
`;
const js = (code) => app.js(H + code);

// Long-task recorder in the page.
await js(`
  window.__lt = [];
  if (!window.__ltObs) {
    window.__ltObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lt.push(e.duration); });
    window.__ltObs.observe({ type: 'longtask', buffered: false });
  }
`);
async function step(name, code, settle = 400) {
  await js(`window.__lt = [];`);
  const t = Date.now();
  await js(code);
  await sleep(settle);
  const lt = await js(`return window.__lt.slice();`);
  const max = lt.length ? Math.max(...lt) : 0;
  const total = lt.reduce((a, b) => a + b, 0);
  console.log(`${(max > 200 ? "SLOW" : max > 50 ? "meh " : "ok  ").padEnd(5)}${name.padEnd(42)} wall ${String(Date.now() - t).padStart(6)} ms   longest block ${String(Math.round(max)).padStart(5)} ms   blocked ${String(Math.round(total)).padStart(6)} ms`);
}
const mouse = async (type, x, y, extra = {}) => app.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const key = async (k, mods = 0, code = k.length === 1 ? `Key${k.toUpperCase()}` : k, vk = { Enter: 13, Delete: 46, Escape: 27, F2: 113 }[k] ?? k.toUpperCase().charCodeAt(0)) => {
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};

await js(`
  await until(() => document.querySelector('.companion.landed'), 15000);
  const conn = [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  if (!rowByText('events')) { conn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => rowByText('events')); }
`);
await step("open events (first page)", `
  rowByText('events').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && pane().querySelector('.data-toolbar .muted.small')?.textContent.includes('filas'));
`);
await step("load all rows (200k)", `
  [...pane().querySelectorAll('.data-toolbar .btn')].find((b) => b.textContent.includes('Cargar todo')).click();
  await until(() => !pane().querySelector('.data-toolbar .btn') || ![...pane().querySelectorAll('.data-toolbar .btn')].some((b) => b.textContent.includes('Cargar todo')), 120000);
  await until(() => /200[.,]000 filas/.test(pane().querySelector('.data-toolbar .muted.small')?.textContent ?? ''), 120000);
`, 1000);
const box = await js(`const r = grid().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };`);
const cell = (col, row) => [box.x + 60 + col * 120, box.y + 30 + row * 24 + 12];

await step("scroll 40 wheel ticks", `for (let i = 0; i < 40; i++) { grid().dispatchEvent(new WheelEvent('wheel', { deltaY: 900, bubbles: true, cancelable: true })); await sleep(16); }`);
await step("scroll to the end (End key / scrollTop)", `grid().scrollTop = grid().scrollHeight; await sleep(100);`);
await step("scroll back to top", `grid().scrollTop = 0; await sleep(100);`);
const [cx, cy] = cell(1, 2);
await step("click a cell", `void 0`, 0);
await mouse("mousePressed", cx, cy); await mouse("mouseReleased", cx, cy);
await step("select all (Ctrl+A) + status stats", `void 0`, 50);
await key("a", 2);
await step("  (settle after Ctrl+A)", `await sleep(1500);`, 200);
await step("copy all (Ctrl+C)", `void 0`, 50);
await key("c", 2);
await step("  (settle after Ctrl+C)", `await sleep(2500);`, 200);
await mouse("mousePressed", cx, cy); await mouse("mouseReleased", cx, cy);
const [hx, hy] = [box.x + 60 + 2 * 120, box.y + 12];
await step("click column header (select column)", `void 0`, 50);
await mouse("mousePressed", hx, hy, { modifiers: 0 }); await mouse("mouseReleased", hx, hy);
await step("  (settle after column select)", `await sleep(1500);`, 200);
await step("edit a cell (F2, type, Enter)", `void 0`, 0);
await mouse("mousePressed", cx, cy); await mouse("mouseReleased", cx, cy);
await key("F2"); await sleep(150);
await app.send("Input.insertText", { text: "999" });
await key("Enter");
await step("  (settle after edit)", `await sleep(1200);`, 200);
await step("delete selected row (Delete)", `void 0`, 0);
await key("Delete");
await step("  (settle after delete)", `await sleep(1200);`, 200);
await step("revert changes", `[...pane().querySelectorAll('.data-toolbar .tb-icon')].find((b) => b.title.startsWith('Revertir'))?.click(); await sleep(800);`);
await step("record inspector on", `[...pane().querySelectorAll('.tb-icon')].find((b) => b.title.startsWith('Panel de valor')).click(); await sleep(800);`);
await step("sort desc from header menu (server)", `
  const r = grid().getBoundingClientRect();
  grid().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 70, clientY: r.top + 14 }));
  const item = await until(() => [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Orden descendente')));
  item.click();
  const c = document.querySelector('.confirm, .dialog button.danger'); if (c) c.click?.();
  await sleep(300);
  await until(() => !pane().querySelector('.data-toolbar .spin'), 30000);
`, 800);
console.log("rows after sort:", await js(`return pane().querySelector('.data-toolbar .muted.small')?.textContent;`));
app.close();
