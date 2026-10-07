// Checks the table viewer's WHERE help on the running app: hints while typing, the engine error mapped to the
// WHERE box, and the one-click fix. Usage: node dev/where-check.mjs [shot1.png] [shot2.png]
import { writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const rowByText = (t) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === t);
  const pane = () => document.querySelector('.pane-host.active');
`;
const js = (code) => app.js(H + code);
const top = { clip: { x: 0, y: 0, width: 1500, height: 330, scale: 1 } };

await js(`
  await until(() => document.querySelector('.companion.landed'), 15000);
  const conn = [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  if (!rowByText('events')) { conn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => rowByText('events')); }
  rowByText('events').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && pane().querySelector('.data-toolbar .muted.small')?.textContent.includes('filas'));
  pane().querySelector('.filter-field input').focus();
`);
await app.send("Input.insertText", { text: 'kind LIKE "click"' });
await sleep(400);
console.log("hints while typing:", JSON.stringify(await js(`return [...pane().querySelectorAll('.where-hint')].map((h) => h.textContent);`)));

await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(1200);
console.log("after Enter:", JSON.stringify(await js(`
  const i = pane().querySelector('.filter-field input');
  return { banner: pane().querySelector('.banner.error')?.innerText, selected: i.value.slice(i.selectionStart, i.selectionEnd) };
`)));
if (process.argv[2]) writeFileSync(process.argv[2], await app.shot(top));

await js(`[...pane().querySelectorAll('.banner .btn')].find((b) => b.textContent.includes('Corregir')).click(); await sleep(1500);`);
console.log("after fix:", JSON.stringify(await js(`return {
  where: pane().querySelector('.filter-field input').value,
  error: pane().querySelector('.banner.error')?.innerText ?? null,
  rows: pane().querySelector('.data-toolbar .muted.small')?.textContent,
  hints: [...pane().querySelectorAll('.where-hint')].map((h) => h.textContent),
};`)));
if (process.argv[3]) writeFileSync(process.argv[3], await app.shot(top));
app.close();
