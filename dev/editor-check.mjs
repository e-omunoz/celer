// Editor and navigation checks on the running app (Postgres sample DB):
// completion in a console that has not run anything yet, Ctrl+click on a table name, FK navigation.
// Usage: node dev/editor-check.mjs [shotPrefix]
import { writeFileSync } from "node:fs";
import { connect, sleep } from "./cdp-lib.mjs";

const prefix = process.argv[2];
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
  const rowByText = (t) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === t);
  const pane = () => document.querySelector('.pane-host.active');
`;
const js = (code) => app.js(H + code);
const key = async (k, mods = 0, vk) => {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  vk ??= { Escape: 27, Enter: 13, End: 35 }[k] ?? k.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
};

// Close the guide if it is open, connect Postgres (loads the catalog), open a fresh console (no session yet).
await js(`
  await until(() => document.querySelector('.companion.landed'), 15000);
  if (document.querySelector('.onboarding, .tour-bubble')) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
`);
await key("Escape"); await sleep(200); await key("Escape"); await sleep(300);
await js(`
  const conn = [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  if (!rowByText('events')) { conn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => rowByText('events')); }
  conn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); conn.click();
`);
await key("l", 10); // Ctrl+Shift+L
await js(`await until(() => pane()?.querySelector('.cm-content')); pane().querySelector('.cm-content').focus();`);

async function typeAndList(text) {
  await key("a", 2);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  for (const ch of text) await app.send("Input.insertText", { text: ch });
  await sleep(450);
  const list = await js(`return [...document.querySelectorAll('.cm-tooltip-autocomplete li')].slice(0, 6).map((li) => li.querySelector('.cm-completionLabel')?.textContent + (li.querySelector('.cm-completionDetail') ? ' (' + li.querySelector('.cm-completionDetail').textContent + ')' : ''));`);
  await key("Escape");
  return list;
}

let l = await typeAndList("SELECT * FROM ev");
check("tables after FROM (console without a session yet)", l[0]?.startsWith("events"), JSON.stringify(l));
l = await typeAndList("SELECT * FROM events WHERE ki");
check("unqualified columns of the FROM table", l[0]?.startsWith("kind"), JSON.stringify(l));
l = await typeAndList("SELECT * FROM events e JOIN customers c ON c.id = e.customer_id WHERE c.fir");
check("alias. → that table's columns", l[0]?.startsWith("first_name"), JSON.stringify(l));
l = await typeAndList("SELECT cou");
check("SELECT before FROM → catalog columns", l.some((x) => x.startsWith("country")), JSON.stringify(l));
l = await typeAndList("SELECT * FROM sales.");
check("schema. → its tables", l.some((x) => x.startsWith("orders") || x.startsWith("products")), JSON.stringify(l));
l = await typeAndList("SELECT * FROM events WHERE kind = 'cl");
check("no catalog suggestions inside a string", !l.some((x) => x.startsWith("customer_id")), JSON.stringify(l));

// Ctrl+click on "customers" in the SQL opens the table.
await key("a", 2);
await app.send("Input.insertText", { text: "SELECT * FROM customers c WHERE c.id < 10" });
await sleep(300);
const pos = await js(`
  const walker = document.createTreeWalker(pane().querySelector('.cm-content'), NodeFilter.SHOW_TEXT);
  let n; while ((n = walker.nextNode())) { const i = n.textContent.indexOf('customers'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
  return null;
`);
await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y, modifiers: 2 });
await sleep(150);
const underlined = await js(`return !!pane().querySelector('.cm-table-link');`);
if (prefix) writeFileSync(`${prefix}-ctrlhover.png`, await app.shot({ clip: { x: 300, y: 60, width: 760, height: 160, scale: 1 } }));
await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1, modifiers: 2 });
await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1, modifiers: 2 });
const opened = await js(`return await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('customers') && 'customers', 8000);`);
check("Ctrl+hover underlines and Ctrl+click opens the table", underlined && opened === "customers", `underlined=${underlined} opened=${opened}`);

// FK: events.customer_id → customers. Keys section button, header marker and Ctrl+click on a value.
await js(`
  rowByText('events').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('events') && pane().querySelector('.data-toolbar .muted.small')?.textContent.includes('filas'));
  [...pane().querySelectorAll('.seg button')].find((b) => b.textContent.startsWith('Claves')).click();
  await sleep(300);
`);
const keyBtn = await js(`return [...pane().querySelectorAll('.fk-action .btn')].map((b) => b.textContent.trim());`);
check("Keys section offers to open the referenced table", keyBtn.some((t) => t.includes("customers")), JSON.stringify(keyBtn));
if (prefix) writeFileSync(`${prefix}-keys.png`, await app.shot({ clip: { x: 300, y: 60, width: 1140, height: 200, scale: 1 } }));
await js(`[...pane().querySelectorAll('.seg button')].find((b) => b.textContent.startsWith('Datos')).click(); await sleep(400);`);
// customer_id is the 2nd column: Ctrl+click its first value.
const cell = await js(`const g = pane().querySelector('.grid-scroll').getBoundingClientRect(); return { x: g.left + 44 + 110 + 60, y: g.top + 30 + 12 };`);
const expected = await js(`return null;`);
void expected;
await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cell.x, y: cell.y, button: "left", clickCount: 1, modifiers: 2 });
await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cell.x, y: cell.y, button: "left", clickCount: 1, modifiers: 2 });
const fk = await js(`
  await until(() => pane()?.querySelector('.obj-title')?.textContent.includes('customers') && pane().querySelector('.chip'), 8000);
  await until(() => /^1 fila/.test(pane().querySelector('.data-toolbar .muted.small')?.textContent ?? ''), 8000);
  return { title: pane()?.querySelector('.obj-title')?.textContent, chips: [...pane().querySelectorAll('.chip-body')].map((c) => c.textContent), rows: pane().querySelector('.data-toolbar .muted.small')?.textContent };
`);
check("Ctrl+click on an FK value opens the referenced row", /customers/.test(fk.title ?? "") && fk.chips.some((c) => /^id = \d+/.test(c)) && /^1 fila/.test(fk.rows ?? ""), JSON.stringify(fk));
if (prefix) writeFileSync(`${prefix}-fk.png`, await app.shot({ clip: { x: 300, y: 60, width: 1140, height: 220, scale: 1 } }));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll editor checks passed");
app.close();
process.exit(failures ? 1 : 0);
