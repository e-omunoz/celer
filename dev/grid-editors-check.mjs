// Cell editors by type in a table tab, against "Postgres local" in the desktop app (dev/run-desktop.ps1):
// booleans (t / f / space and the true-false picker), dates (calendar next to the text) and foreign keys (the
// referenced rows to pick from, searched by name). Saves and reads the values back; the lookup's side session
// is closed when the editor closes.
import { connect, sleep } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const menuItem = (re) => until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => re.test(b.textContent)), 3000);
  const pane = () => document.querySelector('.pane-host.active');
  const sql = async (text) => {
    const c = (await inv('list_connections')).find((x) => x.name === 'Postgres local');
    const s = await inv('open_session', { connId: c.id, password: null });
    try { return await inv('execute', { sessionId: s.sessionId, sql: text, fetch: 100 }); } finally { await inv('close_session', { sessionId: s.sessionId }); }
  };
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 400)}`}`);
  if (!ok) failed++;
};
async function press(key, mods = 0) {
  const named = { Enter: 13, Escape: 27, Delete: 46, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, F2: 113, " ": 32, Tab: 9 };
  const code = key === " " ? "Space" : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = named[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
const pending = () => js(`return pane().querySelector('.tb-btn.submit')?.textContent.trim() ?? '';`);

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");
await js(`
  await sql("DROP TABLE IF EXISTS ge_child; DROP TABLE IF EXISTS ge_parent; " +
    "CREATE TABLE ge_parent (id int PRIMARY KEY, nombre text NOT NULL); " +
    "INSERT INTO ge_parent SELECT g, 'Cliente ' || g FROM generate_series(1, 120) g; UPDATE ge_parent SET nombre = 'Zoe Martín' WHERE id = 77; " +
    "CREATE TABLE ge_child (id int PRIMARY KEY, parent_id int REFERENCES ge_parent(id), activo boolean, alta date, ts timestamptz); " +
    "INSERT INTO ge_child VALUES (1, 1, true, '2024-01-10', '2024-01-10 08:30:00+00'), (2, 2, NULL, NULL, NULL)");
  if (!connRow().classList.contains('connected')) { connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => connRow().classList.contains('connected')); }
  await until(() => rowByText('events'));
  connRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 }));
  (await menuItem(/^Actualizar/))?.click();
  await until(() => rowByText('ge_child'));
  rowByText('ge_child').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => pane()?.querySelector('.grid-canvas') && /ge_child/.test(document.querySelector('.tab.active, .tab.on')?.textContent ?? 'ge_child'));
  await sleep(900);
`);
// Click the first data cell (row 1, column id), then walk with the arrows.
const rect = await js(`const r = pane().querySelector('.grid').getBoundingClientRect(); return { x: r.left, y: r.top };`);
await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x + 70, y: rect.y + 30 + 12, button: "left", clickCount: 1 });
await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + 70, y: rect.y + 30 + 12, button: "left", clickCount: 1 });
await sleep(200);
const goCol = async (n) => {
  await press("ArrowLeft"); await press("ArrowLeft"); await press("ArrowLeft"); await press("ArrowLeft"); await press("ArrowLeft");
  for (let i = 0; i < n; i++) await press("ArrowRight");
};

// ---------------------------------------------------------------- booleans (column 2: activo)
await goCol(2);
await press("f");
await sleep(150);
check("'f' on a boolean sets false straight away", /Guardar \(1\)/.test(await pending()), await pending());
await press("ArrowDown");
await press(" ");
await sleep(150);
check("the space bar flips a boolean (NULL → true)", /Guardar \(2\)/.test(await pending()), await pending());
await press("Enter");
await sleep(150);
const picker = await js(`const b = pane().querySelector('.cell-editor .cell-bool'); return b ? { focused: document.activeElement === b, on: b.querySelector('button.on')?.textContent ?? '' } : null;`);
check("Enter opens the true / false picker, focused, on the value", picker?.focused && picker.on === "true", JSON.stringify(picker));
await press("ArrowRight");
await sleep(80);
const flipped = await js(`return pane().querySelector('.cell-editor .cell-bool button.on')?.textContent ?? '';`);
check("arrows switch the picked value", flipped === "false", flipped);
await press("Escape");
await sleep(100);
check("Esc closes the picker without a change", !(await js(`return !!pane().querySelector('.cell-editor');`)) && /Guardar \(2\)/.test(await pending()), await pending());

