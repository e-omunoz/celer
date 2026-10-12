// The import wizard with an Excel workbook (choosing its sheet) and a JSON file, against "Postgres local" in
// the desktop app (dev/run-desktop.ps1). Files come from dev/fixtures/import (handed to the file picker).
import { resolve } from "node:path";
import { connect } from "./cdp-lib.mjs";

const app = await connect(process.env.CDP_PORT || 9333);
const fixtures = resolve(import.meta.dirname, "fixtures", "import");
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } return null; };
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const rowByText = (text) => [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name')?.textContent === text);
  const connRow = () => [...document.querySelectorAll('.tree-row.conn')].find((e) => e.textContent.includes('Postgres local'));
  const menuItem = (re) => until(() => [...document.querySelectorAll('.menu .menu-item')].find((b) => re.test(b.textContent)), 3000);
  const sql = async (text) => {
    const list = await inv('list_connections');
    const c = list.find((x) => x.name === 'Postgres local');
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

await js(`await until(() => document.querySelector('.app.ready') && !document.querySelector('.splash'), 20000);`);
await js(`
  await sql("DROP TABLE IF EXISTS import_check; CREATE TABLE import_check (id int PRIMARY KEY, nombre text NOT NULL, alta date, activo boolean, saldo numeric(10,2))");
  if (!connRow().classList.contains('connected')) { connRow().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await until(() => connRow().classList.contains('connected')); }
  await until(() => rowByText('events'));
  // Refresh the tree so the new table shows up.
  connRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 }));
  (await menuItem(/^Actualizar/))?.click();
  await until(() => rowByText('import_check'));
`);

async function openWizard(file) {
  return js(`
    document.querySelector('.dialog .btn:not(.primary)')?.click();
    await sleep(200);
    const row = rowByText('import_check');
    if (!row) return { error: 'no table row' };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }));
    (await menuItem(/^Importar datos/))?.click();
    const zone = await until(() => document.querySelector('.import-dialog .drop-zone'));
    if (!zone) return { error: 'no drop zone' };
    window.__celerNextOpenPath = ${JSON.stringify(file)};
    zone.click();
    await until(() => document.querySelector('.import-dialog .import-map'));
    await sleep(200);
    const d = document.querySelector('.import-dialog');
    return {
      file: d.querySelector('.import-file')?.textContent ?? '',
      sheets: [...d.querySelectorAll('.import-sheet option')].map((o) => o.textContent),
      header: !!d.querySelector('.import-opts input[type=checkbox]') && [...d.querySelectorAll('.import-opts label.check')].some((l) => /cabeceras/.test(l.textContent)),
      separator: !!d.querySelector('.import-opts .seg'),
      mapped: [...d.querySelectorAll('.import-map-row select')].map((s) => s.value),
      button: d.querySelector('footer .btn.primary')?.textContent ?? '',
    };
  `);
}

// ---------------------------------------------------------------- Excel: the data is on the second sheet
const xlsx = await openWizard(resolve(fixtures, "clientes.xlsx"));
check("workbook opens on its first sheet (a single note: data, not a header)", /clientes\.xlsx/.test(xlsx.file) && /1 fila · 1 columna(?!s)/.test(xlsx.file), JSON.stringify(xlsx));
check("nothing mapped from it", xlsx.mapped.every((m) => m === "-1"), JSON.stringify(xlsx));
check("sheet chooser lists both sheets", JSON.stringify(xlsx.sheets) === JSON.stringify(["Notas", "Clientes"]), JSON.stringify(xlsx));
check("no separator option for a workbook", !xlsx.separator, JSON.stringify(xlsx));
const second = await js(`
  const select = document.querySelector('.import-dialog .import-sheet select');
  select.value = 'Clientes';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => /3 filas/.test(document.querySelector('.import-dialog .import-file')?.textContent ?? ''));
  await sleep(150);
  const d = document.querySelector('.import-dialog');
  return { file: d.querySelector('.import-file').textContent, mapped: [...d.querySelectorAll('.import-map-row select')].map((s) => s.value), sample: [...d.querySelectorAll('.import-map-row code')].map((c) => c.textContent) };
`);
check("second sheet: 3 rows, every column mapped by name", /3 filas · 5 columnas/.test(second.file) && second.mapped.join() === "0,1,2,3,4", JSON.stringify(second));
check("samples show dates and booleans as text", second.sample.join("|") === "1|Ana Ruiz|2024-03-15|true|12.5", JSON.stringify(second));
await js(`
  document.querySelector('.import-dialog footer .btn.primary').click();
  await until(() => !document.querySelector('.import-dialog'), 15000);
  await sleep(300);
`);
const afterXlsx = await js(`const out = await sql("SELECT id, nombre, alta::text, activo, saldo::text FROM import_check ORDER BY id"); return out.results[0].rows;`);
check("rows imported from the sheet", JSON.stringify(afterXlsx) === JSON.stringify([[1, "Ana Ruiz", "2024-03-15", true, "12.50"], [2, "Luis Peña", "2023-03-15", false, null], [3, "Marta Gil", null, true, "-3.00"]]), JSON.stringify(afterXlsx));

// ---------------------------------------------------------------- JSON: {"data": [objects]}
const json = await openWizard(resolve(fixtures, "clientes.json"));
check("JSON objects: header from the keys, no header checkbox", !json.header && !json.separator && /3 filas · 5 columnas/.test(json.file), JSON.stringify(json));
check("JSON keys mapped by name", json.mapped.join() === "0,1,2,3,4", JSON.stringify(json));
await js(`
  document.querySelector('.import-dialog footer .btn.primary').click();
  await until(() => !document.querySelector('.import-dialog'), 15000);
  await sleep(300);
`);
const afterJson = await js(`const out = await sql("SELECT id, nombre, alta::text, activo, saldo::text FROM import_check WHERE id > 10 ORDER BY id"); return out.results[0].rows;`);
check("rows imported from JSON (null and missing keys as NULL)", JSON.stringify(afterJson) === JSON.stringify([[11, "Ana Ruiz", "2024-03-15", true, "12.50"], [12, "Luis Peña", null, false, null], [13, 'Marta "la jefa" Gil', "2023-01-02", true, "-3.00"]]), JSON.stringify(afterJson));

await js(`await sql("DROP TABLE IF EXISTS import_check");`);
app.close?.();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("import-e2e-check: all good");
