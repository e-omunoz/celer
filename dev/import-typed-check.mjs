// Excel import with typed values (#120), in the desktop app (dev/run-desktop.ps1), on every connection named in
// CONNS (comma-separated, as in the explorer; default "Postgres local"): a table import_tipos is created, the
// workbook dev/fixtures/import/tipos.xlsx imported into it from the table tab (title rows skipped, header found in
// row 3 from column B, a range B3:G6), then a block pasted from Excel (Spanish formats) and a block pasted into the
// table viewer. Dates, decimals, booleans, timestamps and NULLs are read back from the server.
// Usage: CONNS="Postgres local,MySQL,MariaDB,SQL Server,Informix DRDA,Informix JDBC,SQLite,ODBC pg" node dev/import-typed-check.mjs
import { resolve } from "node:path";
import { connect, sleep } from "./cdp-lib.mjs";

const CONNS = (process.env.CONNS || "Postgres local").split(",").map((s) => s.trim()).filter(Boolean);
const fixture = resolve(import.meta.dirname, "fixtures", "import", "tipos.xlsx");
const app = await connect(process.env.CDP_PORT || 9333);
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const connRow = (name) => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.querySelector('.tree-name')?.textContent === name || e.textContent.includes(name));
  const menuItem = (re) => until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => re.test(b.textContent)), 4000);
  const pane = () => document.querySelector('.pane-host.active');
  const dlg = () => document.querySelector('.import-dialog');
  const conn = async (name) => (await inv('list_connections')).find((x) => x.name === name);
  const sql = async (name, text) => {
    const c = await conn(name);
    const s = await inv('open_session', { connId: c.id, password: null });
    try { return await inv('execute', { sessionId: s.sessionId, sql: text, fetch: 100 }); } finally { await inv('close_session', { sessionId: s.sessionId }); }
  };
  const paste = (el, text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
  const wizard = () => { const d = dlg(); return d && { file: d.querySelector('.import-file')?.textContent ?? '', header: d.querySelector('.import-header select')?.value ?? null, headerLabel: d.querySelector('.import-header select')?.selectedOptions[0]?.textContent ?? '', mapped: [...d.querySelectorAll('.import-map-row select')].map((s) => s.value), sample: [...d.querySelectorAll('.import-map-row code')].map((c) => c.textContent), button: d.querySelector('footer .btn.primary')?.textContent ?? '' }; };
`;
const js = (code) => app.js(H + code);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${String(detail).slice(0, 600)}`}`);
  if (!ok) failed++;
};
async function key(k, mods = 0) {
  const vk = { Enter: 13, Escape: 27 }[k] ?? k.toUpperCase().charCodeAt(0);
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
}

function ddl(kind) {
  const types = {
    postgres: ["boolean", "timestamp"],
    mysql: ["boolean", "datetime"],
    mssql: ["bit", "datetime2(0)"],
    informix: ["boolean", "datetime year to second"],
    sqlite: ["boolean", "timestamp"],
  }[kind] ?? ["boolean", "timestamp"];
  return [
    kind === "mssql" ? "IF OBJECT_ID('import_tipos') IS NOT NULL DROP TABLE import_tipos" : "DROP TABLE IF EXISTS import_tipos",
    `CREATE TABLE import_tipos (id int NOT NULL PRIMARY KEY, nombre varchar(60) NOT NULL, alta date, activo ${types[0]}, saldo decimal(10,2), momento ${types[1]})`,
  ];
}

/** A server value as plain text to compare (dates and booleans written differently by each engine). */
const norm = (v) => {
  if (v === null || v === undefined) return null;
  if (v === true || v === false) return String(v);
  const s = String(v).replace("T", " ").replace(/\.0+$/, "");
  if (/^(t|1)$/i.test(s)) return "true";
  if (/^(f|0)$/i.test(s)) return "false";
  if (/^-?\d+\.\d+$/.test(s)) return String(Number(s));
  return s;
};

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
if (await js(`return !!document.querySelector('.onboarding');`)) await key("Escape");

for (const name of CONNS) {
  const kind = await js(`return (await conn(${JSON.stringify(name)}))?.kind ?? null;`);
  if (!kind) {
    check(`${name}: connection exists`, false, "not found");
    continue;
  }
  const created = await js(`
    try { for (const s of ${JSON.stringify(ddl(kind))}) { try { await sql(${JSON.stringify(name)}, s); } catch (e) { if (!/^DROP|^IF/.test(s)) throw e; } } return 'ok'; } catch (e) { return String(e); }
  `);
  check(`${name} (${kind}): import_tipos created`, created === "ok", created);
  if (created !== "ok") continue;
  // Connected and refreshed, so «Ir a tabla» (Ctrl+N) finds the new table; its tab has the import button.
  const opened = await js(`
    const row = connRow(${JSON.stringify(name)});
    if (!row.classList.contains('connected')) { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => connRow(${JSON.stringify(name)}).classList.contains('connected'), 30000); }
    connRow(${JSON.stringify(name)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 }));
    (await menuItem(/^Actualizar/))?.click();
    await sleep(1500);
    return true;
  `);
  await key("n", 2);
  const tab = await js(`
    const input = await until(() => document.querySelector('.palette input'));
    input.value = 'import_tipos'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const item = await until(() => [...document.querySelectorAll('.palette .pal-item, .palette button')].find((b) => /import_tipos/i.test(b.textContent) && b.textContent.includes(${JSON.stringify(name)})), 10000);
    if (!item) return 'no palette item';
    item.click();
    await until(() => pane()?.querySelector('.grid-canvas') && [...pane().querySelectorAll('.tb-icon')].some((b) => /^Importar datos/.test(b.title)), 20000);
    return 'ok';
  `);
  check(`${name}: table tab opened`, opened && tab === "ok", tab);
  if (tab !== "ok") continue;

  // ---- the workbook: a title, a blank row, the header in row 3 from column B, typed cells
  const w = await js(`
    [...pane().querySelectorAll('.tb-icon')].find((b) => /^Importar datos/.test(b.title)).click();
    const zone = await until(() => dlg()?.querySelector('.drop-zone'));
    window.__celerNextOpenPath = ${JSON.stringify(fixture)};
    zone.click();
    await until(() => dlg()?.querySelector('.import-map') && /filas/.test(dlg().querySelector('.import-file')?.textContent ?? ''));
    await sleep(300);
    return wizard();
  `);
  check(`${name}: header found in row 3 (title rows skipped)`, w?.header === "2" && /detectada/.test(w.headerLabel), JSON.stringify(w));
  check(`${name}: 4 rows, 6 columns, all mapped by name`, /4 filas · 6 columnas/.test(w?.file ?? "") && w.mapped.join() === "0,1,2,3,4,5", JSON.stringify(w));
  check(`${name}: typed samples`, w?.sample.join("|") === "1|Ana Ruiz|2024-03-15|true|12.5|2024-03-15 10:20:00", JSON.stringify(w));
  const ranged = await js(`
    const input = dlg().querySelector('.import-range input');
    input.value = 'B3:G6'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => /3 filas/.test(dlg().querySelector('.import-file')?.textContent ?? ''));
    await sleep(200);
    return wizard();
  `);
  check(`${name}: range B3:G6 leaves 3 rows`, /3 filas · 6 columnas/.test(ranged?.file ?? "") && ranged.header === "2", JSON.stringify(ranged));
  const done = await js(`
    dlg().querySelector('footer .btn.primary').click();
    await until(() => !dlg(), 30000);
    await sleep(400);
    return !dlg();
  `);
  check(`${name}: imported`, done, "dialog still open");
  const back = await js(`return (await sql(${JSON.stringify(name)}, "SELECT id, nombre, alta, activo, saldo, momento FROM import_tipos ORDER BY id")).results[0].rows;`);
  const rows = (back ?? []).map((r) => r.map(norm));
  const want = [
    ["1", "Ana Ruiz", "2024-03-15", "true", "12.5", "2024-03-15 10:20:00"],
    ["2", "Luis Peña", "2023-01-02", "false", "0.1", null],
    ["3", "Marta Gil", null, null, "1234.56", null],
  ];
  check(`${name}: dates, decimals, booleans, timestamps and NULLs read back`, JSON.stringify(rows.map((r) => [String(r[0]), r[1], r[2] && r[2].slice(0, 10), r[3], r[4], r[5] && r[5].slice(0, 19)])) === JSON.stringify(want), JSON.stringify(back));

  // ---- a block pasted from Excel (Spanish formats) into the wizard
  await js(`await sql(${JSON.stringify(name)}, "DELETE FROM import_tipos");`);
  const p = await js(`
    [...pane().querySelectorAll('.tb-icon')].find((b) => /^Importar datos/.test(b.title)).click();
    await until(() => dlg()?.querySelector('.drop-zone'));
    paste(dlg().querySelector('.import-body'), "id\\tnombre\\talta\\tactivo\\tsaldo\\tmomento\\r\\n10\\tPegada Uno\\t05/03/2024\\tVERDADERO\\t1.234,50\\t05/03/2024 08:30:00\\r\\n11\\tPegada Dos\\t\\tFALSO\\t-0,75\\t\\r\\n");
    await until(() => /2 filas/.test(dlg()?.querySelector('.import-file')?.textContent ?? ''));
    await sleep(200);
    const w = wizard();
    dlg().querySelector('footer .btn.primary').click();
    await until(() => !dlg(), 30000);
    await sleep(300);
    return w;
  `);
  check(`${name}: pasted block: header found, 2 rows, mapped`, /Pegado del portapapeles/.test(p?.file ?? "") && /2 filas · 6 columnas/.test(p.file) && p.mapped.join() === "0,1,2,3,4,5", JSON.stringify(p));
  const pasted = await js(`return (await sql(${JSON.stringify(name)}, "SELECT id, alta, activo, saldo, momento FROM import_tipos ORDER BY id")).results[0].rows;`);
  const prow = (pasted ?? []).map((r) => r.map(norm));
  check(`${name}: pasted values typed (dd/mm/aaaa, 1.234,50, VERDADERO)`, JSON.stringify(prow.map((r) => [String(r[0]), r[1] && r[1].slice(0, 10), r[2], r[3], r[4] && r[4].slice(0, 19)])) === JSON.stringify([["10", "2024-03-05", "true", "1234.5", "2024-03-05 08:30:00"], ["11", null, "false", "-0.75", null]]), JSON.stringify(pasted));

  // ---- a block pasted into the table viewer: edits on the rows there, the rest as new rows (not saved)
  const grid = await js(`
    const reload = [...pane().querySelectorAll('.tb-icon, .tb-btn')].find((b) => /Recargar|Actualizar/.test(b.title || b.textContent));
    reload?.click();
    await sleep(1200);
    const g = pane().querySelector('.grid');
    const r = pane().querySelector('.grid-scroll').getBoundingClientRect();
    return { x: r.left, y: r.top };
  `);
  // Click the first data cell of "nombre" (second column) to make it the active cell.
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: grid.x + 110, y: grid.y + 30 + 12, button: "left", clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: grid.x + 110, y: grid.y + 30 + 12, button: "left", clickCount: 1 });
  const pending = await js(`
    paste(pane().querySelector('.grid'), "Cambiada\\t31/12/2024\\nNueva\\t01/01/2025\\nOtra\\t02/01/2025\\n");
    await sleep(400);
    return pane().querySelector('.tb-btn.submit')?.textContent.trim() ?? '';
  `);
  check(`${name}: paste into the grid: 2 rows edited and 1 new (pending)`, /\b(3|4|5|6)\b/.test(pending), pending);
  await js(`
    const discard = [...pane().querySelectorAll('.tb-btn, .tb-icon')].find((b) => /Descartar|Deshacer/.test(b.title || b.textContent));
    discard?.click();
    await sleep(300);
  `);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
app.close();
process.exit(failed ? 1 : 0);
