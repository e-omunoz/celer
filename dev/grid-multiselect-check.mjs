// Multiple selection in the result grid (#218), on every engine of a slot's data folder (dev/run-desktop.ps1 -Slot n,
// one connection per engine: dev/devdata-connections.mjs): Ctrl+click rows 2, 5 and 9, Shift and Ctrl+Shift ranges,
// Esc, copies (Ctrl+C, Ctrl+Shift+C, «Copiar como › JSON»), the status bar, «Exportar selección…» to CSV, far-apart
// rows (5 and 5000, with pages loaded in between), sorting resets it, and in a table tab Supr marks exactly the
// selected rows, which saving deletes by key. `--engines PostgreSQL,SQLite` narrows it; `--tear-off` also repeats the
// copy in a torn-off window (the first engine only).
//   node dev/grid-multiselect-check.mjs [--slot n] [--engines a,b] [--tear-off]
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { appPort, connect, sleep } from "./cdp-lib.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (opt("--slot")) process.env.CELER_SLOT = opt("--slot");
const port = appPort();
const ENGINES = (opt("--engines") ?? "PostgreSQL,MySQL,MariaDB,SQL Server,Informix DRDA,Informix JDBC,SQLite,ODBC (SQL Server)").split(",").map((s) => s.trim());
const out = resolve("review-out", "grid-multiselect");
mkdirSync(out, { recursive: true });

let app = await connect(port);
const js = (code) => app.js(code, { helpers: true });
let failed = 0;
const results = {};
let engine = "";
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${name}${ok ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`}`);
  if (!ok) {
    failed++;
    results[engine] = "FAIL";
  }
};
const CTRL = 2;
const SHIFT = 8;
async function press(key, mods = 0) {
  const named = { Escape: 27, Delete: 46, Enter: 13, ArrowDown: 40, F4: 115 };
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = named[key] ?? key.toUpperCase().charCodeAt(0);
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(120);
}
/** Geometry of the active grid: its box, the row height (from the sizer: header 30 px + rows) and the scroll. */
const grid = () =>
  js(`
    const g = pane().querySelector('.grid'); const sc = g.querySelector('.grid-scroll'); const sizer = g.querySelector('.grid-sizer');
    const r = g.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, sizerH: sizer.getBoundingClientRect().height, top: sc.scrollTop };
  `);
let rowH = 24;
/** Where screen row `row` (0-based) is: in the gutter (`col` -1) or in data column `col` (by x offset). */
async function rowPoint(row, col = 0) {
  const g = await grid();
  return { x: col < 0 ? g.x + 14 : g.x + 60 + col * 90, y: g.y + 30 + (row + 0.5) * rowH - g.top };
}
/** Clicks screen row `row`, with modifiers (CTRL, SHIFT). */
async function clickRow(row, { col = 0, mods = 0 } = {}) {
  const { x, y } = await rowPoint(row, col);
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: mods });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: mods });
  await sleep(150);
  return { x, y };
}
/** Opens the grid's context menu at a point (the selection is left as it is). */
const gridMenu = (at) => js(`pane().querySelector('.grid').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${at.x}, clientY: ${at.y} }));`);
const copied = async (mods = CTRL) => {
  await js(`window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; };`);
  await press("c", mods);
  return js(`await until(() => window.__copied !== null, 3000); return window.__copied;`);
};
const stats = () => js(`return txt(document.querySelector('.statusbar .stats')) ?? '';`);
const ids = (text) => text.split("\n").filter(Boolean).map((line) => line.split("\t")[0]);

const results0 = await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000); return (await invoke('list_connections')).map((c) => c.name);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await press("Escape");