// ---------------------------------------------------------------- dates (column 3: alta)
await press("ArrowUp");
await press("ArrowRight");
await press("F2");
await sleep(150);
const dateEditor = await js(`
  const ed = pane().querySelector('.cell-editor'); if (!ed) return null;
  const text = ed.querySelector('input:not([type=date])'); const cal = ed.querySelector('.cell-date input[type=date]');
  const before = { text: text.value, cal: cal?.value };
  cal.value = '2025-02-28'; cal.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(100);
  return { before, after: ed.querySelector('input:not([type=date])').value, focused: document.activeElement === ed.querySelector('input:not([type=date])') };
`);
check("a date cell offers a calendar on its value", dateEditor?.before.cal === "2024-01-10" && dateEditor.before.text === "2024-01-10", JSON.stringify(dateEditor));
check("picking a day writes it in the text, which keeps the focus", dateEditor?.after === "2025-02-28" && dateEditor.focused, JSON.stringify(dateEditor));
await press("Enter");
await sleep(150);
// timestamptz (column 4): the calendar keeps the time and the zone.
await press("ArrowUp");
await press("ArrowRight");
await press("F2");
await sleep(150);
const tsEditor = await js(`
  const ed = pane().querySelector('.cell-editor'); const cal = ed?.querySelector('.cell-date input[type=date]'); if (!cal) return null;
  const before = ed.querySelector('input:not([type=date])').value;
  cal.value = '2026-07-04'; cal.dispatchEvent(new Event('change', { bubbles: true })); await sleep(80);
  return { before, after: ed.querySelector('input:not([type=date])').value };
`);
check("on a timestamp, only the date part changes", tsEditor && tsEditor.after.startsWith("2026-07-04") && tsEditor.after.slice(10) === tsEditor.before.slice(10), JSON.stringify(tsEditor));
await press("Enter");
await sleep(150);

// ---------------------------------------------------------------- foreign key (column 1: parent_id)
const celerSessions = `return (await sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'Celer%' OR application_name = ''")).results[0].rows[0][0];`;
const sessionsBefore = Number(await js(celerSessions));
await press("ArrowUp");
await goCol(1);
await press("F2");
const list = await js(`await until(() => pane().querySelector('.cell-lookup-list button'), 8000); await sleep(150); const l = pane().querySelector('.cell-lookup'); return { title: l?.querySelector('.cell-lookup-head')?.textContent ?? '', items: l?.querySelectorAll('.cell-lookup-list button').length ?? 0, on: l?.querySelector('.cell-lookup-list button.on')?.textContent ?? '' };`);
check("a foreign key lists the referenced rows by name", /ge_parent · nombre/.test(list.title) && list.items === 50, JSON.stringify(list));
check("the current value is highlighted", list.on === "1Cliente 1", JSON.stringify(list));
await app.send("Input.insertText", { text: "zoe" });
await js(`await sleep(150); pane().querySelector('.cell-editor input').dispatchEvent(new Event('input', { bubbles: true }));`);
const found = await js(`await until(() => pane().querySelectorAll('.cell-lookup-list button').length === 1, 5000); return [...pane().querySelectorAll('.cell-lookup-list button')].map((b) => b.textContent);`);
check("typing searches the referenced table (by name, any case)", JSON.stringify(found) === JSON.stringify(["77Zoe Martín"]), JSON.stringify(found));
const during = Number(await js(celerSessions));
await press("ArrowDown");
await press("Enter");
await sleep(400);
check("↓ Enter takes the row; the editor and the list close", !(await js(`return !!pane().querySelector('.cell-editor, .cell-lookup');`)), "");
check("the lookup uses one side session", during === sessionsBefore + 1, JSON.stringify({ sessionsBefore, during }));
// The next row of the same column reuses it; typing a value and Enter keeps what was typed (not a highlight).
await press("F2");
await js(`await until(() => pane().querySelector('.cell-lookup-list button'), 8000); await sleep(100);`);
const reused = Number(await js(celerSessions));
await js(`const i = pane().querySelector('.cell-editor input'); i.select();`);
await app.send("Input.insertText", { text: "3" });
await press("Enter");
await sleep(300);
check("the next cell of the column reuses the session", reused === sessionsBefore + 1, JSON.stringify({ sessionsBefore, reused }));

// ---------------------------------------------------------------- save and read back
await js(`
  pane().querySelector('.tb-btn.submit').click();
  const run = await until(() => [...document.querySelectorAll('.dialog button.primary')].find((b) => /Ejecutar|Guardar|Aplicar/.test(b.textContent)), 5000);
  run?.click();
  await until(() => !document.querySelector('.dialog') && !/Guardar \\(/.test(pane().querySelector('.tb-btn.submit')?.textContent ?? ''), 10000);
  await sleep(300);
`);
const saved = await js(`return (await sql("SELECT id, parent_id, activo, alta::text, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') FROM ge_child ORDER BY id")).results[0].rows;`);
check("saved values read back from the database (the typed 3 included)", JSON.stringify(saved) === JSON.stringify([[1, 77, false, "2025-02-28", "2026-07-04 08:30"], [2, 3, true, null, null]]), JSON.stringify(saved));
// Closing the table closes the lookup's session.
await js(`
  const tab = [...document.querySelectorAll('.tab')].find((t) => /ge_child/.test(t.textContent));
  tab?.querySelector('button[title^="Cerrar"]')?.click();
  await sleep(300);
  const discard = [...document.querySelectorAll('.dialog button')].find((b) => /No guardar|Descartar|Cerrar/.test(b.textContent)); discard?.click();
  await sleep(800);
`);
const sessionsClosed = Number(await js(celerSessions));
check("closing the table closes the lookup's session", sessionsClosed === sessionsBefore - 1, JSON.stringify({ sessionsBefore, sessionsClosed }));

await js(`await sql("DROP TABLE IF EXISTS ge_child; DROP TABLE IF EXISTS ge_parent");`);
app.close?.();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("grid-editors-check: all good");
