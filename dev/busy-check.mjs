// Checks the busy overlay: "Cargar todo" shows Gib + progress, Cancel keeps the rows loaded so far,
// and a 200k-row local sort in a console paints the overlay instead of freezing.
// Usage: node dev/busy-check.mjs [shot.png]
import { writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(25); } return null; };
  const rowByText = (t) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === t);
  const pane = () => document.querySelector('.pane-host.active');
`;
const js = (code) => app.js(H + code);
const openEvents = () => js(`
  await until(() => document.querySelector('.companion.landed'), 15000);
  const conn = [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  if (!rowByText('events')) { conn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => rowByText('events')); }
  rowByText('events').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && [...pane().querySelectorAll('.data-toolbar .btn')].some((b) => b.textContent.includes('Cargar todo')));
`);

// 1) Load all: the overlay must appear while loading and the page must keep answering.
await openEvents();
await js(`[...pane().querySelectorAll('.data-toolbar .btn')].find((b) => b.textContent.includes('Cargar todo')).click();`);
let seen = null;
for (let i = 0; i < 40 && !seen; i++) {
  await sleep(100);
  seen = await js(`const o = pane().querySelector('.busy-overlay'); return o ? o.innerText : null;`);
}
console.log("overlay while loading:", JSON.stringify(seen));
if (process.argv[2]) writeFileSync(process.argv[2], await app.shot());
await js(`await until(() => !pane().querySelector('.busy-overlay'), 60000);`);
console.log("after load:", await js(`return pane().querySelector('.data-toolbar .muted.small')?.textContent;`));

// 2) Cancel: reopen the table and cancel mid-way.
await js(`[...pane().querySelectorAll('.tb-icon')].find((b) => b.title.startsWith('Recargar')).click(); await until(() => [...pane().querySelectorAll('.data-toolbar .btn')].some((b) => b.textContent.includes('Cargar todo')), 20000);`);
await js(`[...pane().querySelectorAll('.data-toolbar .btn')].find((b) => b.textContent.includes('Cargar todo')).click();`);
await js(`const b = await until(() => [...pane().querySelectorAll('.busy-overlay .btn')].find((x) => x.textContent === 'Cancelar'), 5000); b?.click();`);
await js(`await until(() => !pane().querySelector('.busy-overlay'), 20000);`);
console.log("after cancel:", await js(`return { rows: pane().querySelector('.data-toolbar .muted.small')?.textContent, toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).pop() };`));

// 3) Local sort of 200k rows in a console.
await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 10 });
await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 10 });
await js(`await until(() => pane()?.querySelector('.cm-content')); pane().querySelector('.cm-content').focus();`);
await app.send("Input.insertText", { text: "SELECT * FROM events" });
await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2 });
await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2 });
await js(`await until(() => [...pane().querySelectorAll('.btn')].some((b) => b.textContent.includes('Cargar todo')), 20000);
  [...pane().querySelectorAll('.btn')].find((b) => b.textContent.includes('Cargar todo')).click();
  await sleep(300); await until(() => !pane().querySelector('.busy-overlay'), 60000);`);
console.log("console rows:", await js(`return [...pane().querySelectorAll('.muted, .small')].map((e) => e.textContent).find((t) => /filas/.test(t)) ?? null;`));
// Sort descending on the third column (kind, text: the slowest comparator) from the header menu.
await js(`
  const g = pane().querySelector('.grid-scroll'); const r = g.getBoundingClientRect();
  g.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 330, clientY: r.top + 14 }));
  await until(() => [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Orden descendente')), 3000);
`);
const t = Date.now();
await js(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Orden descendente')).click();`);
const answered = Date.now() - t;
await sleep(450);
const overlay = await js(`return pane().querySelector('.busy-overlay')?.innerText ?? null;`);
await js(`await until(() => !pane().querySelector('.busy-overlay'), 30000);`);
console.log(`local sort: click handled in ${answered} ms, overlay: ${JSON.stringify(overlay)}, done after ${Date.now() - t} ms`);
app.close();
process.exit(0);