for (const [index, name] of ENGINES.entries()) {
  engine = name;
  if (!results0.includes(name)) {
    console.log(`skip [${name}] no connection with that name in this data folder`);
    results[name] = "not tested (no connection)";
    continue;
  }
  results[name] = "ok";
  const table = `gms_${index}`;
  try {
    // ------------------------------------------------ test data: 12 rows, id 1…12, n = id * 10
    await js(`
      try { await sql(${JSON.stringify(name)}, "DROP TABLE ${table}"); } catch {}
      await sql(${JSON.stringify(name)}, "CREATE TABLE ${table} (id INT NOT NULL PRIMARY KEY, name VARCHAR(20), n INT)");
      for (let i = 1; i <= 12; i++) await sql(${JSON.stringify(name)}, "INSERT INTO ${table} (id, name, n) VALUES (" + i + ", 'r" + i + "', " + i * 10 + ")");
    `);
    check("console opens", await js(`return await newConsole(${JSON.stringify(name)});`));
    await js(`await runSql("SELECT id, name, n FROM ${table} ORDER BY id");`);
    const g = await grid();
    rowH = Math.round((g.sizerH - 30) / 12);

    // ------------------------------------------------ Ctrl+click rows 2, 5 and 9 (one on the row number)
    await clickRow(1, { col: 1 });
    await clickRow(4, { col: 0, mods: CTRL });
    await clickRow(8, { col: -1, mods: CTRL });
    let text = await copied();
    check("Ctrl+click: rows 2, 5 and 9 copied, in screen order", JSON.stringify(ids(text)) === '["2","5","9"]' && text.split("\n")[1] === "5\tr5\t50", text);
    const st = await stats();
    check("status bar: 3 rows, 9 cells, Σ over only those rows", /3 filas/.test(st) && /9 celdas/.test(st) && /Σ 176\b/.test(st), st);
    text = await copied(CTRL | SHIFT);
    check("Ctrl+Shift+C adds the headers", text.split("\n")[0] === "id\tname\tn" && JSON.stringify(ids(text).slice(1)) === '["2","5","9"]', text);
    await app.send("Page.captureScreenshot", { format: "png" }).then(({ data }) => import("node:fs").then((fs) => fs.writeFileSync(resolve(out, `${table}-${name.replace(/\W+/g, "_")}.png`), Buffer.from(data, "base64"))));
    // «Copiar como › JSON» from the menu of a selected row: the same three rows.
    await js(`window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; };`);
    const at = await rowPoint(4, 0);
    await gridMenu(at);
    await js(`await menuPath(/^Copiar como/, /^JSON$/);`);
    const json = await js(`await until(() => window.__copied !== null, 3000); return window.__copied;`);
    check("«Copiar como › JSON»: exactly the selected rows", JSON.stringify(JSON.parse(json ?? "[]").map((r) => Number(r.id))) === "[2,5,9]", json);

    // ------------------------------------------------ export the selection to CSV
    const csvPath = resolve(out, `${table}.csv`);
    await gridMenu(at);
    const exported = await js(`
      if (!(await menuPath(/^Exportar selección \\(3 filas\\)/))) return 'no menu item';
      await until(() => dialog(), 3000);
      button(/^CSV$/, dialog())?.click();
      window.__celerNextSavePath = ${JSON.stringify(csvPath)};
      button(/exportar/i, dialog().querySelector('footer'))?.click();
      await until(() => !dialog(), 8000);
      await sleep(300);
      return (await invoke('read_text_file', { path: ${JSON.stringify(csvPath)} })).text;
    `);
    const csvIds = String(exported).replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).slice(1).map((l) => l.split(/[;,]/)[0]);
    check("«Exportar selección…» writes exactly rows 2, 5 and 9", JSON.stringify(csvIds) === '["2","5","9"]', exported);

    // ------------------------------------------------ Shift and Ctrl+Shift ranges, Esc
    await clickRow(10, { col: 1, mods: SHIFT });
    check("Shift+click: the rows from the last clicked one (9…11) alone", JSON.stringify(ids(await copied())) === '["9","10","11"]');
    await clickRow(0, { col: 1, mods: CTRL });
    await clickRow(2, { col: 1, mods: CTRL | SHIFT });
    check("Ctrl+Shift+click adds a range (1…3 with 9…11)", JSON.stringify(ids(await copied())) === '["1","2","3","9","10","11"]');
    await press("Escape");
    text = await copied();
    check("Esc: back to the single cell", text === "r3" && !(await stats()), { text, stats: await stats() });
    await clickRow(5, { col: 1 });
    check("a plain click selects one cell", (await copied()) === "r6");
    // Keyboard navigation goes on from a picked row.
    await clickRow(3, { col: 1, mods: CTRL });
    await press("ArrowDown");
    check("an arrow after Ctrl+click moves on from the clicked cell, single again", (await copied()) === "r5");

    // ------------------------------------------------ sorting resets a multiple selection
    await clickRow(1, { col: 1 });
    await clickRow(6, { col: 1, mods: CTRL });
    // The header menu of the first column: «Orden descendente».
    const head = await grid();
    await gridMenu({ x: head.x + 60, y: head.y + 12 });
    // The grid takes the focus back (a closed context menu leaves it on the page: a separate, older behaviour).
    await js(`await menuPath(/^Orden descendente/); await sleep(400); pane().querySelector('.grid').focus();`);
    text = await copied();
    check("a sort ends the picked rows (one cell left)", text.split("\n").length === 1, text);

    // ------------------------------------------------ far-apart rows: 5 and 5000 (pages loaded in between)
    await js(`await runSql("SELECT a.id AS a, b.id AS b, c.id AS c, d.id AS d FROM ${table} a, ${table} b, ${table} c, ${table} d ORDER BY a.id, b.id, c.id, d.id");`);
    await clickRow(4, { col: 0 });
    await js(`
      const sc = pane().querySelector('.grid-scroll');
      for (let i = 0; i < 40 && sc.scrollHeight < 30 + 5100 * ${rowH}; i++) { sc.scrollTop = sc.scrollHeight; await sleep(400); }
      sc.scrollTop = 30 + 4999 * ${rowH} - 200; await sleep(300);
    `);
    await clickRow(4999, { col: 0, mods: CTRL });
    await js(`pane().querySelector('.grid-scroll').scrollTop = 0; await sleep(200);`);
    text = await copied();
    // Row k (1-based) of the 4-way cross join in order: a, b, c, d from (k-1) in base 12.
    const rowOf = (k) => [Math.floor((k - 1) / 1728), Math.floor((k - 1) / 144) % 12, Math.floor((k - 1) / 12) % 12, (k - 1) % 12].map((v) => String(v + 1)).join("\t");
    check("rows 5 and 5000 stay selected across scrolling and loading", text === `${rowOf(5)}\n${rowOf(5000)}`, { text, want: `${rowOf(5)}\n${rowOf(5000)}` });

    // ------------------------------------------------ a table tab: Supr marks exactly the selected rows; saving deletes them by key
    // A small query read to its end first: SQLite keeps the cross join's read cursor open while it is partly fetched,
    // and every write from another tab then fails with «database is locked» (a separate, older behaviour).
    await js(`await runSql("SELECT id FROM ${table} ORDER BY id");`);
    await js(`
      setSql("SELECT * FROM ${table}");
      const v = view(); v.focus(); v.dispatch({ selection: { anchor: 16 } });
    `);
    await press("F4");
    let opened = await js(`return !!(await until(() => /${table}/i.test(document.querySelector('.tab.on')?.textContent ?? '') && pane().querySelector('.tb-btn.submit'), 6000));`);
    if (!opened) {
      // The catalogue may not know the new table yet: refresh the connection, then again.
      await js(`await menu(${JSON.stringify(name)}, /^Actualizar/); await sleep(1500); document.querySelector('.tab.on') && [...document.querySelectorAll('.tab')].find((t) => /consola|query|SQL/i.test(t.textContent))?.click();`);
      await js(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: 16 } });`);
      await press("F4");
      opened = await js(`return !!(await until(() => /${table}/i.test(document.querySelector('.tab.on')?.textContent ?? '') && pane().querySelector('.tb-btn.submit'), 8000));`);
    }
    check("the table opens in a table tab", opened);
    if (opened) {
      await js(`await until(() => pane().querySelector('.grid-canvas'), 5000); await sleep(800);`);
      const tg = await grid();
      rowH = Math.round((tg.sizerH - 30) / 12) || rowH;
      await clickRow(1, { col: 1 });
      await clickRow(4, { col: 1, mods: CTRL });
      await clickRow(8, { col: -1, mods: CTRL });
      await press("Delete");
      const pending = await js(`return txt(pane().querySelector('.tb-btn.submit'));`);
      check("Supr marks the 3 selected rows (pending until saved)", /\(3\)/.test(pending ?? ""), pending);
      await js(`
        pane().querySelector('.tb-btn.submit').click();
        const run = await until(() => [...document.querySelectorAll('.dialog button.primary')].find((b) => /Ejecutar|Guardar|Aplicar/.test(b.textContent)), 5000);
        run?.click();
        await until(() => !document.querySelector('.dialog') && !/\\(\\d+\\)/.test(pane().querySelector('.tb-btn.submit')?.textContent ?? ''), 15000);
        await sleep(500);
      `);
      const left = await js(`return (await sql(${JSON.stringify(name)}, "SELECT id FROM ${table} ORDER BY id")).results[0].rows.map((r) => Number(r[0]));`);
      check("saving deleted exactly rows 2, 5 and 9 (by key)", JSON.stringify(left) === "[1,3,4,6,7,8,10,11,12]", left);
      await js(`closeActive(); await sleep(300); const d = dialog(); if (d) { button(/No guardar|Descartar|Cerrar/, d)?.click(); await sleep(300); }`);
    }

    // ------------------------------------------------ a torn-off window (first engine only, with --tear-off)
    if (args.includes("--tear-off") && index === 0) {
      await js(`await runSql("SELECT id, name, n FROM ${table} ORDER BY id");`);
      await js(`await tabMenu(/^Abrir en ventana nueva/);`);
      const main = app;
      app = await connect(port, { window: /^(?!main$)/, timeout: 15000 });
      await js(`await until(() => pane()?.querySelector('.grid-canvas'), 10000); await sleep(800);`);
      const wg = await grid();
      rowH = Math.round((wg.sizerH - 30) / 9) || rowH;
      await clickRow(0, { col: 1 });
      await clickRow(2, { col: 1, mods: CTRL });
      check("torn-off window: Ctrl+click and copy", JSON.stringify(ids(await copied())) === '["1","4"]');
      app.close?.();
      app = main;
    }
  } catch (err) {
    check("ran to the end", false, err.message);
  } finally {
    await js(`try { await sql(${JSON.stringify(name)}, "DROP TABLE ${table}"); } catch {} for (let i = 0; i < 4 && document.querySelector('.tab.on'); i++) { closeActive(); await sleep(250); const d = dialog(); if (d) { button(/No guardar|Descartar|Cerrar/, d)?.click(); await sleep(250); } }`).catch(() => {});
  }
}

console.log("\nper engine:");
for (const [name, result] of Object.entries(results)) console.log(`  ${name}: ${result}`);
app.close?.();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("grid-multiselect-check: all good");
