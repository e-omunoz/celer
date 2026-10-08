// ER diagram of "public" in "Postgres local": tables and foreign keys load, hovering lights a table's relations,
// search finds a table, double-click opens it. Saves a screenshot to <outDir>\er.png. Needs the desktop app.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";

const out = process.argv[2] || join(process.env.TEMP || "/tmp", "celer-er");
mkdirSync(out, { recursive: true });
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const rows = (name) => [...document.querySelectorAll('.tree-row')].filter((e) => e.querySelector('.tree-name')?.textContent === name);
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const pane = () => document.querySelector('.pane-host.active');
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 300)}`}`);
  if (!ok) failed++;
};

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'));`);
await js(`if (document.querySelector('.onboarding')) [...document.querySelectorAll('.onboarding button')].find((b) => /Saltar/.test(b.textContent))?.click();`);
const opened = await js(`
  if (!connRow().classList.contains('connected')) connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => rows('public').length);
  rows('public')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 160 }));
  const item = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => /Diagrama/.test(b.textContent)), 3000);
  item?.click();
  await until(() => document.querySelector('.er-view') && !document.querySelector('.er-progress'));
  await sleep(500);
  return { tables: [...document.querySelectorAll('.er-table .er-name')].map((t) => t.textContent), edges: document.querySelectorAll('.er-edge').length, head: document.querySelector('.er-head')?.textContent };
`);
check("the diagram of public loads its tables", ["countries", "customers", "events"].every((t) => opened.tables.includes(t)), JSON.stringify(opened));
check("and their relations", opened.edges >= 2, JSON.stringify(opened));
writeFileSync(join(out, "er.png"), await app.shot());

const hovered = await js(`
  const card = [...document.querySelectorAll('.er-table')].find((g) => g.querySelector('.er-name').textContent === 'customers');
  card.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
  await sleep(250);
  return { lit: document.querySelectorAll('.er-edge.lit').length, dimTables: document.querySelectorAll('.er-table.dim').length };
`);
check("hovering a table lights its relations", hovered.lit >= 2, JSON.stringify(hovered));
writeFileSync(join(out, "er-hover.png"), await app.shot());
await js(`[...document.querySelectorAll('.er-table')].find((g) => g.querySelector('.er-name').textContent === 'customers').dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));`);

const found = await js(`
  const input = document.querySelector('.er-search input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'countr');
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(200);
  return { hits: [...document.querySelectorAll('.er-table.hit .er-name')].map((t) => t.textContent) };
`);
check("search highlights the table", found.hits.length === 1 && found.hits[0] === "countries", JSON.stringify(found));

const openedTable = await js(`
  const card = [...document.querySelectorAll('.er-table')].find((g) => g.querySelector('.er-name').textContent === 'countries');
  card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => !document.querySelector('.er-view') && pane()?.querySelector('.obj-title')?.textContent.includes('countries'));
  return { view: !!document.querySelector('.er-view'), title: pane()?.querySelector('.obj-title')?.textContent ?? '' };
`);
check("double-click opens the table and closes the diagram", !openedTable.view && openedTable.title.includes("countries"), JSON.stringify(openedTable));

const sales = await js(`
  rows('sales')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 }));
  const item = await until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => /Diagrama/.test(b.textContent)), 3000);
  item?.click();
  await until(() => document.querySelector('.er-view') && !document.querySelector('.er-progress'));
  await sleep(400);
  const r = { tables: document.querySelectorAll('.er-table').length, edges: document.querySelectorAll('.er-edge').length };
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await sleep(200);
  r.closed = !document.querySelector('.er-view');
  return r;
`);
check("another schema (sales) works and Esc closes it", sales.tables >= 3 && sales.closed, JSON.stringify(sales));
app.close();
process.exit(failed ? 1 : 0);
